# Aegis AI Gateway

Aegis is a multi-tenant model gateway prototype. It authenticates server-issued API keys, admits requests against PostgreSQL-backed budgets and quotas, routes to configured provider adapters, records immutable billing events, and reconciles uncertain requests asynchronously.

## What works today

- PostgreSQL API-key authentication, tenant-scoped control-plane operations, platform-admin restrictions, budget admission, append-only ledger events, idempotent settlement, usage reporting, and audit history.
- Mock, OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages adapters. `OPENAI_API_MODE=responses` enables retrieval of stored OpenAI Responses for reconciliation. Anthropic Messages has no retrieve-by-message endpoint in this adapter, so uncertain outcomes remain pending for provider-log review.
- Streaming, disconnect propagation, non-stream cancellation, durable reconciliation, integration-event outbox tables, and background workers.
- Type checking and backend linting, dependency lockfiles, PostgreSQL-backed GitHub Actions checks, Prometheus metrics, OpenTelemetry export, and a provisioned Grafana dashboard.

This is not yet a hosted production SaaS. The account screens are a front-end preview, the external outbox consumer is not implemented, and live provider smoke tests, crash/load results, and a recorded browser demonstration remain pending. See [deployment status](docs/DEPLOYMENT.md) and the [feature audit](docs/FEATURE_COMPLETION_AUDIT.md).

## Run the complete local demo

Docker Compose starts PostgreSQL, the API, reconciliation and outbox workers, the frontend, OpenTelemetry Collector, Prometheus, and Grafana. It uses synthetic tenants and a deterministic mock provider.

```powershell
pwsh -File scripts/init-local-env.ps1
docker compose up --build
```

Open [http://localhost:4173](http://localhost:4173). Grafana is at [http://localhost:3000](http://localhost:3000); its local demo login is in `.env`. Prometheus and database ports are private to the Compose network. The demo bearer values are published to the browser by design in local demo mode and must never be used outside an isolated local environment. The `.env` values are generated locally, ignored by Git, and never printed by the helper.

The Budget Demo tenant has an actual `$0.34` cap. A complete deterministic mock request settles at `$0.34`; the next request is denied before the mock provider runs. Select the mock failure scenario to see a pending reconciliation reservation. The background worker resolves the mock receipt safely.

Stop the stack with `docker compose down`. To erase the local synthetic database and monitoring history, use `docker compose down --volumes`.

## Run checks

```powershell
cd backend
npm ci
npm run check
npm run typecheck
npm run lint
npm test
```

```powershell
cd frontend
npm ci
npm run check
npm test
```

The PostgreSQL integration cases require `AEGIS_TEST_DATABASE_URL`. GitHub Actions starts PostgreSQL and rejects a test run with skipped cases. Local results and any environment blockers are recorded in [Step 9 verification](docs/STEP9_TEST_VERIFICATION.md).

## Controlled load and provider checks

Two guarded manual utilities are available: the mock-only load runner and the capped OpenAI/Anthropic compatibility runner. Both require explicit confirmation, use synthetic test tenants, and verify usage in the API ledger. They are not run automatically in CI because provider checks can incur charges. See [provider test instructions](docs/LIVE_PROVIDER_TESTS.md) and [load/crash results](docs/FAILURE_TEST_RESULTS.md).

## Provider and admin configuration

Keep provider keys, the API-key pepper, database URLs, metrics credentials, and admin bootstrap values in a secret manager or deployment environment. Never put them in frontend variables or commit `.env`.

| Variable | Purpose |
| --- | --- |
| `AEGIS_MODE` | `production` disables local demo credentials; `local` enables only explicitly supplied synthetic demo tokens. |
| `AEGIS_STORAGE` | `postgres` is required for deployment and workers. |
| `AEGIS_DATABASE_HOST`, `AEGIS_DATABASE_PORT`, `AEGIS_DATABASE_NAME`, `AEGIS_DATABASE_USER`, `AEGIS_DATABASE_PASSWORD` | Structured PostgreSQL settings passed directly to the client. Keep the password in a secret manager for hosted services. |
| `AEGIS_DATABASE_SSL` | Set to `true` for hosted PostgreSQL with TLS and certificate verification. |
| `AEGIS_KEY_PEPPER` | 32 or more characters; required for production API-key hashing. |
| `AEGIS_PLATFORM_ADMIN_USER_IDS` | Comma-separated server-side user IDs permitted to administer cross-tenant platform resources. |
| `OPENAI_API_KEY` | Optional provider key, supplied only to the backend. |
| `OPENAI_API_MODE` | Set to `responses` to use stored OpenAI Responses and lookup-based reconciliation. |
| `ANTHROPIC_API_KEY` | Optional provider key, supplied only to the backend. |
| `AEGIS_METRICS_TOKEN` | Protects `/metrics`; scrape from a private monitoring network. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint, for example `http://otel-collector:4318`. |

See [production deployment](docs/DEPLOYMENT.md) for migrations, worker topology, key bootstrap, TLS, backup and release steps. The current Vercel project hosts only the frontend preview; it is not configured to run PostgreSQL or the long-lived worker processes.

## Repository map

- `frontend/` - static console and runtime API configuration.
- `backend/` - HTTP API, PostgreSQL ledger/control plane, provider adapters, and workers.
- `observability/` - OpenTelemetry Collector, Prometheus alerts, and Grafana dashboard provisioning.
- `docs/adr/`, `docs/runbooks/` - architecture decisions and operator procedures.
- `compose.yaml` - isolated local full-stack demo.
