# Feature completion audit

**Updated:** 2026-11-27  
**Source:** PR stack based on repository `main` at `3790b9eb482cf73d913aaf563cb21c97b99a073d`. This workspace has no Git metadata. PR #1 and PR #2 have passing CI; the documentation/container PR is being prepared and its CI is pending.  
**Conclusion:** The high-impact work has meaningful implementation progress but is not all complete or production-ready. Provider limitations, live validation, and a hosted full-stack deployment remain open.

## Verified checks

| Check | Result |
| --- | --- |
| PR #1 PostgreSQL CI | Passed with zero skipped PostgreSQL tests. |
| PR #2 CI and Security workflows | Passed. |
| Backend syntax, TypeScript, ESLint | Passed locally on the PR #2 snapshot. |
| Backend tests | Latest local snapshot: 30 passed, 0 failed, 10 skipped because this runner had no test database URL. The same PostgreSQL checks passed in PR #1 GitHub CI with zero skips. |
| Frontend syntax and tests | 14 passed, 0 failed, 0 skipped in the last completed run. |
| Compose and observability YAML / Grafana JSON parsing | Passed in the PR #3 workspace. |
| Docker stack startup | Not run: the Docker CLI is installed, but the Docker Desktop engine pipe is missing. |
| Real OpenAI / Anthropic calls | Not run: provider credentials are not configured in this workspace. |
| Browser-to-API live flow and recording | Pending the local container stack; no video has been recorded. |

The latest local test polling was stopped by automatic approval review after the runner attempted telemetry egress to `dc.services.visualstudio.com`; this request was not retried. Earlier completed runs and GitHub Actions results are reported above. The PostgreSQL GitHub workflow rejects any run with skipped integration tests.

## Ten requested workstreams

| # | Status | Evidence and remaining work |
| --- | --- | --- |
| 1. Cross-tenant control-plane authorization | **Implemented; CI passed** | Global tenant and pricing routes require a server-configured platform-admin user identity. Tenant administrators are denied before store access; tests cover read and write denial. Production admin membership and SSO/MFA still need operational configuration. |
| 2. Non-stream cancellation and provider reconciliation | **Partial** | HTTP disconnect abort reaches non-stream provider fetch; uncertain outcomes keep reservations pending. OpenAI Responses mode stores and retrieves response IDs. Chat Completions and Anthropic Messages do not have adapter read-back support and require provider-log/manual reconciliation. |
| 3. Outbox/reconciliation workers | **Code wired; deployment pending** | `backend/workers.mjs` runs both workers; Compose defines an independent worker service. The outbox currently materializes to an internal integration-events table; hosted queue/webhook delivery is not implemented. Compose was not launched because the Docker engine was unavailable. |
| 4. Lockfiles, type checking, and linting | **Backend complete; frontend tooling partial** | Lockfiles, `npm ci`, backend TypeScript checks, and ESLint are in PR #2. Frontend syntax/tests remain in CI; frontend lint was not added after automatic approval review blocked its dependency-install attempt due telemetry egress. |
| 5. Full deployment with PostgreSQL and telemetry | **Local deployment definition added; not deployed** | Compose includes PostgreSQL, API, worker, frontend, OTLP collector, Prometheus, and Grafana. The Vercel project is a frontend preview and cannot run the database and continuous workers. Production host, secrets, TLS, and runtime configuration are absent. |
| 6. Live provider compatibility under small caps | **Pending** | Adapter tests use mocked HTTP. No live OpenAI/Anthropic credentials are configured, so no paid compatibility request was sent. |
| 7. Load/crash/failure-injection results | **Pending** | Existing bounded load utility and database recovery tests are available. No process-kill matrix, load run, database outage injection, or published measurements were produced because Docker is unavailable. |
| 8. Threat model, ADRs, SLOs, capacity, runbooks | **Documentation added; measurements pending** | PR #3 adds threat-to-mitigation mapping, six ADRs, initial SLOs and provisional capacity, and outage/stuck reservation/key/database runbooks. Targets and sizing are explicitly unmeasured. |
| 9. README and end-to-end demo | **README rewritten; recording pending** | README explains scope, local stack, and limits; a 3-minute capture script is documented. The video is not recorded because the stack could not be started. |
| 10. Focused PR workflow | **In progress** | PR #1 authorization/recovery changes and PR #2 CI/tooling changes are separate and green. PR #3 covers containers, observability provisioning, README, deployment docs, and operational documents. Do not merge the stack until required review checks pass. |

## Deployment handoff

Keep the production deployment blocked until staging has real PostgreSQL, provider credentials behind a hard synthetic-tenant cap, a working worker runtime, telemetry, and verified restart/crash/load behavior. Anthropic Messages and OpenAI Chat Completions uncertain outcomes must remain reserved for authoritative manual reconciliation. See [deployment guide](DEPLOYMENT.md), [threat model](THREAT_MODEL.md), [SLO and capacity plan](SLOS_CAPACITY.md), and [demo recording guide](DEMO_RECORDING.md).
