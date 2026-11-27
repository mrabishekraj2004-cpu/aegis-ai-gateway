# Deployment Guide and Status

## Current deployment status

The repository now has a reproducible local container stack. A production deployment has not been created or validated. The connected Vercel project is configured as a Next.js project and has no database, provider, pepper, or metrics credentials; it cannot run this Node API, PostgreSQL, and persistent background workers as one production system. Do not point real tenants at the static frontend preview.

The full production deployment still needs a selected container runtime with private networking and persistent volumes, a production PostgreSQL database, TLS and domain routing, secret-manager entries, backups, alerts, and a separately managed worker service. No provider key or production database URL was available to this workspace. Creating cloud infrastructure or enabling paid provider traffic is a separate deployment operation.

## Local complete stack

1. Install Docker Desktop or another Docker Compose v2 runtime and start its engine.
2. Run `pwsh -File scripts/init-local-env.ps1` to create an ignored `.env` with random local-only values. The helper refuses to overwrite an existing file and does not print its values.
3. Start services with `docker compose up --build`.
4. Wait for `api`, `frontend`, and `postgres` health checks. The API applies migrations and seeds only synthetic tenants before it listens.
5. Open `http://localhost:4173`; open Grafana at `http://localhost:3000` using the local credentials in `.env`.
6. To inspect service state, run `docker compose ps` and `docker compose logs --tail 100 api workers otel-collector prometheus grafana`.
7. Stop with `docker compose down`. Use `docker compose down --volumes` only when you intend to delete all local demo and monitoring data.

The Compose stack binds browser-facing ports to loopback. It uses local mock mode, browser-visible synthetic demo tokens, and a deliberately low-cost deterministic provider; none of these settings are safe production defaults.

## Production release procedure

Use a container host that supports continuously running Node API and worker processes, private PostgreSQL access, health checks, secret injection, and persistent telemetry storage. Vercel may host a separately integrated frontend, but this repository's standalone console needs a production identity session and a secure same-origin/API arrangement before it can be exposed to real users.

1. Create a production database and a separately owned migration role. Configure the `AEGIS_DATABASE_*` fields in the secret manager, set `AEGIS_DATABASE_SSL=true`, and require TLS in the database provider and network policy.
2. Generate an independent random `AEGIS_KEY_PEPPER` (at least 32 characters), store it once, and limit access to API and worker services.
3. Configure `AEGIS_MODE=production`, `AEGIS_STORAGE=postgres`, `AEGIS_ALLOWED_ORIGIN` to the exact HTTPS frontend origin, and platform-admin user IDs through a reviewed deployment change.
4. Supply provider secrets only to the API and worker services that require them. Start with a dedicated synthetic/test tenant, explicit pricing, and a small hard budget. OpenAI Responses retrieval requires `OPENAI_API_MODE=responses`; Anthropic uncertain requests require provider-console review because the Messages API adapter has no read-back endpoint.
5. Run `node backend/scripts/migrate.mjs` as a one-shot release job. Verify the migration version before starting API or workers.
6. Run at least one API instance and one worker instance against the same PostgreSQL primary. Worker replicas are safe to scale through database claims; measure connection-pool use before increasing replicas.
7. Configure OTLP collector, Prometheus scraping of authenticated `/metrics`, Grafana provisioning, alert delivery, and log retention. Keep monitoring endpoints off the public network.
8. Bootstrap the first control-plane key using `node backend/scripts/create-admin-key.mjs` with one-time environment values, deliver the printed key directly to a secret manager, then remove the bootstrap values. Never save its stdout to CI logs.
9. Verify health, key scope, tenant boundary, exact-limit budget admission, request settlement, worker backlog, database restart persistence, and rollback procedure in staging.
10. Promote the same image digest only after CI, provider smoke tests, capacity tests, crash tests, threat review, and backup restore rehearsal pass.

Production provider tests are not automatically run by CI and must use a separately capped synthetic tenant. The demo defaults in `.env.example` must not be copied to a hosted environment.

## Rollback

Keep the previously released image digest and the previous application version available. Roll application traffic back first. Additive schema migrations must remain backward compatible through the rollback window; schema downgrades are manual, reviewed SQL operations after a backup. Stop new request traffic before restoring a database snapshot. See [database recovery](runbooks/database-recovery.md).
