# Feature completion audit

**Updated:** 2026-11-27  
**Source:** PR stack based on repository `main` at `3790b9eb482cf73d913aaf563cb21c97b99a073d`. PRs #1–#5 CI/Security passed. PR #6 audited dead-letter resolution passed CI and Security at `4b32405fef6626a204b321cdd3db4fa3f4aa118a`. All six PRs remain open and unmerged.  
**Conclusion:** The high-impact work has meaningful implementation progress but is not all complete or production-ready. Provider limitations, live validation, and a hosted full-stack deployment remain open.

## Verified checks

| Check | Result |
| --- | --- |
| PR #1 PostgreSQL CI | Passed with zero skipped PostgreSQL tests. |
| PR #2 CI and Security workflows | Passed. |
| PR #3 CI and Security workflows | Passed after removing unused npm tooling from the frontend runtime image. |
| PR #4 CI | Passed in GitHub Actions: syntax, TypeScript, ESLint, backend tests (43 passed, 0 failed, 0 skipped), PostgreSQL integration included, and frontend tests (14 passed, 0 failed, 0 skipped). |
| PR #4 Security workflow | Passed. |
| PR #5 tenant first-owner bootstrap | Passed in GitHub Actions: PostgreSQL integration included, 45 backend tests passed, 0 failed, 0 skipped; frontend 15 passed, 0 failed, 0 skipped; Security passed. |
| PR #6 manual reconciliation resolution | Passed in GitHub Actions: PostgreSQL integration included, 47 backend tests passed, 0 failed, 0 skipped; frontend 16 passed, 0 failed, 0 skipped; syntax, type, lint, and Security passed. |
| Backend syntax, TypeScript, ESLint | Passed in PR #6 GitHub Actions. |
| Backend tests | PR #6 GitHub Actions: 47 passed, 0 failed, 0 skipped with PostgreSQL service. |
| Frontend syntax and tests | PR #6 GitHub Actions: 16 passed, 0 failed, 0 skipped. |
| Compose and observability YAML / Grafana JSON parsing | Passed after the final PR #3 configuration changes. |
| Docker stack startup | Not run: Docker Desktop engine pipe npipe:////./pipe/dockerDesktopLinuxEngine is unavailable (The system cannot find the file specified.). |
| Real OpenAI / Anthropic calls | Not run: provider credentials are not configured in this workspace. |
| Browser-to-API live flow and recording | Pending the local container stack; no video has been recorded. |

The latest local test polling was stopped by automatic approval review after the runner attempted telemetry egress to `dc.services.visualstudio.com`; the payload was not established and the request was not retried. Earlier completed runs and GitHub Actions results are reported above. The PostgreSQL GitHub workflow rejects any run with skipped integration tests.

## Ten requested workstreams

| # | Status | Evidence and remaining work |
| --- | --- | --- |
| 1. Cross-tenant control-plane authorization | **Implemented; CI passed** | Global tenant and pricing routes require a server-configured platform-admin user identity. Tenant administrators are denied before store access; tests cover read and write denial. Production admin membership and SSO/MFA still need operational configuration. |
| 2. Non-stream cancellation and provider reconciliation | **Partial; manual DLQ resolution added** | HTTP disconnect abort reaches non-stream provider fetch; uncertain outcomes keep reservations pending. OpenAI Responses mode stores and retrieves response IDs. PR #6 adds a tenant-scoped, audited admin action to settle or release dead-letter reservations from authoritative evidence. Chat Completions and Anthropic Messages still lack automatic provider read-back. |
| 3. Outbox/reconciliation workers | **Code wired; deployment pending** | `backend/workers.mjs` runs both workers; Compose defines an independent worker service. The outbox currently materializes to an internal integration-events table; hosted queue/webhook delivery is not implemented. Compose was not launched because the Docker engine was unavailable. |
| 4. Lockfiles, type checking, and linting | **Backend complete; frontend tooling partial** | Lockfiles, `npm ci`, backend TypeScript checks, and ESLint are in PR #2. Frontend syntax/tests remain in CI; frontend lint was not added after automatic approval review blocked its dependency-install attempt due telemetry egress. |
| 5. Full deployment with PostgreSQL and telemetry | **Local deployment definition added; not deployed** | Compose includes PostgreSQL, API, worker, frontend, OTLP collector, Prometheus, and Grafana. The Vercel project is a frontend preview and cannot run the database and continuous workers. Production host, secrets, TLS, and runtime configuration are absent. |
| 6. Live provider compatibility under small caps | **Guarded harness added; execution pending** | The manual script preflights distinct synthetic tenants, limits each cap to at most $0.34, uses max_tokens 8, verifies routing and the settled usage entry, and does not retry. No provider credentials or staging gateway keys are configured. See docs/LIVE_PROVIDER_TESTS.md. |
| 7. Load/crash/failure-injection results | **Guarded mock runner added; runtime results pending** | The mock runner verifies health reports only mock, preflights the full planned spend, limits the run to 20 requests and $6.80, and verifies request IDs, costs, and settled budget. No load benchmark or process-level failure matrix was run because Docker is unavailable. See docs/FAILURE_TEST_RESULTS.md. |
| 8. Threat model, ADRs, SLOs, capacity, runbooks | **Documentation added; measurements pending** | PR #3 adds threat-to-mitigation mapping, six ADRs, initial SLOs and provisional capacity, and outage/stuck reservation/key/database runbooks. Targets and sizing are explicitly unmeasured. |
| 9. README and end-to-end demo | **README rewritten; recording pending** | README explains scope, local stack, and limits; a 3-minute capture script is documented. The video is not recorded because the stack could not be started. |
| 10. Focused PR workflow | **In progress** | PR #1 authorization/recovery, PR #2 CI/tooling, PR #3 deployment/observability/docs, PR #4 guarded verification utilities, PR #5 tenant onboarding, and PR #6 audited dead-letter resolution are separate. All remain open for focused review. |

## Detailed audit of the 25 requested features

| # | Status | Current implementation and remaining work |
| --- | --- | --- |
| 1. Production API keys | Implemented; identity-provider setup remains | Keys are generated server-side, pepper-hashed, scoped, expiring, revocable, rotatable, tenant-member-bound, and last-used tracked. Human registration, SSO, MFA, and invitation delivery are not included. |
| 2. OpenAI, Anthropic, and mock adapters | Implemented; live compatibility pending | Adapters normalize calls, streaming, errors, usage, and cost. Only OpenAI Responses supports automatic lookup reconciliation; the PR #6 admin flow enables evidence-backed manual resolution for other uncertain outcomes. Live provider checks await credentials and capped staging tenants. |
| 3. Policy-based routing | Implemented | Versioned aliases, priorities, weights, tenant routes, cost/latency constraints, and recorded route decisions are present. |
| 4. Tenant, workspace, user, and time-window quotas | Partial | Tenant monthly budgets and user/key daily/monthly request, token, cost, and concurrency quotas reserve atomically. Workspace-scoped limits are not modeled. |
| 5. Durable reconciliation | Partial | Workers reclaim stale jobs, retry, settle known outcomes, release confirmed non-execution, and dead-letter unresolved cases. PR #6 adds a tenant-scoped, audited operator action that atomically settles verified usage or releases confirmed non-execution. Automatic lookup remains limited to OpenAI Responses. |
| 6. Immutable ledger | Partial | Application accounting writes append-only events and projects balances from them. The database does not yet reject direct UPDATE/DELETE of ledger rows. |
| 7. Versioned pricing | Implemented | Pricing records include provider, model, region, unit, version, and effective dates; settlements retain pricing/config versions and track provider-cost mismatch. Live price inputs are not independently verified. |
| 8. Streaming and cancellation | Implemented; tested in CI | SSE, disconnect cancellation, response-size limits, token accounting, and partial settlement have automated coverage. |
| 9. Provider reliability and failover | Implemented; live behavior pending | Timeouts, circuits, concurrency pools, bounded queues, backoff, health state, and safe failover are implemented. Paid-provider failure behavior is not live-tested. |
| 10. Request/token/concurrency limits and load shedding | Partial | Tenant and user/key quotas plus provider queue bounds and Retry-After responses are implemented. Workspace scope and Redis are absent; PostgreSQL is the documented budget authority. |
| 11. Transactional outbox | Partial | Billing events and outbox records are written in the same transaction; worker retries are idempotent. Delivery currently ends in an internal integration-events table; no external consumer is deployed. |
| 12. Control/data plane boundaries | Implemented as a modular monolith | Authentication, admission, routing, provider calls, settlement, and administrative APIs have separate modules. |
| 13. Administration screens | Implemented; identity integration remains | Screens cover tenants, members, API keys, routes, budgets/quotas, pricing, provider health, reconciliation, and audit. PR #5 adds first-owner onboarding; PR #6 adds keyboard-accessible dead-letter resolution forms. |
| 14. Draft, validate, publish, rollback, schedule | Partial | Draft validation, versioned publish, and effective-time scheduling exist. There is no explicit rollback action/API. |
| 15. Administrative audit trail | Partial | Key, membership, route, quota, pricing, tenant, and billing actions record actor, reason, timestamp, and correlation. PR #6 records manual reconciliation actor, reason, evidence reference, receipt, usage, pricing/config versions, and correlation ID in the settlement transaction. Explicit routing rollback audit/action remains open. |
| 16. Logs, traces, and metrics | Partial | OpenTelemetry spans and metrics exist, with prompt/response data excluded by default. End-to-end production trace verification and automated redaction regression tests remain. |
| 17. SLOs, Grafana, and alerts | Defined; not measured | Initial objectives, dashboards, and alerts exist. No hosted measurements establish the targets. |
| 18. Database operations and scale | Partial | Pool bounds, connection timeout, indexes, migrations, and capped audit pagination exist. Pool/lock monitoring, transaction timeouts, query-plan verification, retention, rollback procedures, and partitioning are not validated end-to-end. |
| 19. Regional consistency and recovery | Documented; disaster recovery pending | PostgreSQL is the single budget authority and the design fails closed. Regional failover and restore drills have not been tested. |
| 20. Threat model | Implemented; production review pending | Cross-tenant access, stolen keys, replay, prompt/log leakage, SSRF, budget exhaustion, and malicious provider responses have mitigations and test references. Egress controls and production role review remain operational tasks. |
| 21. Supply-chain security | Partial | CI includes dependency audits, secret scanning, CodeQL, container scans, and release image SBOM/provenance/signing. Production environment protection settings have not been verified. |
| 22. PostgreSQL CI with zero skips | Passed | PR #6 CI ran 47 backend checks with PostgreSQL enabled and 0 skips, including migrations, concurrent reservations, settlement, isolation, restart persistence, and manual reconciliation. |
| 23. Crash/load/failure injection | Pending runtime execution | Guarded mock load utility and unit failure tests exist. Process-kill checkpoints, database/network fault matrix, and benchmark measurements were not run because the Docker engine is unavailable. |
| 24. ADRs and runbooks | Implemented | Six ADRs and runbooks for database recovery, key compromise, provider outage, and stuck reservations are present. |
| 25. Live mock deployment and demo video | Pending | A local Compose stack is defined, but it has not started in this runner; no hosted full-stack mock deployment or video recording exists. |

## Deployment handoff

Keep the production deployment blocked until staging has real PostgreSQL, provider credentials behind a hard synthetic-tenant cap, a working worker runtime, telemetry, and verified restart/crash/load behavior. Anthropic Messages and OpenAI Chat Completions uncertain outcomes must remain reserved for authoritative manual reconciliation. See [deployment guide](DEPLOYMENT.md), [threat model](THREAT_MODEL.md), [SLO and capacity plan](SLOS_CAPACITY.md), and [demo recording guide](DEMO_RECORDING.md).
