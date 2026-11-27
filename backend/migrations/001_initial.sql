CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_limit_uusd BIGINT NOT NULL CHECK (monthly_limit_uusd >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE budget_windows (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  limit_uusd BIGINT NOT NULL CHECK (limit_uusd >= 0),
  settled_uusd BIGINT NOT NULL DEFAULT 0 CHECK (settled_uusd >= 0),
  reserved_uusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_uusd >= 0),
  PRIMARY KEY (tenant_id, window_start),
  CHECK (window_end > window_start),
  CHECK (settled_uusd + reserved_uusd <= limit_uusd)
);

CREATE TABLE idempotency_records (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'complete')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, request_id),
  CHECK ((state = 'in_progress' AND response_status IS NULL AND response_body IS NULL)
      OR (state = 'complete' AND response_status IS NOT NULL AND response_body IS NOT NULL))
);

CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  quote_uusd BIGINT NOT NULL CHECK (quote_uusd >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'reconcile_required', 'settled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  UNIQUE (tenant_id, request_id),
  UNIQUE (tenant_id, window_start, reservation_id),
  FOREIGN KEY (tenant_id, window_start)
    REFERENCES budget_windows(tenant_id, window_start)
);

CREATE TABLE usage_entries (
  usage_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  route JSONB NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens = input_tokens + output_tokens),
  cost_uusd BIGINT NOT NULL CHECK (cost_uusd >= 0),
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, window_start)
    REFERENCES budget_windows(tenant_id, window_start),
  FOREIGN KEY (tenant_id, window_start, reservation_id)
    REFERENCES reservations(tenant_id, window_start, reservation_id)
);

CREATE INDEX usage_entries_tenant_window_created_idx
  ON usage_entries(tenant_id, window_start, created_at DESC);

CREATE INDEX reservations_reconcile_idx
  ON reservations(created_at)
  WHERE state = 'reconcile_required';
