# Step 8 — Frontend and Gateway Integration Handoff

**Prepared:** 2026-11-25  
**Frontend:** [`../frontend/`](../frontend/)  
**Backend:** [`../backend/`](../backend/)  
**Scope:** Local integration only. No deployment or push.

## What changed

- The frontend now serves `/runtime-config.js` from environment variables. It defaults the API base URL to `http://127.0.0.1:4174` and never switches from API mode to fixture mode after an error.
- API mode calls `GET /healthz`, `GET /v1/usage`, and `POST /v1/chat/completions`. The UI labels backend storage as **PostgreSQL storage**, **In-memory storage — not durable**, or **Storage mode unknown**. The backend health response reports its active storage adapter.
- The live UI sends bearer authentication and idempotency keys. It does not send a tenant ID; in explicit local demo mode, the selected synthetic bearer token is what the backend resolves to a tenant.
- The tenant selector and mock failure control appear in API mode only with `AEGIS_LOCAL_DEMO=true`. Scenario control sends `X-Aegis-Mock-Scenario: provider_failure` only for that local failure choice. Budget denial uses the normal $0.34 mock quote against a real synthetic `$0.34` tenant limit; no forced over-budget quote is used for that walkthrough.
- The API success flow refreshes usage history so the displayed entry is fetched from the gateway and linked by request ID. Denials refresh the ledger, and provider failure keeps the pending reservation visible. A lost/failed API response warns that the provider may have received the request and advises checking state before retrying.
- Demo tokens are read from environment variables by the backend and the local frontend server. They are not printed to logs or embedded in source. The local frontend serves runtime configuration without caching it.

## Demo walkthrough

Start the backend and frontend in separate PowerShell terminals. Use synthetic token values set privately in both terminals; replace the placeholders below with the same local-only values. Do not commit or log them.

### In-memory API demo

Terminal 1, from `backend/`:

```powershell
$env:AEGIS_MODE = "local"
$env:AEGIS_STORAGE = "memory"
$env:AEGIS_ALLOWED_ORIGIN = "http://127.0.0.1:4173"
$env:AEGIS_DEMO_ASTER_TOKEN = "<synthetic Aster token>"
$env:AEGIS_DEMO_JUNIPER_TOKEN = "<synthetic Juniper token>"
$env:AEGIS_DEMO_BUDGET_TOKEN = "<synthetic Budget Demo token>"
npm start
```

Terminal 2, from `frontend/`:

```powershell
$env:AEGIS_API_BASE_URL = "http://127.0.0.1:4174"
$env:AEGIS_LOCAL_DEMO = "true"
$env:AEGIS_DEMO_ASTER_TOKEN = "<same synthetic Aster token>"
$env:AEGIS_DEMO_JUNIPER_TOKEN = "<same synthetic Juniper token>"
$env:AEGIS_DEMO_BUDGET_TOKEN = "<same synthetic Budget Demo token>"
npm start
```

Open `http://127.0.0.1:4173/?mode=api`. The API page displays the storage badge so this run is visibly marked as memory-backed. To use fixtures, select **Fixtures** (or open `http://127.0.0.1:4173/`). That mode is labeled **Fixture mode** and makes no gateway calls.

### PostgreSQL API demo (when the driver and database are available)

Use the same local tokens in both terminals. In the backend terminal, run from `backend/`:

```powershell
npm install
$env:AEGIS_MODE = "local"
$env:AEGIS_STORAGE = "postgres"
$env:AEGIS_ALLOWED_ORIGIN = "http://127.0.0.1:4173"
$env:DATABASE_URL = "<connection string for a disposable PostgreSQL database>"
$env:AEGIS_DEMO_ASTER_TOKEN = "<synthetic Aster token>"
$env:AEGIS_DEMO_JUNIPER_TOKEN = "<synthetic Juniper token>"
$env:AEGIS_DEMO_BUDGET_TOKEN = "<synthetic Budget Demo token>"
npm run migrate
npm run seed:local
npm start
```

Run the frontend terminal commands from the in-memory section, using the same three token values. Open the same API URL. The badge should read **PostgreSQL storage**. For the database suite, set `AEGIS_TEST_DATABASE_URL` to a separate disposable database and run `npm test` from `backend/`.

1. Select **Budget Demo — $0.34 request cap** and **In-budget request**. Submit the sample prompt. The gateway mock routes `demo-model` to `mock/mock-chat-v1`, returns a response, settles `$0.34`, and records the same request ID in usage history. The cap is now fully committed.
2. Keep the same tenant, choose **Actual budget limit**, and submit again. This sends an ordinary request with the normal quote. The gateway denies it because remaining budget is `$0.00`; the provider call count does not increase and the budget and usage entry remain unchanged.
3. Select **Aster Labs**, choose **Provider failure**, and submit. The local-only failure header makes the deterministic mock provider return an uncertain result. The UI should show `reconcile_required`, `$0.34` reserved, unchanged settled spend, and no new usage entry.
4. Switch to **Juniper Health**. Its budget and usage history remain separate, demonstrating that the bearer token controls tenant selection.

In the gateway API flow, the **Actual budget limit** choice does not inject a denial scenario header. If the budget is not full, it can succeed and consume the real balance; repeat until the cap is reached. The one-request Budget Demo tenant makes the pass condition deterministic.

## API and CORS configuration

- Frontend `AEGIS_API_BASE_URL` defaults to `http://127.0.0.1:4174` and can be set to the gateway origin.
- Backend `AEGIS_ALLOWED_ORIGIN` defaults to `http://127.0.0.1:4173`. Keep it set to the exact frontend origin; wildcard CORS is not used.
- Backend `AEGIS_MODE=local` enables local demo scenario handling and reads the synthetic token map from `AEGIS_DEMO_ASTER_TOKEN`, `AEGIS_DEMO_JUNIPER_TOKEN`, and `AEGIS_DEMO_BUDGET_TOKEN`. With a different mode the seeded local credentials and scenario header are unavailable.
- Frontend `AEGIS_LOCAL_DEMO=true` enables the local tenant selector and provider-failure control. Without it, the UI exposes neither control. A host app can instead supply `window.AEGIS_CONFIG.getAccessToken()`.
- No real model credentials are used. The deterministic mock provider is the only provider in this demo.

## Results observed

### In-process adapter-to-gateway integration

The frontend adapter called the actual `createGateway` and `MockProvider` through an in-process fetch bridge. This exercises the API request/response logic but does not exercise TCP, browser CORS enforcement, or a separately running API process.

| Scenario | Observed result |
|---|---|
| Success on Budget Demo | `200`; route `mock/mock-chat-v1`; non-empty response; cost `$0.34`; settled budget `$0.34`; one usage entry with matching request ID, route, and cost. |
| Actual-cap denial | `429`; normal quote `$0.34`; `providerCalled=false`; provider calls remained at one; budget and usage snapshot were unchanged. |
| Provider failure on Aster | `502`; provider invoked once; `reconcile_required`; `$0.34` remained reserved; settled spend and usage count did not increase. |
| Tenant isolation | Switched bearer tokens returned distinct Aster, Budget Demo, and Juniper budgets and histories. The adapter did not put a tenant ID in the request body. |
| Storage label | `GET /healthz` reported `memory`; the adapter exposed it as `storageMode: "memory"`. |
| No silent fixture fallback | An unavailable API fetch rejected visibly in the adapter; no simulated adapter was substituted. |

### Checks and environment limits

| Check | Result |
|---|---|
| Frontend `npm run check` | Passed. |
| Frontend `npm test` | **14 passed, 0 failed, 0 skipped.** Includes adapters, runtime config, static server, local failure-control gating, and gateway in-process integration. |
| Backend `npm run check` | Passed. |
| Backend `npm test` | **18 passed, 0 failed, 7 skipped.** The seven skips are PostgreSQL integration tests. |
| PostgreSQL | Not run. `pg` remains unavailable, neither `DATABASE_URL` nor `AEGIS_TEST_DATABASE_URL` is configured, and the prior npm registry attempt failed with DNS `ENOTFOUND`. The seven migration, restart, isolation, exact-limit, cross-connection, duplicate-settlement, and provider-failure DB checks remain pending. |
| Live HTTP | Both local servers reported that they were listening, but a browser request to the frontend timed out (`net::ERR_CONNECTION_TIMED_OUT`). No successful HTTP request crossed the separate processes in this environment. |
| Browser/layout/accessibility | Browser preview did not load. Desktop/narrow visual review, keyboard traversal, visible focus, and live status announcement checks remain pending. |
| PostgreSQL restart persistence | Not verified. No successful API request was persisted to PostgreSQL or checked after restart. |

The in-process pass does **not** verify real HTTP/CORS behavior, PostgreSQL persistence, or concurrent database connections. A memory-backed run must not be reported as PostgreSQL-backed; the live UI now distinguishes the modes when the health check is reachable.

## Step 9 — Testing handoff

Step 9 should run the same UI flow against a separately running backend and browser, then repeat it with PostgreSQL after installing `pg` and supplying a disposable database:

- Verify preflight and actual requests from `http://127.0.0.1:4173` to the configured API URL. Confirm the health badge matches the server storage mode.
- Repeat success, cap denial, pending provider failure, and tenant switching through the browser. Capture route, response, request ID, settled cost, refreshed entry, unchanged denial ledger, and pending reserved amount.
- Run `npm run migrate`, `npm run seed:local`, and `AEGIS_TEST_DATABASE_URL=<disposable database> npm test` from `backend/`. All seven PostgreSQL tests must execute and pass before marking persistence and independent-connection admission verified.
- With `AEGIS_STORAGE=postgres`, submit success through the frontend, restart the backend, and confirm that the same usage entry and settled balance remain.
- Check desktop and narrow layouts, keyboard order, visible focus, and announcement text for success, denial, provider failure, and connection failure.
- Keep demo bearer tokens in the local process environment; do not commit them or include them in captured logs.

**Outstanding blockers:** PostgreSQL driver/database availability and browser access to the local listener. No deployment or external repository changes were made.
