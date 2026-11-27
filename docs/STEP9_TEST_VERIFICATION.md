# Step 9 — Test Verification

> **Follow-up audit (2026-11-27):** This file records the earlier Step 8 source snapshot and is not a verification record for the production-feature changes that followed. The current feature audit is [FEATURE_COMPLETION_AUDIT.md](FEATURE_COMPLETION_AUDIT.md). On that newer snapshot, backend checks passed with **22 passed, 0 failed, 9 skipped**; frontend checks passed with **14 passed, 0 failed, 0 skipped**. PostgreSQL tests remain unrun, and no live HTTP/browser/provider verification was completed. Treat the historical counts and source digest below as historical only.

**Date:** 2026-11-27  
**Outcome:** **Blocked for Step 10 deployment.** Frontend and backend suites pass at the Step 8 baseline. Live browser/API verification and all seven PostgreSQL integration checks remain pending because this workspace cannot reach loopback sockets, `git.chatgpt-team.site`, or the npm registry.  
**Scope:** No gateway or frontend source fixes were made. A local static demo snapshot was committed and packaged for the existing private Site, but source push and publication were blocked. With the user's approval, an isolated Neon test project was created; no schema or test data has been written to it.

## Tested source snapshot

This workspace has no Git metadata, so there is no branch or commit to report. The tested standalone source snapshot is identified by this SHA-256:

```text
71d5d772eaf501fd510884b9e7d99b84c8263645bd7060d0d31d27a5a762da42
```

The digest is over a UTF-8 manifest containing each sorted relative path and that file's lowercase SHA-256, for 34 files under `backend/`, `frontend/`, and `docs/`; `STEP9_TEST_VERIFICATION.md` was excluded. Runtime: Node.js `v24.17.0`, npm `11.13.0`, Windows PowerShell. The frontend and backend files tested were the standalone sources described by the Step 7 and Step 8 handoffs.

## Commands and suite results

Run from `frontend/` (Windows PowerShell; actual command names used):

```powershell
npm.cmd run check
npm.cmd test
```

Both commands passed. Frontend suite: **14 passed, 0 failed, 0 skipped**.

Run from `backend/`:

```powershell
npm.cmd run check
npm.cmd test
```

Both commands exited successfully. Backend suite: **18 passed, 0 failed, 7 skipped** (25 tests total). The skipped cases are the seven PostgreSQL integration tests listed below. Combined suite result: **32 passed, 0 failed, 7 skipped**. Syntax checks passed for the files included in each package's `check` script.

The 18 backend passes include authenticated request behavior, exact-limit admission and denial, tenant scoping, duplicate settlement, pending provider reconciliation, local CORS preflight behavior, and explicit storage-mode failure behavior. The frontend's 14 passes include the in-process adapter-to-gateway flow and confirmation that an API/network error does not silently return fixture data. These suite results do not establish separate-process HTTP or browser behavior.

## PostgreSQL dependency and database checks

From `backend/`, the declared dependency installation was attempted:

```powershell
npm.cmd install --ignore-scripts --no-audit --no-fund
```

It failed with `ENOTFOUND` while resolving `registry.npmjs.org` (`getaddrinfo ENOTFOUND`). The offline retry, `npm.cmd install --offline --ignore-scripts --no-audit --no-fund`, failed with `ENOTCACHED`; the package is not in the local npm cache. `pg` is not installed and no `package-lock.json` was produced.

After the user authorized a disposable database, a new isolated Neon project was created: `aegis-step9-disposable-20261127` (project ID `noisy-recipe-11419826`), with branch `step9-test` and database `aegis_step9`. Its connection string was kept in session memory and is not included here. Migrations and tests have not run because the Node `pg` driver could not be installed and this workspace cannot make database socket connections.

| PostgreSQL integration check | Result |
|---|---|
| Fresh schema migration and idempotent rerun | Skipped |
| Persistence across independent pool close/reopen | Skipped |
| Authenticated tenant overview isolation | Skipped |
| Exact-limit admission and pre-provider denial | Skipped |
| Admission concurrency across independent PostgreSQL sessions | Skipped |
| Idempotent settlement and single usage entry | Skipped |
| Provider failure leaves reconciliation reservation without usage | Skipped |

Result: **0 passed, 0 failed, 7 skipped / not executed.** PostgreSQL migration, independent-connection admission, tenant isolation, restart persistence, and settlement durability remain unverified.

## Separate-process HTTP and browser attempt

The Step 8 local startup configuration was attempted with `AEGIS_MODE=local`, `AEGIS_STORAGE=memory`, `AEGIS_ALLOWED_ORIGIN=http://127.0.0.1:4173`, and API URL `http://127.0.0.1:4174`. Fresh synthetic token values were generated only in the process environment and were not recorded. Both `npm start` commands printed their expected listening messages:

```powershell
# backend/
$env:AEGIS_MODE = 'local'
$env:AEGIS_STORAGE = 'memory'
$env:AEGIS_ALLOWED_ORIGIN = 'http://127.0.0.1:4173'
npm start

# frontend/
$env:AEGIS_API_BASE_URL = 'http://127.0.0.1:4174'
$env:AEGIS_LOCAL_DEMO = 'true'
npm start
```

The following loopback probes were attempted while the processes were running:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:4174/healthz' -TimeoutSec 4
Invoke-WebRequest -Uri 'http://127.0.0.1:4173/?mode=api' -TimeoutSec 4
```

Both failed before receiving an HTTP response with: **"An attempt was made to access a socket in a way forbidden by its access permissions."** The in-app browser was opened at `http://127.0.0.1:4173/?mode=api`; it first reported `net::ERR_CONNECTION_REFUSED` and, after the foreground startup attempt, `net::ERR_CONNECTION_TIMED_OUT`. In this turn, the frontend fixture server also printed its listening URL, but a direct loopback GET was blocked by the same socket permission error. This is an environment socket/browser-access blocker; it is not evidence of an HTTP response from either service. The local fixture preview is currently running at `http://127.0.0.1:4173/` for the user to try, but reachability from the browser is unverified.

Therefore, the live browser-to-API request, CORS response headers, missing/invalid bearer behavior over HTTP, and the end-to-end UI scenarios were **not observed**. In particular, no claim is made that an unapproved origin received no CORS permission or that authentication denial was verified independently of CORS on a live response. The existing backend tests for unlisted-origin preflight and missing/invalid credentials passed in process, but live verification remains pending.

## ChatGPT Sites demo publication

The existing private Aegis Site is still unpublished. Its local static snapshot is in `sites/aegis-gateway-dashboard/`; the initial local source commit is `c65d2100dd239c25df250ddc1b6fb9afba40e205`, and the prepared deployment archive is `outputs/aegis-gateway-demo.tar.gz`. The archive contains `.openai/hosting.json` and the static `dist/` output. A read-only Git source check failed with `Could not resolve host: git.chatgpt-team.site`; no source push, saved version, or deployment occurred. The user-level `network_access = true` setting does not overcome the managed workspace network restriction.

To publish this demo, an authorized machine or CI runner must resolve and reach `git.chatgpt-team.site` over HTTPS, push the exact local commit, then save and deploy it through Sites. Keep the current private audience.

## Frontend-only Vercel preview

To let the user review the UX while ChatGPT Sites publishing is blocked, the six static frontend files from `sites/aegis-gateway-dashboard/dist/` were deployed as a Vercel preview to the existing `aegis-ai-gateway` project. Vercel reports deployment `dpl_AdHWSyYC3S6QFohufKRRxYSPQnhP` as **READY**. Preview URL: `https://aegis-ai-gateway-8un5oh9c5-abishek-f58a.vercel.app/`. The deployment file listing contains only `index.html`, `runtime-config.js`, `styles.css`, and the three frontend modules. No backend code or credentials were uploaded. The Vercel project has SSO protection for preview domains, so the user may need to sign in to the Vercel team. This static preview is for visual review and does not verify live gateway, CORS, or PostgreSQL behavior.

## Scenario evidence and remaining checks

The Step 8 handoff records these **in-process adapter/gateway** observations, and the suites rerun for Step 9 passed. They are not live HTTP or browser observations:

| Scenario | Available evidence | Step 9 live/DB status |
|---|---|---|
| $0.34 exact-limit success | In-process flow returned route `mock/mock-chat-v1`, a request ID, `$0.34` settled cost, and a matching usage entry and budget. | Separate-process UI/API flow pending |
| Next over-budget request | In-process flow returned a denial with `provider_called: false`; provider call count stayed at one and budget/usage were unchanged. | Separate-process UI/API flow pending |
| Tenant isolation | In-memory backend and adapter checks returned separate synthetic tenant budgets and histories. | Live browser check pending; PostgreSQL isolation test skipped |
| Provider failure | In-process flow returned `502` / `reconcile_required`, kept `$0.34` reserved, and wrote no usage entry. | Separate-process UI/API flow pending; PostgreSQL persistence test skipped |
| API connection error | Adapter test confirmed the error remains visible and does not switch to fixtures. | Browser observation pending |
| PostgreSQL restart persistence | No PostgreSQL-backed request was run. | Pending |
| Desktop/narrow layout and keyboard flow | Browser did not load the frontend. No visual or keyboard interaction was observed. | Pending: focus visibility, labeled inputs, and success/denial/pending status announcements |

## Step 10 deployment handoff

**Step 10 is blocked.** Complete the following on an authorized machine or CI runner with access to `registry.npmjs.org`, `git.chatgpt-team.site`, loopback/browser access, and the isolated PostgreSQL database whose user can create and drop schemas:

1. Install the declared `pg` dependency; use the isolated Neon database listed above for `AEGIS_TEST_DATABASE_URL` and run `npm test` from `backend/`. Require all seven database tests to execute and pass with zero skips.
2. Run migrations and seed only synthetic tenants in a disposable PostgreSQL application database. Submit the `$0.34` success and over-budget denial through the separately running services and real browser; verify route, request ID, usage entry, remaining budget, no extra provider call, tenant isolation, and pending reconciliation.
3. Verify live CORS preflight and actual requests from the configured frontend origin, no CORS permission for an unapproved origin, and missing/invalid bearer denial independent of CORS.
4. Restart the PostgreSQL-backed backend and verify the same request's usage entry and settled cost persist.
5. Observe desktop and narrow layouts and complete the request flow with keyboard-only input. Record visible focus, labeled controls, and announced success, denial, and pending-reconciliation states.
6. Push the local Site source commit above and deploy the static demo through ChatGPT Sites. Verify its private Site URL after publication.

Keep database URLs and synthetic bearer tokens in process environments, not in this report or logs. Until those checks are recorded, Step 10 must remain pending.
