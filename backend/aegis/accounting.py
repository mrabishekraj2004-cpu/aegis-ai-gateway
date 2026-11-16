from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection

from aegis import models as db
from aegis.auth import still_authorized
from aegis.catalog import current_pricing, effective_budget, rates_for, utc_month
from aegis.contracts import Chat, Policy, Principal, RequestInfo, TokenUsage
from aegis.database import Database, lock_catalog, lock_tenant
from aegis.errors import GatewayError
from aegis.routing import Candidate, usage_components


@dataclass(frozen=True, slots=True)
class Authorized:
    tenant: UUID
    request: UUID
    attempt: UUID
    period: date
    candidate: Candidate


def accounting_unavailable() -> GatewayError:
    return GatewayError(503, "accounting_unavailable", "The spend ledger is temporarily unavailable.")


class Accounting:
    def __init__(self, database: Database) -> None:
        self.db = database

    async def admit(
        self,
        actor: Principal,
        info: RequestInfo,
        chat: Chat,
        policy: Policy,
        evidence: dict,
    ) -> None:
        async with self.db.transaction(actor.tenant_id) as connection:
            await connection.execute(
                sa.insert(db.requests).values(
                    tenant_id=actor.tenant_id,
                    id=info.request_id,
                    alias_id=policy.alias_id,
                    key_id=actor.actor_id if actor.kind == "key" else None,
                    user_id=actor.actor_id if actor.kind == "user" else None,
                    policy_version_id=policy.version_id,
                    catalog_revision=policy.catalog_revision,
                    received_at=info.received_at,
                    stream=chat.stream,
                    period_start=utc_month(info.received_at),
                    client_request_id=info.client_request_id,
                    route_evidence=evidence,
                )
            )

    async def reserve(
        self,
        actor: Principal,
        info: RequestInfo,
        policy: Policy,
        candidate: Candidate,
        ordinal: int,
    ) -> Authorized:
        tenant, deployment = actor.tenant_id, candidate.deployment
        month = utc_month(info.received_at)
        attempt = Authorized(tenant, info.request_id, uuid4(), month, candidate)
        async with self.db.transaction(tenant) as conn:
            await lock_catalog(conn)
            await lock_tenant(conn, tenant)
            permission = "chat:write" if actor.kind == "key" else "playground:run"
            if not await still_authorized(conn, actor, permission):
                raise GatewayError(
                    403, "insufficient_scope", "The credential can no longer authorize inference."
                )

            eligible = await conn.scalar(
                sa.select(sa.literal(True))
                .select_from(
                    db.deployments.join(db.providers, db.deployments.c.provider == db.providers.c.code)
                    .join(db.pricing_versions, db.pricing_versions.c.deployment_id == db.deployments.c.id)
                    .join(db.tenant_deployments, db.tenant_deployments.c.deployment_id == db.deployments.c.id)
                )
                .where(
                    db.deployments.c.id == deployment.id,
                    ~db.deployments.c.emergency_disabled,
                    db.providers.c.enabled,
                    db.tenant_deployments.c.tenant_id == tenant,
                    db.pricing_versions.c.version == deployment.price_version,
                    current_pricing(datetime.now(UTC)),
                )
            )
            if not eligible:
                raise GatewayError(503, "no_healthy_route", "The selected deployment is no longer eligible.")

            where_period = period_where(tenant, month)
            present = await conn.scalar(sa.select(db.budget_periods.c.budget_version).where(*where_period))
            if present is None:
                budget = await effective_budget(conn, tenant, month)
                if budget is None:
                    raise GatewayError(429, "budget_exceeded", "No budget policy authorizes this period.")
                await conn.execute(
                    insert(db.budget_periods)
                    .values(
                        tenant_id=tenant,
                        period_start=month,
                        budget_version=budget["version"],
                        hard_limit=budget["hard_limit"],
                    )
                    .on_conflict_do_nothing()
                )
            period = await lock_period(conn, tenant, month)
            request = await lock_request(conn, tenant, info.request_id)
            if request["state"] != "admitted":
                raise GatewayError(503, "accounting_unavailable", "The request is no longer admissible.")

            request_cap = policy.config.max_request_cost_microusd
            period_cap = period["hard_limit"]
            if period_cap is not None or request_cap is not None:
                quarantined = await conn.scalar(
                    sa.select(db.billing_quarantine.c.deployment_id).where(
                        db.billing_quarantine.c.deployment_id == deployment.id,
                        db.billing_quarantine.c.price_version == deployment.price_version,
                    )
                )
                if not deployment.certified or quarantined:
                    raise GatewayError(
                        403, "request_cost_limit_exceeded", "The rate card lacks an approved bound."
                    )

            if request_cap is not None:
                previous_exposure = await conn.scalar(
                    sa.select(
                        sa.func.coalesce(
                            sa.func.sum(
                                sa.case(
                                    (db.attempts.c.state.in_(("authorized", "pending")), db.attempts.c.hold),
                                    else_=db.attempts.c.charged,
                                )
                            ),
                            0,
                        )
                    ).where(db.attempts.c.tenant_id == tenant, db.attempts.c.request_id == attempt.request)
                )
                if previous_exposure + candidate.hold > int(request_cap):
                    raise GatewayError(
                        403, "request_cost_limit_exceeded", "The request spend ceiling was reached."
                    )
            exposure = period["spent"] + period["reserved"] + candidate.hold
            if period_cap is not None and exposure > period_cap:
                raise GatewayError(429, "budget_exceeded", "The tenant period budget was reached.")
            now = datetime.now(UTC)
            await conn.execute(
                sa.insert(db.attempts).values(
                    tenant_id=tenant,
                    id=attempt.attempt,
                    request_id=attempt.request,
                    ordinal=ordinal,
                    deployment_id=deployment.id,
                    deployment_version=deployment.version,
                    price_version=deployment.price_version,
                    period_start=month,
                    authorized_at=now,
                    lease_expires_at=now + timedelta(seconds=120),
                    settle_after=now + timedelta(hours=24),
                    state="authorized",
                    hold=candidate.hold,
                )
            )
            await add_ledger(conn, tenant, month, attempt.attempt, "reserve", "reserve", candidate.hold, 0)
            await conn.execute(
                sa.update(db.budget_periods)
                .where(*where_period)
                .values(
                    reserved=period["reserved"] + candidate.hold,
                )
            )
            await warn_thresholds(conn, tenant, month, period, exposure)
        return attempt

    async def outcome(
        self,
        attempt: Authorized,
        *,
        success: bool,
        reason: str,
        usage: TokenUsage | None = None,
        unsent: bool = False,
    ) -> bool:
        amounts = usage_components(usage, attempt.candidate.deployment.rates) if usage is not None else {}
        charge = sum(amount for _, amount in amounts.values())
        overage = attempt.candidate.deployment.certified and charge > attempt.candidate.hold
        async with self.db.transaction(attempt.tenant) as conn:
            if overage:
                await lock_catalog(conn, exclusive=True)
            period = await lock_period(conn, attempt.tenant, attempt.period)
            await lock_request(conn, attempt.tenant, attempt.request)
            current = await lock_attempt(conn, attempt.tenant, attempt.attempt)
            if current["state"] != "authorized" or current["lease_expires_at"] <= datetime.now(UTC):
                raise accounting_unavailable()
            if usage is not None or unsent:
                await finalize_attempt(
                    conn,
                    current,
                    period,
                    "reported" if usage is not None else "confirmed_nonbillable",
                    reason,
                    charge,
                    usage,
                    amounts,
                )
            else:
                await conn.execute(
                    sa.update(db.attempts)
                    .where(*attempt_where(attempt.tenant, attempt.attempt))
                    .values(state="pending", reason=reason, terminal_at=datetime.now(UTC))
                )
            if overage:
                await conn.execute(
                    insert(db.billing_quarantine)
                    .values(deployment_id=current["deployment_id"], price_version=current["price_version"])
                    .on_conflict_do_nothing()
                )
            if success:
                await conn.execute(
                    sa.update(db.requests)
                    .where(*request_where(attempt.tenant, attempt.request))
                    .values(state="succeeded", reason=reason)
                )
        return overage

    async def mark_request(
        self,
        tenant: UUID,
        request: UUID,
        *,
        state: str | None = None,
        reason: str | None = None,
        delivery: str | None = None,
    ) -> None:
        async with self.db.transaction(tenant) as conn:
            if state:
                await conn.execute(
                    sa.update(db.requests)
                    .where(*request_where(tenant, request), db.requests.c.state == "admitted")
                    .values(state=state, reason=reason)
                )
            if delivery:
                await conn.execute(
                    sa.update(db.requests)
                    .where(*request_where(tenant, request))
                    .values(
                        delivery=delivery,
                    )
                )

    async def reconcile(self, batch_size: int = 50) -> int:
        async with self.db.transaction() as conn:
            rows = (
                (
                    await conn.execute(
                        sa.text("SELECT * FROM aegis.recovery_candidates(:batch_size)"),
                        {"batch_size": batch_size},
                    )
                )
                .mappings()
                .all()
            )
        changed = 0
        for row in rows:
            tenant, month = row["tenant_id"], row["period_start"]
            async with self.db.transaction(tenant) as conn:
                period = await lock_period(conn, tenant, month)
                await lock_request(conn, tenant, row["request_id"])
                attempt = await lock_attempt(conn, tenant, row["attempt_id"])
                now = datetime.now(UTC)
                if attempt["state"] == "authorized" and attempt["lease_expires_at"] <= now:
                    await conn.execute(
                        sa.update(db.attempts)
                        .where(*attempt_where(tenant, attempt["id"]))
                        .values(state="pending", reason="dispatch_uncertain", terminal_at=now)
                    )
                    await conn.execute(
                        sa.update(db.requests)
                        .where(*request_where(tenant, row["request_id"]), db.requests.c.state == "admitted")
                        .values(state="failed", reason="dispatch_uncertain")
                    )
                    changed += 1
                elif attempt["state"] == "pending" and attempt["settle_after"] <= now:
                    await finalize_attempt(
                        conn,
                        attempt,
                        period,
                        "estimated",
                        attempt["reason"] or "usage_unavailable",
                        attempt["hold"],
                        None,
                        {},
                    )
                    changed += 1
        return changed

    async def adjust(
        self,
        tenant: UUID,
        attempt_id: UUID,
        adjustment_id: UUID,
        usage: TokenUsage,
        reason: str,
        actor: str,
    ) -> bool:
        async with self.db.transaction(tenant) as conn:
            await lock_catalog(conn, exclusive=True)
            original = (
                (await conn.execute(sa.select(db.attempts).where(*attempt_where(tenant, attempt_id))))
                .mappings()
                .one_or_none()
            )
            if not original:
                raise GatewayError(404, "resource_not_found", "The attempt does not exist.")
            period = await lock_period(conn, tenant, original["period_start"])
            await lock_request(conn, tenant, original["request_id"])
            attempt = await lock_attempt(conn, tenant, attempt_id)
            key = f"adjust:{adjustment_id}"
            seen = await conn.scalar(
                sa.select(db.ledger.c.id).where(
                    db.ledger.c.tenant_id == tenant,
                    db.ledger.c.attempt_id == attempt_id,
                    db.ledger.c.event_key == key,
                )
            )
            if seen:
                return False
            if attempt["state"] not in {"pending", "estimated", "reported", "adjusted"}:
                raise GatewayError(409, "invalid_request", "The attempt cannot be adjusted.")
            rates = await rates_for(conn, attempt["deployment_id"], attempt["price_version"])
            amounts = usage_components(usage, rates)
            charge = sum(amount for _, amount in amounts.values())
            reserved = attempt["hold"] if attempt["state"] == "pending" else 0
            delta = charge - attempt["charged"]
            await add_ledger(
                conn,
                tenant,
                attempt["period_start"],
                attempt_id,
                key,
                "settle" if reserved or attempt["state"] == "pending" else "adjust",
                -reserved,
                delta,
            )
            await conn.execute(
                sa.update(db.budget_periods)
                .where(*period_where(tenant, attempt["period_start"]))
                .values(spent=period["spent"] + delta, reserved=period["reserved"] - reserved)
            )
            await conn.execute(
                sa.update(db.attempts)
                .where(*attempt_where(tenant, attempt_id))
                .values(
                    state="adjusted",
                    charged=charge,
                    terminal_at=datetime.now(UTC),
                )
            )
            await store_usage(conn, tenant, attempt_id, usage, amounts, updating=True)
            await warn_thresholds(
                conn,
                tenant,
                attempt["period_start"],
                period,
                period["spent"] + period["reserved"] + delta - reserved,
            )
            certified = await conn.scalar(
                sa.select(db.pricing_versions.c.certified).where(
                    db.pricing_versions.c.deployment_id == attempt["deployment_id"],
                    db.pricing_versions.c.version == attempt["price_version"],
                )
            )
            if certified and charge > attempt["hold"]:
                await conn.execute(
                    insert(db.billing_quarantine)
                    .values(
                        deployment_id=attempt["deployment_id"],
                        price_version=attempt["price_version"],
                    )
                    .on_conflict_do_nothing()
                )
            await conn.execute(
                sa.insert(db.audit).values(
                    tenant_id=tenant,
                    id=uuid4(),
                    actor=actor,
                    action="usage.adjust",
                    resource=str(attempt_id),
                    reason=reason,
                    details={"adjustment": str(adjustment_id), "delta": delta},
                )
            )
        return True


def period_where(tenant: UUID, month: date) -> tuple:
    return db.budget_periods.c.tenant_id == tenant, db.budget_periods.c.period_start == month


def request_where(tenant: UUID, request: UUID) -> tuple:
    return db.requests.c.tenant_id == tenant, db.requests.c.id == request


def attempt_where(tenant: UUID, attempt: UUID) -> tuple:
    return db.attempts.c.tenant_id == tenant, db.attempts.c.id == attempt


async def lock_period(conn: AsyncConnection, tenant: UUID, month: date):
    return (
        (
            await conn.execute(
                sa.select(db.budget_periods).where(*period_where(tenant, month)).with_for_update()
            )
        )
        .mappings()
        .one()
    )


async def lock_request(conn: AsyncConnection, tenant: UUID, request: UUID):
    return (
        (await conn.execute(sa.select(db.requests).where(*request_where(tenant, request)).with_for_update()))
        .mappings()
        .one()
    )


async def lock_attempt(conn: AsyncConnection, tenant: UUID, attempt: UUID):
    return (
        (await conn.execute(sa.select(db.attempts).where(*attempt_where(tenant, attempt)).with_for_update()))
        .mappings()
        .one()
    )


async def add_ledger(
    conn: AsyncConnection,
    tenant: UUID,
    month: date,
    attempt: UUID,
    key: str,
    kind: str,
    hold: int,
    spend: int,
) -> None:
    await conn.execute(
        sa.insert(db.ledger).values(
            tenant_id=tenant,
            id=uuid4(),
            attempt_id=attempt,
            period_start=month,
            event_key=key,
            kind=kind,
            hold_delta=hold,
            spend_delta=spend,
        )
    )


async def warn_thresholds(conn: AsyncConnection, tenant: UUID, month: date, period, exposure: int) -> None:
    cap = period["hard_limit"]
    if cap is None or cap == 0 or exposure <= 0:
        return
    thresholds = await conn.scalar(
        sa.select(db.budget_policies.c.thresholds).where(
            db.budget_policies.c.tenant_id == tenant,
            db.budget_policies.c.version == period["budget_version"],
        )
    )
    crossed = [
        {"tenant_id": tenant, "period_start": month, "threshold": threshold}
        for threshold in thresholds
        if exposure * 100 >= threshold * cap
    ]
    if crossed:
        await conn.execute(insert(db.budget_alerts).values(crossed).on_conflict_do_nothing())


async def store_usage(
    conn: AsyncConnection,
    tenant: UUID,
    attempt_id: UUID,
    usage: TokenUsage | None,
    amounts: dict[str, tuple[int, int]],
    *,
    updating: bool = False,
) -> None:
    observed = {
        "prompt_tokens": usage.prompt_tokens if usage else None,
        "completion_tokens": usage.completion_tokens if usage else None,
        "updated_at": datetime.now(UTC),
    }
    stmt = insert(db.usage).values(tenant_id=tenant, attempt_id=attempt_id, **observed)
    if updating:
        stmt = stmt.on_conflict_do_update(index_elements=["tenant_id", "attempt_id"], set_=observed)
    await conn.execute(stmt)
    if amounts:
        rows = [
            {"tenant_id": tenant, "attempt_id": attempt_id, "unit": unit, "tokens": tokens, "charge": amount}
            for unit, (tokens, amount) in amounts.items()
        ]
        stmt = insert(db.usage_components).values(rows)
        if updating:
            stmt = stmt.on_conflict_do_update(
                index_elements=["tenant_id", "attempt_id", "unit"],
                set_={"tokens": stmt.excluded.tokens, "charge": stmt.excluded.charge},
            )
        await conn.execute(stmt)


async def finalize_attempt(
    conn: AsyncConnection,
    attempt,
    period,
    state: str,
    reason: str,
    charge: int,
    usage: TokenUsage | None,
    amounts: dict[str, tuple[int, int]],
) -> None:
    tenant, month, identity = attempt["tenant_id"], attempt["period_start"], attempt["id"]
    await add_ledger(conn, tenant, month, identity, "settle", "settle", -attempt["hold"], charge)
    await conn.execute(
        sa.update(db.budget_periods)
        .where(*period_where(tenant, month))
        .values(
            spent=period["spent"] + charge,
            reserved=period["reserved"] - attempt["hold"],
        )
    )
    await conn.execute(
        sa.update(db.attempts)
        .where(*attempt_where(tenant, identity))
        .values(
            state=state,
            charged=charge,
            reason=reason,
            terminal_at=datetime.now(UTC),
        )
    )
    await store_usage(conn, tenant, identity, usage, amounts)
    await warn_thresholds(
        conn, tenant, month, period, period["spent"] + period["reserved"] - attempt["hold"] + charge
    )
