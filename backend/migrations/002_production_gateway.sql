CREATE TABLE aegis_users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES aegis_users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE api_keys (
  key_id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash CHAR(64) NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  environment TEXT NOT NULL CHECK (environment IN ('live', 'test')),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  revoke_reason TEXT,
  last_used_at TIMESTAMPTZ,
  rotated_from TEXT REFERENCES api_keys(key_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id)
);
CREATE INDEX api_keys_tenant_created_idx ON api_keys(tenant_id, created_at DESC);

CREATE TABLE routing_config_versions (
  version_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'scheduled', 'rolled_back')),
  config JSONB NOT NULL,
  created_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  rolled_back_from BIGINT REFERENCES routing_config_versions(version_id)
);
CREATE INDEX routing_config_active_idx ON routing_config_versions(tenant_id, state, effective_at DESC);

CREATE TABLE provider_pricing_versions (
  pricing_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  region TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('token', 'request', 'image', 'second')),
  input_usd_per_million NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (input_usd_per_million >= 0),
  output_usd_per_million NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (output_usd_per_million >= 0),
  fixed_usd_per_unit NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (fixed_usd_per_unit >= 0),
  version TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_at),
  UNIQUE (provider, model, region, unit, version)
);
CREATE INDEX provider_pricing_effective_idx ON provider_pricing_versions(provider, model, region, effective_at DESC);

CREATE TABLE quota_policies (
  quota_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  principal_id TEXT,
  api_key_id TEXT REFERENCES api_keys(key_id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  request_limit BIGINT CHECK (request_limit IS NULL OR request_limit >= 0),
  token_limit BIGINT CHECK (token_limit IS NULL OR token_limit >= 0),
  cost_limit_uusd BIGINT CHECK (cost_limit_uusd IS NULL OR cost_limit_uusd >= 0),
  concurrency_limit INTEGER CHECK (concurrency_limit IS NULL OR concurrency_limit >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (principal_id IS NULL OR api_key_id IS NULL)
);
CREATE INDEX quota_policies_tenant_scope_idx ON quota_policies(tenant_id, principal_id, api_key_id, period) WHERE active = TRUE;

CREATE TABLE quota_windows (
  quota_id BIGINT NOT NULL REFERENCES quota_policies(quota_id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  token_count BIGINT NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  cost_uusd BIGINT NOT NULL DEFAULT 0 CHECK (cost_uusd >= 0),
  concurrency_count INTEGER NOT NULL DEFAULT 0 CHECK (concurrency_count >= 0),
  PRIMARY KEY (quota_id, window_start),
  CHECK (window_end > window_start)
);
CREATE TABLE quota_reservations (
  reservation_id TEXT NOT NULL REFERENCES reservations(reservation_id) ON DELETE CASCADE,
  quota_id BIGINT NOT NULL REFERENCES quota_policies(quota_id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  quoted_tokens BIGINT NOT NULL DEFAULT 0 CHECK (quoted_tokens >= 0),
  quote_uusd BIGINT NOT NULL CHECK (quote_uusd >= 0),
  released_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (reservation_id, quota_id),
  FOREIGN KEY (quota_id, window_start) REFERENCES quota_windows(quota_id, window_start)
);

CREATE TABLE ledger_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  request_id TEXT,
  reservation_id TEXT,
  window_start TIMESTAMPTZ,
  event_type TEXT NOT NULL CHECK (event_type IN ('budget_reserved','provider_started','usage_reported','settled','released','adjusted')),
  amount_delta_uusd BIGINT NOT NULL DEFAULT 0,
  reserved_delta_uusd BIGINT NOT NULL DEFAULT 0,
  token_delta BIGINT NOT NULL DEFAULT 0,
  pricing_version TEXT,
  config_version TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  actor_id TEXT,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_events_tenant_created_idx ON ledger_events(tenant_id, created_at DESC, event_id DESC);

CREATE FUNCTION aegis_reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Aegis ledger events and settled usage are append-only';
END;
$$;
CREATE TRIGGER ledger_events_append_only BEFORE UPDATE OR DELETE ON ledger_events FOR EACH ROW EXECUTE FUNCTION aegis_reject_ledger_mutation();
CREATE TRIGGER usage_entries_append_only BEFORE UPDATE OR DELETE ON usage_entries FOR EACH ROW EXECUTE FUNCTION aegis_reject_ledger_mutation();

CREATE TABLE billing_outbox (
  outbox_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES ledger_events(event_id),
  event_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_progress','published','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX billing_outbox_pending_idx ON billing_outbox(available_at, outbox_id) WHERE state IN ('pending','in_progress');

CREATE TABLE reconciliation_jobs (
  reservation_id TEXT PRIMARY KEY REFERENCES reservations(reservation_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  provider TEXT NOT NULL,
  provider_request_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_progress','retry','settled','released','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_due_idx ON reconciliation_jobs(next_attempt_at, created_at) WHERE state IN ('pending','retry','in_progress');
CREATE TABLE reconciliation_dead_letters (
  dead_letter_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(reservation_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE TABLE audit_events (
  audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(tenant_id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events(tenant_id, created_at DESC, audit_id DESC);

ALTER TABLE reservations DROP CONSTRAINT reservations_state_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_state_check
  CHECK (state IN ('active','provider_started','reconcile_required','settled','released'));
ALTER TABLE reservations ADD COLUMN provider TEXT;
ALTER TABLE reservations ADD COLUMN provider_request_id TEXT;
ALTER TABLE reservations ADD COLUMN config_version TEXT;
ALTER TABLE reservations ADD COLUMN pricing_version TEXT;
ALTER TABLE reservations ADD COLUMN provider_attempts INTEGER NOT NULL DEFAULT 0 CHECK (provider_attempts >= 0);

INSERT INTO ledger_events (tenant_id,window_start,event_type,amount_delta_uusd,reserved_delta_uusd,idempotency_key,payload)
SELECT tenant_id,window_start,'adjusted',settled_uusd,reserved_uusd,
       'legacy-budget-backfill:'||tenant_id||':'||window_start::text,
       jsonb_build_object('source','legacy_budget_windows')
FROM budget_windows
WHERE settled_uusd<>0 OR reserved_uusd<>0
ON CONFLICT (idempotency_key) DO NOTHING;
