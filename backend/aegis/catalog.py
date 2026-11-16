from datetime import UTC, datetime
from uuid import UUID, uuid4

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection

from aegis import models as db
from aegis.auth import still_authorized
from aegis.contracts import (
    ActivePolicyChange,
    Deployment,
    DisabledPolicyChange,
    ModelEntry,
    Policy,
    PolicyConfig,
    Principal,
)
from aegis.database import Database, lock_catalog, lock_tenant
from aegis.errors import GatewayError

PolicyChange = ActivePolicyChange | DisabledPolicyChange


def not_found() -> GatewayError:
    return GatewayError(404, "model_not_found", "The requested model alias is unavailable.")


def current_pricing(at: datetime) -> sa.ColumnElement:
    return sa.and_(
        db.pricing_versions.c.valid_from <= at,
        sa.or_(db.pricing_versions.c.valid_until.is_(None), at < db.pricing_versions.c.valid_until),
    )


def utc_month(at: datetime):
    return at.astimezone(UTC).date().replace(day=1)


async def effective_budget(conn: AsyncConnection, tenant: UUID, period) -> sa.RowMapping | None:
    return (
        (
            await conn.execute(
                sa.select(db.budget_policies)
                .where(
                    db.budget_policies.c.tenant_id == tenant, db.budget_policies.c.effective_month <= period
                )
                .order_by(db.budget_policies.c.effective_month.desc())
                .limit(1)
            )
        )
        .mappings()
        .one_or_none()
    )


async def eligible_deployments(
    conn: AsyncConnection,
    tenant: UUID,
    alias: UUID,
    revision: int,
    at: datetime,
    targets: set[UUID],
) -> list[Deployment]:
    versions, pricing, catalog, stable = (
        db.deployment_versions.c,
        db.pricing_versions.c,
        db.catalog_items.c,
        db.deployments.c,
    )
    stmt = (
        sa.select(
            stable.id.label("id"),
            stable.provider,
            stable.name,
            versions.version,
            versions.upstream_model,
            versions.region,
            db.models.c.quality,
            versions.context_limit,
            versions.output_limit,
            versions.capabilities,
            pricing.version.label("price_version"),
            pricing.certified,
            versions.credential_ref,
            versions.credential_revision,
            versions.quota_group,
            versions.stream_baseline_ms,
            versions.json_baseline_ms,
            versions.bound_overhead,
        )
        .select_from(
            db.catalog_items.join(db.deployments, catalog.deployment_id == stable.id)
            .join(db.providers, stable.provider == db.providers.c.code)
            .join(db.models, stable.model_id == db.models.c.id)
            .join(
                db.deployment_versions,
                sa.and_(
                    catalog.deployment_id == versions.deployment_id,
                    catalog.deployment_version == versions.version,
                ),
            )
            .join(
                db.pricing_versions,
                sa.and_(
                    catalog.deployment_id == pricing.deployment_id, catalog.price_version == pricing.version
                ),
            )
            .join(db.alias_deployments, db.alias_deployments.c.deployment_id == stable.id)
            .join(db.tenant_deployments, db.tenant_deployments.c.deployment_id == stable.id)
        )
        .where(
            catalog.catalog_revision == revision,
            stable.id.in_(targets),
            ~stable.emergency_disabled,
            db.providers.c.enabled,
            db.alias_deployments.c.alias_id == alias,
            db.tenant_deployments.c.tenant_id == tenant,
            current_pricing(at),
        )
    )
    rows = (await conn.execute(stmt)).mappings().all()
    result = []
    for row in rows:
        rates = await rates_for(conn, row["id"], row["price_version"])
        if rates.keys() != {"input", "output", "cache_read", "cache_write"}:
            continue
        data = dict(row)
        data["capabilities"] = frozenset(row["capabilities"])
        data["rates"] = rates
        result.append(Deployment(**data))
    return result


async def rates_for(conn: AsyncConnection, deployment: UUID, version: int) -> dict[str, int]:
    rows = (
        await conn.execute(
            sa.select(db.pricing_rates.c.unit, db.pricing_rates.c.per_million).where(
                db.pricing_rates.c.deployment_id == deployment, db.pricing_rates.c.price_version == version
            )
        )
    ).all()
    return dict(rows)


async def policy_config(conn: AsyncConnection, tenant: UUID, policy_id: UUID, config: dict) -> PolicyConfig:
    targets = (
        (
            await conn.execute(
                sa.select(
                    db.policy_targets.c.deployment_id,
                    db.policy_targets.c.priority,
                    db.policy_targets.c.weight,
                )
                .where(db.policy_targets.c.tenant_id == tenant, db.policy_targets.c.version_id == policy_id)
                .order_by(db.policy_targets.c.deployment_id)
            )
        )
        .mappings()
        .all()
    )
    edges = (
        (
            await conn.execute(
                sa.select(db.policy_edges.c.source, db.policy_edges.c.target)
                .where(db.policy_edges.c.tenant_id == tenant, db.policy_edges.c.version_id == policy_id)
                .order_by(db.policy_edges.c.source, db.policy_edges.c.target)
            )
        )
        .mappings()
        .all()
    )
    return PolicyConfig.model_validate(
        {**config, "targets": [dict(x) for x in targets], "fallback_edges": [dict(x) for x in edges]}
    )


class Catalog:
    def __init__(self, database: Database) -> None:
        self.db = database

    async def list_models(self, tenant: UUID) -> list[ModelEntry]:
        async with self.db.transaction(tenant) as conn:
            rows = (
                await conn.execute(
                    sa.select(db.aliases.c.code, db.aliases.c.created_at)
                    .join(db.routing_policies, db.routing_policies.c.alias_id == db.aliases.c.id)
                    .where(
                        db.routing_policies.c.tenant_id == tenant,
                        db.routing_policies.c.active_revision.is_not(None),
                    )
                    .order_by(db.aliases.c.code)
                    .limit(100)
                )
            ).all()
        return [ModelEntry(id=code, created=int(created.timestamp())) for code, created in rows]

    async def active(self, tenant: UUID, alias: str, at: datetime) -> Policy:
        rp, pv = db.routing_policies.c, db.policy_versions.c
        async with self.db.transaction(tenant) as conn:
            row = (
                (
                    await conn.execute(
                        sa.select(
                            rp.id,
                            rp.alias_id,
                            pv.id.label("version_id"),
                            pv.revision,
                            pv.config,
                            db.catalog_current.c.revision.label("catalog_revision"),
                        )
                        .select_from(
                            db.routing_policies.join(db.aliases, db.aliases.c.id == rp.alias_id)
                            .join(
                                db.policy_versions,
                                sa.and_(
                                    rp.tenant_id == pv.tenant_id,
                                    rp.id == pv.policy_id,
                                    rp.active_revision == pv.revision,
                                ),
                            )
                            .join(db.catalog_current, sa.true())
                        )
                        .where(rp.tenant_id == tenant, db.aliases.c.code == alias)
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                raise not_found()
            config = await policy_config(conn, tenant, row["version_id"], row["config"])
            deployments = await eligible_deployments(
                conn,
                tenant,
                row["alias_id"],
                row["catalog_revision"],
                at,
                {target.deployment_id for target in config.targets},
            )
            period = utc_month(at)
            period_row = (
                await conn.execute(
                    sa.select(db.budget_periods.c.hard_limit).where(
                        db.budget_periods.c.tenant_id == tenant, db.budget_periods.c.period_start == period
                    )
                )
            ).one_or_none()
            budget = await effective_budget(conn, tenant, period) if period_row is None else None
        cap = period_row[0] if period_row is not None else budget["hard_limit"] if budget else 0
        return Policy(
            row["id"],
            row["version_id"],
            row["alias_id"],
            row["revision"],
            row["catalog_revision"],
            config,
            deployments,
            cap,
        )

    async def publish(self, actor: Principal, change: PolicyChange, request_id: UUID) -> dict:
        async with self.db.transaction(actor.tenant_id) as conn:
            await lock_catalog(conn)
            await lock_tenant(conn, actor.tenant_id, exclusive=True)
            if not await still_authorized(conn, actor, "policies:write"):
                raise GatewayError(403, "insufficient_scope", "The policy write permission is inactive.")
            current = await write_policy(
                conn, actor.tenant_id, change, actor.actor_id, request_id, str(actor.actor_id)
            )
        return current

    async def list_policies(
        self,
        tenant: UUID,
        model: str | None,
        status: str | None,
        limit: int,
        snapshot: datetime,
        position: tuple[datetime, UUID] | None,
    ) -> list[dict]:
        rp, pv = db.routing_policies.c, db.policy_versions.c
        stmt = (
            sa.select(
                rp.id,
                rp.created_at,
                rp.updated_at,
                pv.revision,
                pv.id.label("version_id"),
                pv.created_by,
                pv.status,
                db.aliases.c.code.label("model"),
                pv.catalog_revision,
                pv.config,
            )
            .select_from(
                db.routing_policies.join(db.aliases, db.aliases.c.id == rp.alias_id).join(
                    db.policy_versions,
                    sa.and_(
                        rp.tenant_id == pv.tenant_id, rp.id == pv.policy_id, rp.latest_revision == pv.revision
                    ),
                )
            )
            .where(rp.tenant_id == tenant, rp.updated_at <= snapshot)
            .order_by(rp.updated_at.desc(), rp.id.desc())
            .limit(limit + 1)
        )
        if model:
            stmt = stmt.where(db.aliases.c.code == model)
        if status:
            stmt = stmt.where(pv.status == status)
        if position:
            stmt = stmt.where(sa.tuple_(rp.updated_at, rp.id) < sa.tuple_(*position))
        async with self.db.transaction(tenant) as conn:
            if model and not await conn.scalar(
                sa.select(rp.id)
                .join(db.aliases, db.aliases.c.id == rp.alias_id)
                .where(db.aliases.c.code == model, rp.tenant_id == tenant)
            ):
                raise not_found()
            rows = (await conn.execute(stmt)).mappings().all()
            result = []
            for row in rows:
                config = await policy_config(conn, tenant, row["version_id"], row["config"])
                result.append(
                    {
                        **{key: value for key, value in row.items() if key != "config"},
                        **config.model_dump(mode="json"),
                    }
                )
        return result


async def write_policy(
    conn: AsyncConnection,
    tenant: UUID,
    change: PolicyChange,
    user_id: UUID | None,
    request_id: UUID | None,
    actor: str,
) -> dict:
    now = datetime.now(UTC)
    pinned = await conn.scalar(sa.select(db.catalog_current.c.revision))
    if pinned != change.catalog_revision:
        raise GatewayError(409, "policy_catalog_conflict", "The current catalog revision has changed.")
    alias_id = await conn.scalar(sa.select(db.aliases.c.id).where(db.aliases.c.code == change.model))
    if alias_id is None:
        raise not_found()
    rp = db.routing_policies.c
    policy = (
        (
            await conn.execute(
                sa.select(db.routing_policies).where(rp.tenant_id == tenant, rp.alias_id == alias_id)
            )
        )
        .mappings()
        .one_or_none()
    )
    previous = policy["latest_revision"] if policy else 0
    if previous != change.expected_revision or (not policy and change.status == "disabled"):
        raise GatewayError(409, "policy_version_conflict", "The current policy revision has changed.")
    if isinstance(change, ActivePolicyChange):
        config = change
        ids = {item.deployment_id for item in config.targets}
        eligible = await eligible_deployments(conn, tenant, alias_id, pinned, now, ids)
        if {item.id for item in eligible if item.region in config.data_regions} != ids:
            raise GatewayError(
                400,
                "invalid_request",
                "A target is not enrolled for this tenant, alias, or region.",
                param="targets",
            )
        if not policy or policy["active_revision"] is None:
            count = await conn.scalar(
                sa.select(sa.func.count())
                .select_from(db.routing_policies)
                .where(rp.tenant_id == tenant, rp.active_revision.is_not(None))
            )
            if count >= 100:
                raise GatewayError(400, "invalid_request", "The tenant alias limit is 100.")
    else:
        pv = db.policy_versions.c
        stored = (
            await conn.execute(
                sa.select(pv.id, pv.config).where(
                    pv.tenant_id == tenant, pv.policy_id == policy["id"], pv.revision == previous
                )
            )
        ).one()
        config = await policy_config(conn, tenant, stored.id, stored.config)

    policy_id = policy["id"] if policy else uuid4()
    if not policy:
        await conn.execute(
            sa.insert(db.routing_policies).values(
                tenant_id=tenant,
                id=policy_id,
                alias_id=alias_id,
                created_at=now,
                updated_at=now,
            )
        )
    version_id, revision = uuid4(), previous + 1
    config_data = config.model_dump(mode="json", include=set(PolicyConfig.model_fields))
    tunables = {key: value for key, value in config_data.items() if key not in {"targets", "fallback_edges"}}
    await conn.execute(
        sa.insert(db.policy_versions).values(
            tenant_id=tenant,
            id=version_id,
            policy_id=policy_id,
            revision=revision,
            catalog_revision=pinned,
            status=change.status,
            created_by=user_id,
            config=tunables,
            created_at=now,
        )
    )
    await conn.execute(
        sa.insert(db.policy_targets),
        [{"tenant_id": tenant, "version_id": version_id, **target.model_dump()} for target in config.targets],
    )
    if config.fallback_edges:
        await conn.execute(
            sa.insert(db.policy_edges),
            [
                {"tenant_id": tenant, "version_id": version_id, **edge.model_dump()}
                for edge in config.fallback_edges
            ],
        )
    await conn.execute(
        sa.update(db.routing_policies)
        .where(rp.tenant_id == tenant, rp.id == policy_id)
        .values(
            latest_revision=revision,
            active_revision=revision if change.status == "active" else None,
            updated_at=now,
        )
    )
    await conn.execute(
        sa.insert(db.audit).values(
            tenant_id=tenant,
            id=uuid4(),
            actor=actor,
            action=f"policy.{change.status}",
            resource=str(policy_id),
            reason=change.change_reason,
            request_id=request_id,
            details={"old_revision": previous, "new_revision": revision, "alias": change.model},
        )
    )
    return {
        "id": policy_id,
        "revision": revision,
        "version_id": version_id,
        "created_at": policy["created_at"] if policy else now,
        "updated_at": now,
        "created_by": user_id,
        "status": change.status,
        "model": change.model,
        "catalog_revision": pinned,
        **config_data,
    }
