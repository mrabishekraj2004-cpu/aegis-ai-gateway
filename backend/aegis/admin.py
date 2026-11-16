"""Local or operator-run provisioning with a dedicated database login."""

import argparse
import asyncio
import json
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4

import sqlalchemy as sa
from pydantic import Field, ValidationError, field_validator
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncConnection

from aegis import models as db
from aegis.accounting import Accounting
from aegis.auth import KEY_SCOPES, new_key
from aegis.catalog import utc_month, write_policy
from aegis.contracts import (
    ActivePolicyChange,
    Alias,
    DisabledPolicyChange,
    StrictModel,
    TokenUsage,
    text_size,
)
from aegis.database import Database, lock_catalog, lock_tenant
from aegis.errors import GatewayError
from aegis.settings import Settings

CAPABILITIES = frozenset({"text", "stream", "system", "stop", "temperature", "top_p"})
ACTOR = "database-operator-cli"


class Enrollment(StrictModel):
    name: Alias
    provider: Literal["mock", "openai", "anthropic"]
    model_code: Alias
    upstream_model: Annotated[
        str, Field(min_length=1, max_length=140, pattern=r"^[A-Za-z0-9][A-Za-z0-9:._/-]*$")
    ]
    aliases: list[Alias] = Field(min_length=1, max_length=10)
    region: Annotated[str, Field(pattern=r"^[a-z0-9-]{1,32}$")]
    quality: Literal[0, 1] = 0
    context_limit: int = Field(ge=1, le=2_000_000)
    output_limit: int = Field(ge=1, le=2048)
    capabilities: list[str] = Field(min_length=1, max_length=6)
    rates: dict[str, Annotated[int, Field(ge=0, le=1_000_000_000_000)]]
    certified: bool = False
    credential_ref: Annotated[str, Field(pattern=r"^[a-zA-Z0-9:_-]{1,120}$")] | None = None
    credential_revision: int = Field(default=1, ge=1)
    quota_group: Annotated[str, Field(pattern=r"^[A-Za-z0-9:_-]{1,100}$")]
    stream_baseline_ms: int = Field(ge=1, le=90000)
    json_baseline_ms: int = Field(ge=1, le=90000)
    bound_overhead: int = Field(default=128, ge=0, le=16384)

    @field_validator("rates")
    @classmethod
    def four_rates(cls, rates: dict) -> dict:
        if rates.keys() != {"input", "output", "cache_read", "cache_write"}:
            raise ValueError("provide each normalized pricing unit")
        return rates

    @field_validator("capabilities")
    @classmethod
    def required_text(cls, values: list[str]) -> list[str]:
        if "text" not in values or not set(values) <= CAPABILITIES or len(set(values)) != len(values):
            raise ValueError("invalid capability declaration")
        return values


def fail(message: str) -> GatewayError:
    return GatewayError(400, "invalid_request", message)


def demo_enrollment() -> Enrollment:
    return Enrollment(
        name="mock-standard",
        provider="mock",
        model_code="mock-v1",
        upstream_model="mock-v1",
        aliases=["mock-chat", "auto"],
        region="local",
        context_limit=18432,
        output_limit=2048,
        capabilities=sorted(CAPABILITIES),
        certified=True,
        quota_group="mock",
        rates={"input": 1_000_000, "output": 2_000_000, "cache_read": 1_000_000, "cache_write": 1_000_000},
        stream_baseline_ms=100,
        json_baseline_ms=100,
        bound_overhead=0,
    )


async def audited(conn: AsyncConnection, tenant: UUID, action: str, resource: str, reason: str, **details):
    await conn.execute(
        sa.insert(db.audit).values(
            tenant_id=tenant,
            id=uuid4(),
            actor=ACTOR,
            action=action,
            resource=resource,
            reason=reason,
            details=details,
        )
    )


async def create_tenant(conn: AsyncConnection, slug: str, cap: int | None, reason: str) -> UUID:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", slug):
        raise fail("Invalid tenant slug.")
    if cap is not None and not 0 <= cap <= 999_999_999_999_999:
        raise fail("Invalid monthly budget amount.")
    identity = uuid4()
    await conn.execute(sa.insert(db.tenants).values(id=identity, slug=slug))
    await conn.execute(
        sa.insert(db.budget_policies).values(
            tenant_id=identity,
            version=1,
            effective_month=utc_month(datetime.now(UTC)),
            hard_limit=cap,
            thresholds=[50, 80, 100],
        )
    )
    await audited(conn, identity, "tenant.create", slug, reason, hard_limit=cap)
    return identity


async def issue_key(
    conn: AsyncConnection,
    settings: Settings,
    tenant: UUID,
    label: str,
    days: int,
    scopes: set[str],
    reason: str,
) -> dict:
    if not scopes or not scopes <= KEY_SCOPES or not 1 <= days <= 365 or not 1 <= text_size(label) <= 128:
        raise fail("Invalid key scopes, label or expiration.")
    token, lookup_id, digest = new_key(settings)
    identity = uuid4()
    now = datetime.now(UTC)
    expires = now + timedelta(days=days)
    await conn.execute(
        sa.insert(db.api_keys).values(
            tenant_id=tenant,
            id=identity,
            public_id=lookup_id,
            digest=digest,
            pepper_version=settings.active_pepper,
            label=label,
            expires_at=expires,
            created_at=now,
        )
    )
    await conn.execute(
        sa.insert(db.api_key_scopes),
        [{"tenant_id": tenant, "key_id": identity, "scope": scope} for scope in sorted(scopes)],
    )
    await audited(conn, tenant, "key.issue", str(identity), reason, scopes=sorted(scopes))
    return {
        "tenant_id": str(tenant),
        "key_id": str(identity),
        "expires_at": expires.isoformat(),
        "api_key": token,
    }


async def enroll(conn: AsyncConnection, tenant: UUID, e: Enrollment, reason: str) -> tuple[UUID, int]:
    if e.provider != "mock" and (not e.credential_ref or e.quota_group == "mock" or e.certified):
        raise fail("External deployments require a credential reference and an uncapped enrollment.")
    if e.context_limit <= e.output_limit:
        raise fail("The context limit must include prompt and output.")
    now = datetime.now(UTC)
    identity = await conn.scalar(
        insert(db.models)
        .values(id=uuid4(), code=e.model_code, quality=e.quality)
        .on_conflict_do_nothing()
        .returning(db.models.c.id)
    )
    if identity is None:
        model = (
            await conn.execute(
                sa.select(db.models.c.id, db.models.c.quality).where(db.models.c.code == e.model_code)
            )
        ).one()
        if model.quality != e.quality:
            raise fail("An existing logical model has a different qualification.")
        identity = model.id

    existing = (
        (await conn.execute(sa.select(db.deployments).where(db.deployments.c.name == e.name)))
        .mappings()
        .one_or_none()
    )
    previous_catalog = await conn.scalar(sa.select(db.catalog_current.c.revision))
    d_id = existing["id"] if existing else uuid4()
    version = 1
    if existing:
        if existing["provider"] != e.provider or existing["model_id"] != identity:
            raise fail("A deployment name is bound to its provider and model.")
        last = await conn.scalar(
            sa.select(sa.func.max(db.deployment_versions.c.version)).where(
                db.deployment_versions.c.deployment_id == d_id
            )
        )
        version = last + 1
        await conn.execute(
            sa.update(db.pricing_versions)
            .where(
                db.pricing_versions.c.deployment_id == d_id,
                db.pricing_versions.c.valid_until.is_(None),
            )
            .values(valid_until=now)
        )
    else:
        await conn.execute(
            sa.insert(db.deployments).values(
                id=d_id,
                name=e.name,
                provider=e.provider,
                model_id=identity,
            )
        )
    fields = {
        "upstream_model",
        "region",
        "context_limit",
        "output_limit",
        "capabilities",
        "credential_ref",
        "credential_revision",
        "quota_group",
        "stream_baseline_ms",
        "json_baseline_ms",
        "bound_overhead",
    }
    await conn.execute(
        sa.insert(db.deployment_versions).values(
            deployment_id=d_id,
            version=version,
            **e.model_dump(include=fields),
        )
    )
    await conn.execute(
        sa.insert(db.pricing_versions).values(
            deployment_id=d_id,
            version=version,
            valid_from=now,
            certified=e.certified,
        )
    )
    await conn.execute(
        sa.insert(db.pricing_rates),
        [
            {"deployment_id": d_id, "price_version": version, "unit": unit, "per_million": amount}
            for unit, amount in e.rates.items()
        ],
    )
    for alias in sorted(set(e.aliases)):
        alias_id = await conn.scalar(
            insert(db.aliases)
            .values(id=uuid4(), code=alias)
            .on_conflict_do_nothing()
            .returning(db.aliases.c.id)
        )
        if not alias_id:
            alias_id = await conn.scalar(sa.select(db.aliases.c.id).where(db.aliases.c.code == alias))
        await conn.execute(
            insert(db.alias_deployments)
            .values(alias_id=alias_id, deployment_id=d_id)
            .on_conflict_do_nothing()
        )
    await conn.execute(
        insert(db.tenant_deployments).values(tenant_id=tenant, deployment_id=d_id).on_conflict_do_nothing()
    )
    revision = await conn.scalar(sa.insert(db.catalog_revisions).returning(db.catalog_revisions.c.revision))
    if previous_catalog:
        c = db.catalog_items.c
        await conn.execute(
            sa.insert(db.catalog_items).from_select(
                ["catalog_revision", "deployment_id", "deployment_version", "price_version"],
                sa.select(sa.literal(revision), c.deployment_id, c.deployment_version, c.price_version).where(
                    c.catalog_revision == previous_catalog, c.deployment_id != d_id
                ),
            )
        )
    await conn.execute(
        sa.insert(db.catalog_items).values(
            catalog_revision=revision,
            deployment_id=d_id,
            deployment_version=version,
            price_version=version,
        )
    )
    await conn.execute(
        insert(db.catalog_current)
        .values(singleton=True, revision=revision)
        .on_conflict_do_update(index_elements=["singleton"], set_={"revision": revision})
    )
    await conn.execute(
        sa.insert(db.platform_audit).values(
            id=uuid4(),
            actor=ACTOR,
            action="catalog.enroll",
            resource=str(d_id),
            reason=reason,
        )
    )
    await audited(conn, tenant, "deployment.enroll", str(d_id), reason, revision=revision)
    return d_id, revision


def initial_mock_policy(alias: str, deployment: UUID, revision: int, reason: str) -> ActivePolicyChange:
    return ActivePolicyChange.model_validate(
        {
            "model": alias,
            "expected_revision": 0,
            "catalog_revision": revision,
            "change_reason": reason,
            "targets": [{"deployment_id": deployment, "priority": 100, "weight": 100}],
            "data_regions": ["local"],
        }
    )


async def provision_demo(database: Database, settings: Settings, slug: str, cap: int = 1_000_000) -> dict:
    if settings.environment not in {"local", "test"}:
        raise fail("Mock demo provisioning is local-only.")
    async with database.transaction() as conn:
        await lock_catalog(conn, exclusive=True)
        tenant = await create_tenant(conn, slug, cap, "Local mock demo")
        deployment = await conn.scalar(
            sa.select(db.deployments.c.id).where(db.deployments.c.name == "mock-standard")
        )
        if deployment:
            await conn.execute(
                insert(db.tenant_deployments)
                .values(tenant_id=tenant, deployment_id=deployment)
                .on_conflict_do_nothing()
            )
            revision = await conn.scalar(sa.select(db.catalog_current.c.revision))
        else:
            deployment, revision = await enroll(conn, tenant, demo_enrollment(), "Local mock demo")
        for alias in ("mock-chat", "auto"):
            await write_policy(
                conn,
                tenant,
                initial_mock_policy(alias, deployment, revision, "Local mock demo"),
                None,
                None,
                ACTOR,
            )
        return await issue_key(conn, settings, tenant, "local demo", 30, set(KEY_SCOPES), "Local mock demo")


async def tenant_id(conn: AsyncConnection, slug: str) -> UUID:
    identity = await conn.scalar(sa.select(db.tenants.c.id).where(db.tenants.c.slug == slug))
    if identity is None:
        raise GatewayError(404, "resource_not_found", "The tenant does not exist.")
    return identity


async def run(args, settings: Settings) -> dict:
    database = Database(settings, os.environ["AEGIS_ADMIN_DATABASE_URL"])
    try:
        if args.command == "demo":
            return await provision_demo(database, settings, args.slug)
        reason = args.reason.strip()
        if not 1 <= text_size(reason) <= 256:
            raise fail("A bounded audit reason is required.")
        if args.command == "adjust":
            async with database.transaction() as conn:
                identity = await tenant_id(conn, args.slug)
            usage = TokenUsage.model_validate_json(args.usage.read_bytes())
            changed = await Accounting(database).adjust(
                identity, args.attempt, args.adjustment, usage, reason, ACTOR
            )
            return {"applied": changed}
        async with database.transaction() as conn:
            if args.command == "create-tenant":
                identity = await create_tenant(conn, args.slug, args.monthly_microusd, reason)
                return {"tenant_id": str(identity)}
            identity = await tenant_id(conn, args.slug)
            if args.command in {"enroll", "policy", "disable-deployment"}:
                await lock_catalog(conn, exclusive=args.command != "policy")
            await lock_tenant(conn, identity, exclusive=True)
            if args.command == "issue-key":
                return await issue_key(
                    conn, settings, identity, args.label, args.days, set(args.scope), reason
                )
            if args.command == "revoke-key":
                result = await conn.execute(
                    sa.update(db.api_keys)
                    .where(
                        db.api_keys.c.tenant_id == identity,
                        db.api_keys.c.id == args.key_id,
                        db.api_keys.c.revoked_at.is_(None),
                    )
                    .values(revoked_at=datetime.now(UTC))
                    .returning(db.api_keys.c.id)
                )
                if result.scalar_one_or_none():
                    await audited(conn, identity, "key.revoke", str(args.key_id), reason)
                return {"key_id": str(args.key_id)}
            if args.command == "enroll":
                spec = Enrollment.model_validate_json(args.spec.read_bytes())
                if spec.provider == "mock" and settings.environment not in {"local", "test"}:
                    raise fail("Mock enrollment is local-only.")
                deployment, revision = await enroll(conn, identity, spec, reason)
                return {"deployment_id": str(deployment), "catalog_revision": revision}
            if args.command == "policy":
                raw = json.loads(args.spec.read_bytes())
                raw["change_reason"] = reason
                schema = DisabledPolicyChange if raw.get("status") == "disabled" else ActivePolicyChange
                config = schema.model_validate_json(json.dumps(raw))
                return await write_policy(conn, identity, config, None, None, ACTOR)
            if args.command == "disable-deployment":
                deployment = await conn.scalar(
                    sa.update(db.deployments)
                    .where(
                        db.deployments.c.id == args.deployment,
                    )
                    .values(emergency_disabled=not args.enable)
                    .returning(db.deployments.c.id)
                )
                if deployment is None:
                    raise GatewayError(404, "resource_not_found", "The deployment does not exist.")
                await conn.execute(
                    sa.insert(db.platform_audit).values(
                        id=uuid4(),
                        actor=ACTOR,
                        action="deployment.enable" if args.enable else "deployment.disable",
                        resource=str(deployment),
                        reason=reason,
                    )
                )
                return {"deployment_id": str(deployment), "disabled": not args.enable}
            if args.command == "member":
                if settings.oidc_issuer != args.issuer or not 1 <= text_size(args.subject) <= 255:
                    raise fail("The user must match the configured OIDC issuer and a valid subject.")
                user_id = await conn.scalar(
                    insert(db.users)
                    .values(id=uuid4(), issuer=args.issuer, subject=args.subject)
                    .on_conflict_do_nothing()
                    .returning(db.users.c.id)
                )
                if user_id is None:
                    user_id = await conn.scalar(
                        sa.select(db.users.c.id).where(
                            db.users.c.issuer == args.issuer, db.users.c.subject == args.subject
                        )
                    )
                old = await conn.scalar(
                    sa.select(db.memberships.c.role).where(
                        db.memberships.c.tenant_id == identity,
                        db.memberships.c.user_id == user_id,
                        db.memberships.c.active,
                    )
                )
                if old == "owner" and args.role != "owner":
                    owners = await conn.scalar(
                        sa.select(sa.func.count())
                        .select_from(db.memberships)
                        .where(
                            db.memberships.c.tenant_id == identity,
                            db.memberships.c.role == "owner",
                            db.memberships.c.active,
                        )
                    )
                    if owners <= 1:
                        raise GatewayError(409, "last_tenant_owner", "The tenant requires an active owner.")
                await conn.execute(
                    insert(db.memberships)
                    .values(tenant_id=identity, user_id=user_id, role=args.role)
                    .on_conflict_do_update(
                        index_elements=["tenant_id", "user_id"], set_={"role": args.role, "active": True}
                    )
                )
                await audited(conn, identity, "member.set_role", str(user_id), reason, role=args.role)
                return {"user_id": str(user_id), "role": args.role}
            raise fail("Unknown administrative command.")
    finally:
        await database.close()


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)

    def command(name, *, audited=True):
        item = sub.add_parser(name)
        item.add_argument("slug")
        if audited:
            item.add_argument("--reason", required=True)
        return item

    command("demo", audited=False)
    tenant = command("create-tenant")
    limit = tenant.add_mutually_exclusive_group(required=True)
    limit.add_argument("--monthly-microusd", type=int)
    limit.add_argument("--uncapped", action="store_true")
    issue = command("issue-key")
    issue.add_argument("--label", default="service")
    issue.add_argument("--scope", choices=sorted(KEY_SCOPES), action="append", required=True)
    issue.add_argument("--days", type=int, default=30)
    command("revoke-key").add_argument("key_id", type=UUID)
    command("enroll").add_argument("spec", type=Path)
    command("policy").add_argument("spec", type=Path)
    member = command("member")
    member.add_argument("--issuer", required=True)
    member.add_argument("--subject", required=True)
    member.add_argument(
        "--role", choices=["owner", "admin", "analyst", "developer", "auditor"], required=True
    )
    kill = command("disable-deployment")
    kill.add_argument("deployment", type=UUID)
    kill.add_argument("--enable", action="store_true")
    adjust = command("adjust")
    adjust.add_argument("attempt", type=UUID)
    adjust.add_argument("adjustment", type=UUID)
    adjust.add_argument("usage", type=Path)
    return cli


def main() -> None:
    args = parser().parse_args()
    try:
        result = asyncio.run(run(args, Settings()))
    except GatewayError as exc:
        raise SystemExit(f"{exc.code}: {exc.message}") from None
    except (ValidationError, SQLAlchemyError, OSError, KeyError, ValueError, TypeError):
        raise SystemExit(
            "Provisioning failed. Check role setup, tenant state and validated configuration."
        ) from None
    print(json.dumps(result, default=str))
