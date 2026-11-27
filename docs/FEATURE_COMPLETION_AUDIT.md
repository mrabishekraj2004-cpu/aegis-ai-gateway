# Feature completion audit

**Date:** 2026-11-27  
**Source:** Current uncommitted workspace snapshot. This directory has no Git metadata, so there is no commit SHA to identify.  
**Conclusion:** The 25 requested items are **not all complete**. The gateway has substantial feature code, but database, live-provider, operational, and deployment validation is still outstanding.

## Verification run

**Fresh rerun:** Both package syntax checks passed. Backend tests: **25 passed, 0 failed, 9 skipped** (34 total); frontend tests: **14 passed, 0 failed, 0 skipped**. The backend streaming test initially failed because its synthetic tenant was missing from the memory-ledger fixture; the fixture was corrected and the suite then passed. The nine skipped cases are PostgreSQL integration tests; no `AEGIS_TEST_DATABASE_URL` is configured for this run.

| Check | Result |
|---|---|
| Backend `npm run check` | Passed (fresh rerun) |
| Backend `npm test` | 25 passed, 0 failed, 9 skipped (34 total; fresh rerun) |
| Frontend `npm run check` | Passed (fresh rerun) |
| Frontend `npm test` | 14 passed, 0 failed, 0 skipped (fresh rerun) |
| PostgreSQL integration checks | Not run: no `AEGIS_TEST_DATABASE_URL`; all 9 PG tests skipped |
| Local PostgreSQL through Docker | Blocked: Docker CLI is present, but its engine is unavailable (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.`) |
| Separate-process HTTP / real browser | Not verified in this audit |
| Live OpenAI / Anthropic calls | Not verified; no live provider credentials were supplied for this audit |
| Deployment and demo video | Not done |

The GitHub Actions workflow now defines PostgreSQL 16 and fails if a CI run is missing the test database or reports skipped tests. That workflow has not run from this workspace. The provider adapter unit tests use mocked HTTP responses; they do not prove connectivity or compatibility with live provider accounts.

## Status by requested item

| # | Status | Evidence and remaining work |
|---|---|---|
| 1 | **Implemented; production verification pending** | Hashed API keys, scopes, expiry, revocation, rotation, last-used timestamps, membership lookup, and one-time key display are implemented in `backend/src/api-keys.js`, `backend/src/auth.js`, `backend/src/control-plane.js`, and the admin UI. Browser runtime configuration no longer serializes the legacy bearer token. PostgreSQL-backed auth has not been exercised here. |
| 2 | **Implemented; live verification pending** | OpenAI, Anthropic, and mock adapters share `invoke`/`stream` behavior and normalize usage, errors, and cost. Adapter tests use mocked `fetch`; real credentials and live calls remain unverified. |
| 3 | **Implemented; database verification pending** | Routing supports aliases, priorities, deterministic weighted choice, tenant routes/model allowlists, cost/latency ceilings, and a route decision reason. Configuration persistence and request-version association depend on unrun PostgreSQL tests. |
| 4 | **Partial** | PostgreSQL admission evaluates tenant, user, and key quota scopes for daily/monthly request, token, cost, and concurrency limits in the reservation transaction. There is no separate workspace entity/limit layer; tenant is currently the organizational scope. Atomic behavior is unverified without PostgreSQL. |
| 5 | **Partial** | A durable worker claims active, stale in-progress, and reconcile-required reservations, supports safe release/settlement, retries, and dead letters. The OpenAI and Anthropic adapters do not yet implement provider-specific reconciliation queries, so those unknown outcomes retry and may reach the DLQ. Worker/PostgreSQL tests are skipped locally. |
| 6 | **Implemented in schema/code; database verification pending** | Append-only ledger events and mutation-blocking triggers exist. Reservations and budget views are projected from ledger events, and billing outbox rows are written with ledger events in the same transaction. Migration and concurrency checks are unrun. |
| 7 | **Partial** | Pricing versions include provider, model, region, unit, effective dates, and version references in quotes/settlements. Provider-reported cost is retained in event payloads, but a completed mismatch alert/review flow is not verified. |
| 8 | **Implemented in code; end-to-end verification pending** | SSE, disconnect signals, provider abort signals, stream limits, token accounting, and partial settlement are implemented. No real browser/provider stream or disconnect test was run. |
| 9 | **Partial** | Timeout handling, circuit state, active-call limits, health reporting, backoff, and failover rules exist. Failover is limited to outcomes known not to have executed; there is no independent health-check scheduler or production soak test. |
| 10 | **Partial** | Tenant/user/key quota counters, `Retry-After`, bounded per-process provider queues, queue cancellation, maximum queue depth, and overload rejection are implemented and unit-tested. Queue state is process-local rather than shared across replicas; explicit region/consistency decisions and cross-instance load-shedding guarantees are not documented. |
| 11 | **Partial** | PostgreSQL transactions insert ledger events and outbox rows together; an outbox worker class supports idempotency keys and retry tracking. No concrete publisher/consumer is wired into a running process or deployment. |
| 12 | **Implemented as a modular monolith** | Gateway/data-plane handling and control-plane APIs/storage are separated into modules while sharing one backend process. |
| 13 | **Implemented in UI/code; role behavior not browser-tested** | Admin navigation and views cover tenants, members/users, keys, routes, quotas, budgets, provider health, pricing, reconciliation, and audit events. Admin mutations require owner/admin role and control-write scope. |
| 14 | **Partial** | Draft creation, validation, publication, effective-time scheduling, and version IDs exist. A clear administrator rollback endpoint/flow is absent; the `rolled_back` state is not a complete rollback UX. |
| 15 | **Partial** | Key, membership, route, pricing, quota, and tenant mutations write audit actor/reason/time/correlation fields. Reconciliation decisions and all authentication/budget-adjustment cases are not consistently audited. |
| 16 | **Partial** | OpenTelemetry SDK/exporters, request context, spans, counters, and histograms are implemented, and prompt/key values are omitted from span attributes. Structured logging and a full trace/metric verification remain incomplete. |
| 17 | **Partial** | Grafana dashboard JSON and Prometheus alert rules now exist under `observability/`. SLO targets/runbooks are not documented, and the dashboard, alerts, and OpenTelemetry export have not been exercised against live collectors. |
| 18 | **Not built** | No operational database guide for pool monitoring, transaction timeouts, retention, query-plan validation, rollback procedure, or partitioning strategy is present. |
| 19 | **Not built** | Strong-consistency boundaries, budget home region, regional failover, partition behavior, and disaster-recovery procedure are not documented or tested. |
| 20 | **Not built as a threat model** | Some mitigations exist in code, but there is no threat-to-mitigation-to-test document covering the requested attack set. |
| 21 | **Partial** | CI config includes secret scanning, npm audit, CodeQL, Trivy filesystem scanning, and release image SBOM/provenance/signing steps; Docker images run as non-root. Trivy is not scanning built images, action/security workflow execution is unverified, and GitHub production-environment protection must be configured in repository settings. |
| 22 | **Configured; execution pending** | GitHub Actions starts PostgreSQL 16, requires `AEGIS_TEST_DATABASE_URL`, and checks for zero skips. Nine PostgreSQL integration scenarios now exist, including crash recovery and quota cases, but no CI run has executed them. |
| 23 | **Partial** | A database-backed recovery test models a crash before provider start and after provider success; a guarded synthetic load script exists. Actual process termination at every requested point, injected database failures, delay/duplicate/network fault matrix, and load run were not performed. |
| 24 | **Not built** | The requested ADRs and operational runbooks are absent. |
| 25 | **Not built** | No live mock deployment or walkthrough video showing the requested scenarios exists. |

## Deployment handoff

Do not treat this snapshot as production-ready. Before deployment, run the PostgreSQL workflow with zero skips, verify migrations and restart persistence, complete live HTTP/browser and provider checks, close the partial/missing items above, and configure the repository's protected production environment. The live mock deployment and video still require a deployment run; neither was performed here.
