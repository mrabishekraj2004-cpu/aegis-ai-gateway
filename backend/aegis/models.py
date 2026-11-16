"""PostgreSQL schema shared by the async persistence modules."""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID, ExcludeConstraint

m = sa.MetaData(
    schema="aegis",
    naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_name)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s",
        "pk": "pk_%(table_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    },
)
C = sa.Column
FK = sa.ForeignKey
FKS = sa.ForeignKeyConstraint
CHECK = sa.CheckConstraint
TS = sa.DateTime(timezone=True)
NOW = sa.func.now()
ID = UUID(as_uuid=True)


def tenant_id(*, primary_key: bool = True) -> sa.Column:
    return C("tenant_id", ID, FK("aegis.tenants.id"), primary_key=primary_key, nullable=False)


tenants = sa.Table(
    "tenants",
    m,
    C("id", ID, primary_key=True),
    C("slug", sa.String(63), unique=True, nullable=False),
    C("active", sa.Boolean, nullable=False, server_default=sa.true()),
    C("created_at", TS, nullable=False, server_default=NOW),
    CHECK("slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'", name="tenant_slug_format"),
)
users = sa.Table(
    "users",
    m,
    C("id", ID, primary_key=True),
    C("issuer", sa.Text, nullable=False),
    C("subject", sa.Text, nullable=False),
    sa.UniqueConstraint("issuer", "subject"),
)
roles = sa.Table("roles", m, C("code", sa.String(32), primary_key=True))
role_permissions = sa.Table(
    "role_permissions",
    m,
    C("role", sa.String(32), FK("aegis.roles.code"), primary_key=True),
    C("permission", sa.String(32), primary_key=True),
)
memberships = sa.Table(
    "memberships",
    m,
    tenant_id(),
    C("user_id", ID, FK("aegis.users.id"), primary_key=True),
    C("role", sa.String(32), FK("aegis.roles.code"), nullable=False),
    C("active", sa.Boolean, nullable=False, server_default=sa.true()),
)
sa.Index("ix_memberships_user", memberships.c.user_id, memberships.c.tenant_id)
api_keys = sa.Table(
    "api_keys",
    m,
    tenant_id(),
    C("id", ID, primary_key=True),
    C("public_id", sa.String(16), nullable=False, unique=True),
    C("digest", sa.LargeBinary(32), nullable=False),
    C("pepper_version", sa.String(32), nullable=False),
    C("label", sa.String(128), nullable=False),
    C("created_at", TS, nullable=False, server_default=NOW),
    C("expires_at", TS, nullable=False),
    C("revoked_at", TS),
    CHECK("octet_length(digest) = 32 AND expires_at > created_at", name="key_digest_and_expiry"),
)
api_key_scopes = sa.Table(
    "api_key_scopes",
    m,
    tenant_id(),
    C("key_id", ID, primary_key=True),
    C("scope", sa.String(32), primary_key=True),
    FKS(["tenant_id", "key_id"], ["aegis.api_keys.tenant_id", "aegis.api_keys.id"]),
    CHECK("scope IN ('chat:write','models:read','usage:read')", name="key_supported_scope"),
)
providers = sa.Table(
    "providers",
    m,
    C("code", sa.String(16), primary_key=True),
    C("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
    CHECK("code IN ('mock','openai','anthropic')", name="supported_provider"),
)
models = sa.Table(
    "models",
    m,
    C("id", ID, primary_key=True),
    C("code", sa.String(100), unique=True, nullable=False),
    C("quality", sa.SmallInteger, nullable=False),
    CHECK("quality BETWEEN 0 AND 1", name="model_quality_range"),
)
aliases = sa.Table(
    "model_aliases",
    m,
    C("id", ID, primary_key=True),
    C("code", sa.String(100), unique=True, nullable=False),
    C("created_at", TS, nullable=False, server_default=NOW),
)
deployments = sa.Table(
    "deployments",
    m,
    C("id", ID, primary_key=True),
    C("name", sa.String(100), unique=True, nullable=False),
    C("provider", sa.String(16), FK("aegis.providers.code"), nullable=False),
    C("model_id", ID, FK("aegis.models.id"), nullable=False),
    C("emergency_disabled", sa.Boolean, nullable=False, server_default=sa.false()),
)
deployment_versions = sa.Table(
    "deployment_versions",
    m,
    C("deployment_id", ID, FK("aegis.deployments.id"), primary_key=True),
    C("version", sa.Integer, primary_key=True),
    C("upstream_model", sa.String(140), nullable=False),
    C("region", sa.String(32), nullable=False),
    C("context_limit", sa.Integer, nullable=False),
    C("output_limit", sa.Integer, nullable=False),
    C("capabilities", ARRAY(sa.String(24)), nullable=False),
    C("credential_ref", sa.String(120)),
    C("credential_revision", sa.Integer, nullable=False),
    C("quota_group", sa.String(100), nullable=False),
    C("stream_baseline_ms", sa.Integer, nullable=False),
    C("json_baseline_ms", sa.Integer, nullable=False),
    C("bound_overhead", sa.Integer, nullable=False),
    CHECK(
        "version > 0 AND credential_revision > 0 AND context_limit > 0 AND output_limit BETWEEN 1 AND 2048",
        name="deployment_version_bounds",
    ),
    CHECK(
        "stream_baseline_ms > 0 AND json_baseline_ms > 0 AND bound_overhead >= 0",
        name="deployment_estimate_bounds",
    ),
)
alias_deployments = sa.Table(
    "alias_deployments",
    m,
    C("alias_id", ID, FK("aegis.model_aliases.id"), primary_key=True),
    C("deployment_id", ID, FK("aegis.deployments.id"), primary_key=True),
)
pricing_versions = sa.Table(
    "pricing_versions",
    m,
    C("deployment_id", ID, FK("aegis.deployments.id"), primary_key=True),
    C("version", sa.Integer, primary_key=True),
    C("valid_from", TS, nullable=False),
    C("valid_until", TS),
    C("certified", sa.Boolean, nullable=False),
    C("currency", sa.String(3), nullable=False, server_default="USD"),
    CHECK(
        "currency = 'USD' AND version > 0 AND (valid_until IS NULL OR valid_until > valid_from)",
        name="pricing_version_bounds",
    ),
    ExcludeConstraint(
        ("deployment_id", "="),
        (sa.text("tstzrange(valid_from, valid_until, '[)')"), "&&"),
        name="pricing_no_overlap",
        using="gist",
    ),
)
pricing_rates = sa.Table(
    "pricing_rates",
    m,
    C("deployment_id", ID, primary_key=True),
    C("price_version", sa.Integer, primary_key=True),
    C("unit", sa.String(20), primary_key=True),
    C("per_million", sa.BigInteger, nullable=False),
    FKS(
        ["deployment_id", "price_version"],
        ["aegis.pricing_versions.deployment_id", "aegis.pricing_versions.version"],
    ),
    CHECK(
        "unit IN ('input','output','cache_read','cache_write') AND per_million BETWEEN 0 AND 1000000000000",
        name="rate_unit_and_amount",
    ),
)
catalog_revisions = sa.Table(
    "catalog_revisions",
    m,
    C("revision", sa.BigInteger, sa.Identity(), primary_key=True),
    C("created_at", TS, nullable=False, server_default=NOW),
)
catalog_current = sa.Table(
    "catalog_current",
    m,
    C("singleton", sa.Boolean, primary_key=True, server_default=sa.true()),
    C("revision", sa.BigInteger, FK("aegis.catalog_revisions.revision"), nullable=False),
    CHECK("singleton", name="catalog_is_singleton"),
)
catalog_items = sa.Table(
    "catalog_items",
    m,
    C("catalog_revision", sa.BigInteger, FK("aegis.catalog_revisions.revision"), primary_key=True),
    C("deployment_id", ID, primary_key=True),
    C("deployment_version", sa.Integer, nullable=False),
    C("price_version", sa.Integer, nullable=False),
    FKS(
        ["deployment_id", "deployment_version"],
        ["aegis.deployment_versions.deployment_id", "aegis.deployment_versions.version"],
    ),
    FKS(
        ["deployment_id", "price_version"],
        ["aegis.pricing_versions.deployment_id", "aegis.pricing_versions.version"],
    ),
)
tenant_deployments = sa.Table(
    "tenant_deployments",
    m,
    tenant_id(),
    C("deployment_id", ID, FK("aegis.deployments.id"), primary_key=True),
)
routing_policies = sa.Table(
    "routing_policies",
    m,
    tenant_id(),
    C("id", ID, primary_key=True),
    C("alias_id", ID, FK("aegis.model_aliases.id"), nullable=False),
    C("latest_revision", sa.BigInteger),
    C("active_revision", sa.BigInteger),
    C("created_at", TS, nullable=False, server_default=NOW),
    C("updated_at", TS, nullable=False, server_default=NOW),
    sa.UniqueConstraint("tenant_id", "alias_id"),
    FKS(
        ["tenant_id", "id", "latest_revision"],
        [
            "aegis.policy_versions.tenant_id",
            "aegis.policy_versions.policy_id",
            "aegis.policy_versions.revision",
        ],
        name="fk_policy_latest_version",
        use_alter=True,
    ),
    FKS(
        ["tenant_id", "id", "active_revision"],
        [
            "aegis.policy_versions.tenant_id",
            "aegis.policy_versions.policy_id",
            "aegis.policy_versions.revision",
        ],
        name="fk_policy_active_version",
        use_alter=True,
    ),
    CHECK("active_revision IS NULL OR active_revision = latest_revision", name="policy_active_latest"),
)
policy_versions = sa.Table(
    "policy_versions",
    m,
    tenant_id(),
    C("policy_id", ID, primary_key=True),
    C("revision", sa.BigInteger, primary_key=True),
    C("id", ID, unique=True, nullable=False),
    C("catalog_revision", sa.BigInteger, FK("aegis.catalog_revisions.revision"), nullable=False),
    C("created_by", ID, FK("aegis.users.id")),
    C("created_at", TS, nullable=False, server_default=NOW),
    C("status", sa.String(12), nullable=False),
    C("config", JSONB, nullable=False),
    FKS(["tenant_id", "policy_id"], ["aegis.routing_policies.tenant_id", "aegis.routing_policies.id"]),
    sa.UniqueConstraint("tenant_id", "id"),
    CHECK(
        "revision BETWEEN 1 AND 9007199254740991 AND status IN ('active','disabled')",
        name="policy_version_bounds",
    ),
)
policy_targets = sa.Table(
    "policy_targets",
    m,
    tenant_id(),
    C("version_id", ID, primary_key=True),
    C("deployment_id", ID, FK("aegis.deployments.id"), primary_key=True),
    C("priority", sa.SmallInteger, nullable=False),
    C("weight", sa.SmallInteger, nullable=False),
    FKS(["tenant_id", "version_id"], ["aegis.policy_versions.tenant_id", "aegis.policy_versions.id"]),
    CHECK("priority BETWEEN 0 AND 100 AND weight BETWEEN 0 AND 100", name="target_weight_bounds"),
)
policy_edges = sa.Table(
    "policy_edges",
    m,
    tenant_id(),
    C("version_id", ID, primary_key=True),
    C("source", ID, primary_key=True),
    C("target", ID, primary_key=True),
    FKS(
        ["tenant_id", "version_id", "source"],
        [
            "aegis.policy_targets.tenant_id",
            "aegis.policy_targets.version_id",
            "aegis.policy_targets.deployment_id",
        ],
        name="fk_edge_source",
    ),
    FKS(
        ["tenant_id", "version_id", "target"],
        [
            "aegis.policy_targets.tenant_id",
            "aegis.policy_targets.version_id",
            "aegis.policy_targets.deployment_id",
        ],
        name="fk_edge_target",
    ),
    CHECK("source <> target", name="edge_no_self"),
)
budget_policies = sa.Table(
    "budget_policies",
    m,
    tenant_id(),
    C("version", sa.Integer, primary_key=True),
    C("effective_month", sa.Date, nullable=False),
    C("hard_limit", sa.BigInteger),
    C("thresholds", ARRAY(sa.SmallInteger), nullable=False),
    sa.UniqueConstraint("tenant_id", "effective_month"),
    CHECK(
        "EXTRACT(day FROM effective_month) = 1 AND version > 0 AND hard_limit >= 0",
        name="budget_policy_bounds",
    ),
)
budget_periods = sa.Table(
    "budget_periods",
    m,
    tenant_id(),
    C("period_start", sa.Date, primary_key=True),
    C("budget_version", sa.Integer, nullable=False),
    C("hard_limit", sa.BigInteger),
    C("spent", sa.BigInteger, nullable=False, server_default="0"),
    C("reserved", sa.BigInteger, nullable=False, server_default="0"),
    FKS(
        ["tenant_id", "budget_version"], ["aegis.budget_policies.tenant_id", "aegis.budget_policies.version"]
    ),
    CHECK(
        "EXTRACT(day FROM period_start) = 1 AND spent >= 0 AND reserved >= 0 AND hard_limit >= 0",
        name="budget_period_bounds",
    ),
)
requests = sa.Table(
    "gateway_requests",
    m,
    tenant_id(),
    C("id", ID, primary_key=True),
    C("key_id", ID),
    C("user_id", ID, FK("aegis.users.id")),
    C("alias_id", ID, FK("aegis.model_aliases.id"), nullable=False),
    C("policy_version_id", ID, nullable=False),
    C("catalog_revision", sa.BigInteger, FK("aegis.catalog_revisions.revision"), nullable=False),
    C("received_at", TS, nullable=False),
    C("period_start", sa.Date, nullable=False),
    C("stream", sa.Boolean, nullable=False),
    C("state", sa.String(20), nullable=False, server_default="admitted"),
    C("delivery", sa.String(20), nullable=False, server_default="unknown"),
    C("reason", sa.String(48)),
    C("client_request_id", sa.String(64)),
    C("route_evidence", JSONB, nullable=False),
    FKS(["tenant_id", "key_id"], ["aegis.api_keys.tenant_id", "aegis.api_keys.id"]),
    FKS(["tenant_id", "policy_version_id"], ["aegis.policy_versions.tenant_id", "aegis.policy_versions.id"]),
    CHECK("(key_id IS NULL) <> (user_id IS NULL)", name="request_one_actor"),
    CHECK("state IN ('admitted','succeeded','failed','cancelled')", name="request_state"),
    CHECK("delivery IN ('unknown','complete','partial','disconnected')", name="request_delivery"),
)
sa.Index(
    "ix_gateway_requests_tenant_time", requests.c.tenant_id, requests.c.received_at.desc(), requests.c.id
)
attempts = sa.Table(
    "provider_attempts",
    m,
    tenant_id(),
    C("id", ID, primary_key=True),
    C("request_id", ID, nullable=False),
    C("ordinal", sa.SmallInteger, nullable=False),
    C("deployment_id", ID, nullable=False),
    C("deployment_version", sa.Integer, nullable=False),
    C("price_version", sa.Integer, nullable=False),
    C("period_start", sa.Date, nullable=False),
    C("authorized_at", TS, nullable=False),
    C("lease_expires_at", TS, nullable=False),
    C("settle_after", TS, nullable=False),
    C("terminal_at", TS),
    C("state", sa.String(24), nullable=False),
    C("reason", sa.String(48)),
    C("hold", sa.BigInteger, nullable=False),
    C("charged", sa.BigInteger, nullable=False, server_default="0"),
    sa.UniqueConstraint("tenant_id", "request_id", "ordinal"),
    FKS(["tenant_id", "request_id"], ["aegis.gateway_requests.tenant_id", "aegis.gateway_requests.id"]),
    FKS(
        ["tenant_id", "period_start"], ["aegis.budget_periods.tenant_id", "aegis.budget_periods.period_start"]
    ),
    FKS(
        ["deployment_id", "deployment_version"],
        ["aegis.deployment_versions.deployment_id", "aegis.deployment_versions.version"],
    ),
    FKS(
        ["deployment_id", "price_version"],
        ["aegis.pricing_versions.deployment_id", "aegis.pricing_versions.version"],
    ),
    CHECK("ordinal BETWEEN 1 AND 2 AND hold >= 0 AND charged >= 0", name="attempt_amount_bounds"),
    CHECK(
        "state IN ('authorized','pending','reported','estimated','adjusted','confirmed_nonbillable')",
        name="attempt_state",
    ),
)
sa.Index(
    "ix_attempt_recovery",
    attempts.c.lease_expires_at,
    attempts.c.settle_after,
    postgresql_where=attempts.c.state.in_(("authorized", "pending")),
)
usage = sa.Table(
    "usage_records",
    m,
    tenant_id(),
    C("attempt_id", ID, primary_key=True),
    C("prompt_tokens", sa.Integer),
    C("completion_tokens", sa.Integer),
    C("updated_at", TS, nullable=False),
    FKS(["tenant_id", "attempt_id"], ["aegis.provider_attempts.tenant_id", "aegis.provider_attempts.id"]),
    CHECK("prompt_tokens >= 0 AND completion_tokens >= 0", name="usage_nonnegative"),
)
usage_components = sa.Table(
    "usage_components",
    m,
    tenant_id(),
    C("attempt_id", ID, primary_key=True),
    C("unit", sa.String(20), primary_key=True),
    C("tokens", sa.Integer, nullable=False),
    C("charge", sa.BigInteger, nullable=False),
    FKS(["tenant_id", "attempt_id"], ["aegis.usage_records.tenant_id", "aegis.usage_records.attempt_id"]),
    CHECK(
        "unit IN ('input','output','cache_read','cache_write') AND tokens >= 0 AND charge >= 0",
        name="usage_component_bounds",
    ),
)
ledger = sa.Table(
    "spend_entries",
    m,
    tenant_id(),
    C("id", ID, primary_key=True),
    C("attempt_id", ID, nullable=False),
    C("period_start", sa.Date, nullable=False),
    C("event_key", sa.String(96), nullable=False),
    C("kind", sa.String(16), nullable=False),
    C("spend_delta", sa.BigInteger, nullable=False),
    C("hold_delta", sa.BigInteger, nullable=False),
    C("occurred_at", TS, nullable=False, server_default=NOW),
    FKS(["tenant_id", "attempt_id"], ["aegis.provider_attempts.tenant_id", "aegis.provider_attempts.id"]),
    FKS(
        ["tenant_id", "period_start"], ["aegis.budget_periods.tenant_id", "aegis.budget_periods.period_start"]
    ),
    sa.UniqueConstraint("tenant_id", "attempt_id", "event_key"),
    CHECK(
        """(kind = 'reserve' AND hold_delta >= 0 AND spend_delta = 0)
          OR (kind = 'settle' AND hold_delta <= 0 AND spend_delta >= 0)
          OR (kind = 'adjust' AND hold_delta = 0)""",
        name="ledger_delta_kind",
    ),
)
sa.Index("ix_spend_entries_tenant_period", ledger.c.tenant_id, ledger.c.period_start)
budget_alerts = sa.Table(
    "budget_alerts",
    m,
    tenant_id(),
    C("period_start", sa.Date, primary_key=True),
    C("threshold", sa.SmallInteger, primary_key=True),
    C("occurred_at", TS, nullable=False, server_default=NOW),
    FKS(
        ["tenant_id", "period_start"], ["aegis.budget_periods.tenant_id", "aegis.budget_periods.period_start"]
    ),
    CHECK("threshold BETWEEN 1 AND 100", name="budget_alert_threshold"),
)
billing_quarantine = sa.Table(
    "billing_quarantine",
    m,
    C("deployment_id", ID, primary_key=True),
    C("price_version", sa.Integer, primary_key=True),
    C("occurred_at", TS, nullable=False, server_default=NOW),
    FKS(
        ["deployment_id", "price_version"],
        ["aegis.pricing_versions.deployment_id", "aegis.pricing_versions.version"],
    ),
)
audit = sa.Table(
    "audit_events",
    m,
    tenant_id(),
    C("id", ID, primary_key=True),
    C("actor", sa.String(150), nullable=False),
    C("action", sa.String(48), nullable=False),
    C("resource", sa.String(140), nullable=False),
    C("reason", sa.String(256), nullable=False),
    C("request_id", ID),
    C("details", JSONB, nullable=False),
    C("occurred_at", TS, nullable=False, server_default=NOW),
)
sa.Index("ix_audit_events_tenant_time", audit.c.tenant_id, audit.c.occurred_at.desc(), audit.c.id)
platform_audit = sa.Table(
    "platform_audit_events",
    m,
    C("id", ID, primary_key=True),
    C("actor", sa.String(150), nullable=False),
    C("action", sa.String(48), nullable=False),
    C("resource", sa.String(140), nullable=False),
    C("reason", sa.String(256), nullable=False),
    C("occurred_at", TS, nullable=False, server_default=NOW),
)
