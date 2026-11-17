# Aegis AI Gateway verification

## Scope

Executed November 16, 2026 Eastern time. The available checkout contained the text chat gateway, migration `001_core`, and the first Next.js console. The newer frontend integration and Stage 05 reliability sources were absent. Results apply to the source packaged with this report.

The audit follows `BLUEPRINT.md` §§8–12 and §§15–22, the backend checklist, frontend README, migrations, tests, Dockerfile and Compose profiles. No Git history or existing workflow definition was present in the available checkout.

## Hosted dashboard

On November 17, 2026, the [public Vercel dashboard](https://aegis-ai-gateway.vercel.app/) opened without signing in, displayed labeled sample telemetry, and completed an in-browser playground sample. Cloud gateway deployment is pending. The gateway-backed checks below used local PostgreSQL and Redis.

## Verification matrix

| Feature | Expected behavior | Test method | Actual result | Status | Outstanding risks |
| --- | --- | --- | --- | --- | --- |
| Chat, model catalog, usage and health | Valid JSON and SSE, bounded input and explicit errors | API integration against real PostgreSQL and Redis, Uvicorn and browser smoke | Credential-free mock succeeded. Streaming delivered its terminal event. Usage and request IDs reflected actual replies | Pass | Managed provider edge behavior |
| Tenant identity and administration | Enforce scoped keys and OIDC membership, isolate usage and database rows | Foreign tenant and cursor, expired tokens, revoked keys, CORS and role tests | Invalid key, expired token, spoofed tenant and unsafe origins were rejected. Authorized policy edits succeeded | Pass | Managed OIDC and credential rotation |
| Routing and provider adapters | Deterministic scoring, capability and budget gates, protocol normalization | Golden inputs, synthetic vendor responses, persisted route evidence | Both vendor simulations normalized attempts and usage. The mock route and price were recorded | Pass | Live provider and certified billable-bound validation |
| Distributed reliability | Shared limits, fenced breaker probes and bounded dispatch | Two gateway instances and Redis clients, controlled outages and timeout injection | Quota applied across replicas. Half-open probes fenced stale results. True cancellation and partial stream failures did not replay upstream | Pass | Redis promotion and later configurable controls |
| Accounting and cleanup | Durable holds, bounded receipts and consistent disposition | Concurrent ceiling checks, reconciliation and request disposition assertions | Concurrent spend stayed within the cap. Recovery preserved uncertain exposure. Completed denials were classified as failures | Pass | Real invoice reconciliation |
| Security tooling | Detect known vulnerabilities and exposed credentials | Pinned dependency audit, redacted scanner, container review | Runtime dependencies scanned clean. Tooling advisories were fixed. Static container checks passed | Local pass | Container OS packages, running image and Git history |
| Console | Build, navigate and show recorded data with distinct demo state | Unit tests, Chromium at six widths, axe and live gateway | Static export and eight routes passed. Browser verified invalid and valid credentials, streamed output, usage, policy publish and disable | Pass for available console | Newer session, key, audit, routing analytics and budget UI source |
| Performance | Measure mock throughput, errors and scorer overhead | Two local processes and closed-loop Locust | Repeatable 4- and 16-user profiles with final histograms. Fixed 16-user run recorded 1,881 responses and no failures | Benchmark pass | Production load, soak, egress and failover targets |
| CI and packaging | CI definitions use reproducible tasks and restricted permissions | Workflow lint, Compose static checks and equivalent local commands | Three-job workflow added and actionlint passed. Container builds could not start locally | Partial | Hosted workflow and image build/runtime evidence |

## Commands and results

| Command or check | Observed result |
| --- | --- |
| `pytest -q backend/tests --tb=short` with the hash-locked test environment | 52 passed on Python 3.12.14 and 52 passed on Python 3.13.5 |
| `coverage run --branch --source=aegis -m pytest -q backend/tests` and `coverage report` | 78% combined statement/branch coverage for the gateway package. Coverage executed in pytest and excludes the separately launched Uvicorn and worker processes |
| `alembic -c backend/alembic.ini upgrade head` and `alembic -c backend/alembic.ini check` | Fresh database migrated. Check returned `No new upgrade operations detected.` |
| `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` in `frontend` | TypeScript and ESLint passed. Vitest reported 12 passing tests. Next.js produced the static production export |
| `python scripts/console_smoke.py --logs …` | 6 Playwright tests passed using the built export, real localhost gateway, an ephemeral scoped key and a signed OIDC fixture. Responsive checks covered six widths. Automated axe found zero violations across all eight demo routes in both themes |
| Ruff, `sh -n`, actionlint, Hadolint and `docker compose --profile test config --quiet` | Passed for the changed source, provisioning script, workflow, Dockerfile and Compose declarations |

The full local process equivalent launched PostgreSQL 17.11, Redis 7.0.15, Uvicorn, the reconciliation worker and the Next.js static export. The browser test used mock inference only. The worker had a distinct role and remained running throughout the smoke. Pytest separately exercised recovery, rejection and downstream cancellation with injected faults. Managed OIDC and hosted GitHub Actions runs were outside the local fixture.

## Confirmed defects and fixes

The three regression tests below all failed against a temporary copy with the original request path. The full suite passed after the fixes.

| Defect | Baseline observation | Change and verified result |
| --- | --- | --- |
| Unauthenticated inference read the submitted body | An unauthenticated ASGI request consumed its input iterator | Check the bearer credential and write scope before reading the body. The 401 leaves the test iterator unread |
| Unlisted aliases bypassed inference quota | An unlisted request returned 404, then both replicas accepted one of the two remaining requests | Acquire the tenant lease and debit shared quota before catalog lookup. With two available credits, the unknown alias consumes one. Only one of the next two requests succeeds |
| A delivered denial became a cancellation | A completed 429 left a durable `cancelled/client_disconnected` disposition | Ignore disconnect notifications once the terminal response is written. The record now retains `failed/budget_exceeded`. Disconnect before terminal delivery still closes upstream and releases leases |
| Dark routing text could inherit a light-theme foreground | The target rows did not explicitly bind their text to the active theme | Use the existing foreground token in routing graph labels. The browser axe checks passed in both themes |

## Security audit

| Area | Finding and disposition |
| --- | --- |
| Python dependencies | The locked runtime scan returned zero known vulnerabilities. The test lock reported a duplicate scanner entry for one pytest tmpdir advisory. Upgraded from pytest 8.4.2 to 9.2.0 and reran the test-lock scan with zero findings. [CVE-2025-71176](https://github.com/advisories/GHSA-6w46-j5rx-g56g) |
| JavaScript dependencies | Production audit returned zero findings. Full audit initially reported seven moderate entries stemming from one minimatch advisory in the TypeScript ESLint chain. A targeted override to 11.0.8 cleared the full audit. Type checking, lint, tests and production export passed with the override. [CVE-2026-118764](https://github.com/advisories/GHSA-g3hv-75wg-m249) |
| Secret scanning | Gitleaks 8.30.1 scanned 98 source files and the built static export with the default rules and an Aegis key rule. The initial source alert was a hard-coded test fixture value. Replaced it with generated per-test entropy. The final source and export scans returned zero findings. Git history was unavailable for a local scan |
| Identity and sensitive logs | Key HMAC storage, expiry and revocation, tenant-bound cursor and scope checks, metric bearer separation, and redacted exception behavior were verified by tests. The runtime role cannot read key digests by querying the key table. Request IDs correlate logs and traces. The browser stores its bearer in memory and rejects redirects |
| Container boundary | The Dockerfile drops root for the runtime and uses a Python package lock with hashes. Compose binds the gateway port to loopback and keeps PostgreSQL and Redis private. Hadolint and Compose parsing passed. Docker was unavailable, and a rootless BuildKit attempt failed because the sandbox denied Unix socket creation. Image contents, OS advisories and provenance remain unverified |

The new GitHub Actions workflow defines backend lint, container build and database/Redis tests, frontend type checks, lint, tests, build and headless browser checks, and security scans. Third-party actions use commit SHAs and checkout credentials are not persisted. The hosted browser job runs the offline cases because it has no live fixture credentials. The local smoke covered the live cases. [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)

## Performance and remaining gates

The request-path changes move rejection ahead of expensive parsing or routing. They preserve the scoring formula, transaction ordering, provider pools and caching semantics. A histogram measures the deterministic routing CPU path separately from network and catalog work. The fixed 16-user profile achieved **94.17 requests/s**, with **p50 150 ms, p95 340 ms, p99 400 ms**, zero errors and mean scorer time of approximately **53 µs**. The comparable baseline delivered 78.03 requests/s at p95 370 ms. These are observations from two short trials. [Benchmark results](benchmarks/RESULTS.md)

- Verify the newer integrated checkout to close the Stage 05 and dashboard-management acceptance gates. The available UI exposes the live mock, usage and policy endpoints and explicitly labels broader unsupported views.
- Run the hosted workflow and verify container build, hardened runtime and OS-package findings on an environment with Docker. Scan actual Git history.
- Qualify external providers, a managed identity provider, Redis promotion, long-lived stream load, production performance, and operational recovery separately.

**Publication assessment**  
The available snapshot passes the offline functional checks. Approval for publication of the fully integrated project remains pending verification of the newer source and the hosted workflow and container gates.

## Reproduce the live browser checks

Build the console with `npm --prefix frontend ci` and `npm --prefix frontend run build`. Install Playwright Chromium or set `CHROMIUM_PATH` to a compatible binary. With the backend installed and a migrated disposable PostgreSQL database and Redis ready, export `AEGIS_TEST_DATABASE_URL`, `AEGIS_TEST_ADMIN_URL`, `AEGIS_TEST_REDIS_URL`, and optionally `AEGIS_TEST_WORKER_URL`. Then run `python scripts/console_smoke.py --logs .aegis-qa-work/console-run` from the repository root. The helper provisions two unique tenants, generates a temporary RSA key and uses only loopback services and mock inference.
