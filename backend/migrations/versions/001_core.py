"""Initialize the gateway catalog, ledger and tenant isolation."""

from pathlib import Path

from alembic import op

revision = "001_core"
down_revision = None

GROUPS = ("aegis_runtime", "aegis_admin", "aegis_worker", "aegis_lookup")
TENANT_TABLES = (
    "memberships",
    "api_keys",
    "api_key_scopes",
    "tenant_deployments",
    "routing_policies",
    "policy_versions",
    "policy_targets",
    "policy_edges",
    "budget_policies",
    "budget_periods",
    "gateway_requests",
    "provider_attempts",
    "usage_records",
    "usage_components",
    "spend_entries",
    "budget_alerts",
    "audit_events",
)


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    op.execute("CREATE SCHEMA aegis")
    for role in GROUPS:
        op.execute(f"""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
                    CREATE ROLE {role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
                END IF;
            END $$
        """)
    ddl = Path(__file__).with_name("001_core.sql").read_text(encoding="utf-8")
    for statement in ddl.split("-- aegis:statement"):
        op.execute(statement.strip())

    op.execute(f"GRANT USAGE ON SCHEMA aegis TO {', '.join(GROUPS)}")
    op.execute("GRANT SELECT ON public.alembic_version TO aegis_runtime, aegis_worker")
    op.execute("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA aegis TO aegis_admin")
    op.execute(
        "REVOKE UPDATE ON aegis.audit_events, aegis.platform_audit_events, aegis.spend_entries "
        "FROM aegis_admin"
    )
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA aegis TO aegis_admin")
    op.execute("""
        GRANT SELECT ON aegis.tenants, aegis.users, aegis.roles, aegis.role_permissions,
        aegis.memberships, aegis.providers, aegis.models, aegis.model_aliases, aegis.deployments,
        aegis.deployment_versions, aegis.alias_deployments, aegis.pricing_versions, aegis.pricing_rates,
        aegis.catalog_revisions, aegis.catalog_current, aegis.catalog_items, aegis.tenant_deployments,
        aegis.api_key_scopes, aegis.routing_policies, aegis.policy_versions, aegis.policy_targets,
        aegis.policy_edges, aegis.budget_policies, aegis.budget_periods, aegis.gateway_requests,
        aegis.provider_attempts, aegis.usage_records, aegis.billing_quarantine TO aegis_runtime
    """)
    op.execute("GRANT SELECT (tenant_id, id, expires_at, revoked_at) ON aegis.api_keys TO aegis_runtime")
    op.execute("""
        GRANT INSERT ON aegis.routing_policies, aegis.policy_versions, aegis.policy_targets,
        aegis.policy_edges, aegis.budget_periods, aegis.gateway_requests, aegis.provider_attempts,
        aegis.usage_records, aegis.usage_components, aegis.spend_entries, aegis.audit_events,
        aegis.budget_alerts, aegis.billing_quarantine TO aegis_runtime
    """)
    op.execute("""
        GRANT UPDATE (latest_revision, active_revision, updated_at) ON aegis.routing_policies TO aegis_runtime
    """)
    op.execute("GRANT UPDATE (spent, reserved) ON aegis.budget_periods TO aegis_runtime")
    op.execute("GRANT UPDATE (state, delivery, reason) ON aegis.gateway_requests TO aegis_runtime")
    op.execute(
        "GRANT UPDATE (state, reason, terminal_at, charged) ON aegis.provider_attempts TO aegis_runtime"
    )
    op.execute("""
        GRANT SELECT ON aegis.gateway_requests, aegis.provider_attempts, aegis.budget_periods,
        aegis.budget_policies TO aegis_worker
    """)
    op.execute("GRANT UPDATE (state, reason) ON aegis.gateway_requests TO aegis_worker")
    op.execute(
        "GRANT UPDATE (state, reason, terminal_at, charged) ON aegis.provider_attempts TO aegis_worker"
    )
    op.execute("GRANT UPDATE (spent, reserved) ON aegis.budget_periods TO aegis_worker")
    op.execute(
        "GRANT INSERT ON aegis.usage_records, aegis.spend_entries, aegis.budget_alerts TO aegis_worker"
    )
    op.execute(
        "GRANT SELECT ON aegis.api_keys, aegis.api_key_scopes, aegis.tenants, aegis.provider_attempts "
        "TO aegis_lookup"
    )

    for table, tenant_column in (("tenants", "id"), *((name, "tenant_id") for name in TENANT_TABLES)):
        op.execute(f"ALTER TABLE aegis.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE aegis.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            CREATE POLICY tenant_scope ON aegis.{table} TO aegis_runtime, aegis_worker
            USING ({tenant_column} = NULLIF(current_setting('aegis.tenant', true), '')::uuid)
            WITH CHECK ({tenant_column} = NULLIF(current_setting('aegis.tenant', true), '')::uuid)
        """)
        op.execute(
            f"CREATE POLICY operator_scope ON aegis.{table} TO aegis_admin USING (true) WITH CHECK (true)"
        )
    for table in ("tenants", "api_keys", "api_key_scopes", "provider_attempts"):
        op.execute(f"CREATE POLICY lookup_scope ON aegis.{table} FOR SELECT TO aegis_lookup USING (true)")

    op.execute("""
        CREATE FUNCTION aegis.lookup_api_key(lookup_id text)
        RETURNS TABLE(tenant_id uuid, actor_id uuid, digest bytea, pepper_version text, scopes text[])
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
        SELECT k.tenant_id, k.id, k.digest, k.pepper_version::text,
          ARRAY(SELECT s.scope::text FROM aegis.api_key_scopes s
                WHERE s.tenant_id = k.tenant_id AND s.key_id = k.id ORDER BY s.scope)
        FROM aegis.api_keys k JOIN aegis.tenants t ON t.id = k.tenant_id
        WHERE k.public_id = lookup_id AND t.active AND k.revoked_at IS NULL AND k.expires_at > now()
        $$
    """)
    op.execute("""
        CREATE FUNCTION aegis.recovery_candidates(batch_size integer)
        RETURNS TABLE(tenant_id uuid, attempt_id uuid, period_start date, request_id uuid)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
        SELECT a.tenant_id, a.id, a.period_start, a.request_id
        FROM aegis.provider_attempts a
        WHERE (a.state = 'authorized' AND a.lease_expires_at <= now())
           OR (a.state = 'pending' AND a.settle_after <= now())
        ORDER BY a.lease_expires_at, a.id
        LIMIT LEAST(GREATEST(batch_size, 1), 100)
        $$
    """)
    # The definer can resolve objects and read the specifically granted source tables.
    op.execute("GRANT CREATE ON SCHEMA aegis TO aegis_lookup")
    for signature, role in (
        ("lookup_api_key(text)", "aegis_runtime"),
        ("recovery_candidates(integer)", "aegis_worker"),
    ):
        # Set ACLs while the migrator still owns the function.
        op.execute(f"REVOKE ALL ON FUNCTION aegis.{signature} FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION aegis.{signature} TO {role}")
        op.execute(f"ALTER FUNCTION aegis.{signature} OWNER TO aegis_lookup")
    op.execute("REVOKE CREATE ON SCHEMA aegis FROM aegis_lookup")
    op.execute("INSERT INTO aegis.providers(code) VALUES ('mock'), ('openai'), ('anthropic')")
    op.execute(
        "INSERT INTO aegis.roles(code) VALUES ('owner'), ('admin'), ('analyst'), ('developer'), ('auditor')"
    )
    op.execute("""
        INSERT INTO aegis.role_permissions(role, permission) VALUES
            ('owner','policies:read'), ('owner','policies:write'), ('owner','usage:read'),
            ('owner','playground:run'), ('owner','models:read'),
            ('admin','policies:read'), ('admin','policies:write'), ('admin','usage:read'),
            ('admin','playground:run'), ('admin','models:read'),
            ('analyst','usage:read'), ('analyst','models:read'),
            ('developer','playground:run'), ('developer','models:read')
    """)


def downgrade() -> None:
    raise RuntimeError("The initial migration owns the spend ledger and has no destructive downgrade.")
