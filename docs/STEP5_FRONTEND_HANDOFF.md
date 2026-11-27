# Step 5 — Frontend Development Handoff

**Prepared:** 2026-11-25  
**Frontend:** [`../frontend/`](../frontend/)  
**Design reference:** [`../prototype/step4/index.html`](../prototype/step4/index.html)  
**Repository status:** no gateway checkout is present in this workspace; GitHub returned HTTP 404 for the supplied repository URL. No existing frontend framework or gateway API could be inspected, so this is a separate, dependency-free frontend.

## What is implemented

The frontend is a small vanilla JavaScript ES-module app in `frontend/`. It preserves the Step 4 dashboard hierarchy while keeping that prototype unchanged:

- Request form with model alias, prompt, bounded output-token selection, and a simulated scenario selector.
- Tenant budget summary with available, settled, and reserved amounts and a progress bar.
- Latest request outcome with request ID, selected route, response, usage, and accounting disposition.
- Billable usage history linked to request IDs, with a useful empty state.
- Synthetic Aster Labs and Juniper Health data, independent budgets/history, and a tenant switch available only in simulated mode.
- Replaceable simulated and HTTP adapters in `src/fixtures.js` and `src/api.js`. API mode is selected with `?mode=api`; it hides the tenant and scenario controls and resolves identity only through the authenticated server credential.
- A local Node static server in `server.mjs`; no framework, package install, paid API key, or gateway process is needed for simulated mode.

### Simulated outcomes

| Outcome | Example | Budget and history behavior |
|---|---|---|
| Success | `req_ast_004`; `mock / mock-chat-v1`; 170 tokens; $0.34 cost | Adds a billable row under the same request ID; Aster settled spend becomes $7.76 and available becomes $12.24. |
| Budget denial | $13.00 quote against Aster's $12.58 available | Provider call count stays unchanged; no usage row; budget and history remain byte-for-byte equivalent in the fixture test. |
| Provider failure | Mock invoked, no final usage; $0.34 quote | Adds $0.34 to reserved, not settled spend; keeps the amount visible as pending reconciliation; creates no billable usage row. |
| Empty history / tenant isolation | Juniper begins with a $10.00 limit, $0 settled, and no entries | Empty state is shown; running a request for Juniper does not alter Aster's budget or history. |

The “Reset demo data” action restores both tenants to their original synthetic fixtures. Simulated mode never sends requests to the gateway or a model provider.

## Run locally

Requirements: Node.js with ES module support (verified here with Node `v24.17.0`). No `npm install` is needed; `package.json` declares no dependencies.

From PowerShell at the workspace root:

```powershell
cd .\frontend
npm start
```

Then open `http://127.0.0.1:4173`. Set a different port if needed:

```powershell
$env:PORT = "4174"
npm start
```

The app uses native ES modules and has no bundling/build step. Run the available checks from `frontend/`:

```powershell
npm run check
npm test
```

## Verification record

| Check | Result |
|---|---|
| `npm run check` | Passed: Node syntax checks for the server and frontend modules. |
| `npm test` | Passed: 9 tests covering deterministic success/settlement, request ID linkage, pre-provider denial with unchanged fixture state, pending reservation after provider failure, tenant isolation/empty history, input validation, HTTP auth/idempotency and error mapping, API overview shape/configuration, and static asset handler responses. |
| Static server request handler | Passed in-process for `/`, CSS, JS module, 404, and unsupported-method behavior. |
| Node version | `v24.17.0`. |
| Gateway/backend integration | Not run; no checkout or accessible API. |
| Browser rendering and manual UI interaction | Pending. The browser tool previously rejected the local-file preview under its security policy; no alternate browser path was used. Desktop/narrow visual fit, keyboard traversal, focus appearance, and live screen-reader announcements still require manual browser verification. |
| TCP listener preview | Not verified in this sandbox: a loopback bind attempt returned `EACCES`. The static request handler itself passed its in-process smoke test. |

The JavaScript tests verify adapter/accounting state and static-file routing; they do not substitute for browser-level interaction or accessibility testing.

## API and authentication assumptions to verify

API mode is a connection seam, not live gateway integration. It is enabled by opening `?mode=api` after the hosting/auth layer injects a `window.AEGIS_CONFIG` object before `src/main.js` loads:

```js
window.AEGIS_CONFIG = {
  apiBaseUrl: "http://127.0.0.1:<gateway-port>",
  getAccessToken: async () => authProvider.getAccessToken()
};
```

The frontend does not persist credentials. The host supplies the token through `getAccessToken`; the adapter sends it as a bearer token and does not send a tenant ID in the request body or URL. In API mode, tenant identity must be resolved by the backend from that credential. Demo tenant switching and forced scenario selection are hidden.

The adapter currently assumes the following Step 3 proposal; Step 6 must confirm exact field names, response bodies, and CORS behavior before integration:

- `GET /v1/usage` returns `{ tenant: { id, name }, budget: { limit_uusd, settled_uusd, reserved_uusd, window_start, window_end }, entries: [...] }` for the authenticated tenant.
- `POST /v1/chat/completions` accepts `model`, `messages`, and `max_tokens`, plus `Authorization` and `Idempotency-Key` headers. Tenant ID is not client-controlled.
- HTTP 200 includes request ID, choices/response, route, usage token counts, `cost_uusd`, and updated budget fields. If POST omits budget totals, the UI refreshes `GET /v1/usage`.
- HTTP 429 / `budget_exceeded` supplies request ID, quoted amount, and remaining budget. Denial occurs before provider invocation; no usage or budget change is returned.
- HTTP 502 / `provider_error` supplies request ID and settlement state. For unresolved calls it should return `settlement_state: "reconcile_required"`, `reserved_uusd`, and preferably the current budget. The frontend refreshes the overview when possible and retains a known pending reservation if the refresh fails.
- Cross-origin development must allow the frontend origin and `Authorization`, `Content-Type`, and `Idempotency-Key` headers. The authenticated host must provide a supported token refresh/failure path.

No authentication token, tenant selector, API base URL, or endpoint contract should be guessed in Step 6. Unknown or unauthenticated API mode fails visibly and does not fall back to simulated success.

## Step 6 — Backend Development handoff

1. Confirm the repository's actual request path and auth middleware; map the bearer token to a trusted tenant server-side. Never authorize from a frontend tenant ID.
2. Provide the tenant-scoped `GET /v1/usage` overview (or revise the adapter to the implemented endpoint) with budget window, settled spend, reserved spend, usage entries, route, cost, and request ID fields.
3. Confirm `POST /v1/chat/completions` request and success/error schemas, supported alias, output-token field, and whether selected provider/model can be disclosed to this client.
4. On 429, return quoted/remaining amounts and guarantee rejection precedes provider invocation. Keep denial out of billable usage.
5. On provider failure, expose whether usage is known, whether settlement completed, and any amount still reserved. For `reconcile_required`, preserve the reservation until backend reconciliation changes the state; do not tell the UI it has been released.
6. Implement idempotency and trusted tenant isolation in the gateway; the frontend-generated key is not a substitute for backend enforcement.
7. Define CORS or same-origin hosting and the authentication provider integration contract. Supply a local no-paid-key endpoint/configuration for later end-to-end verification.
8. Once a browser preview is available, test desktop and narrow widths, keyboard/focus order, focus visibility, live announcements, and every request state against backend responses.

**Step 5 scope note:** no gateway/backend files were changed and no deployment was performed. The API adapter is intentionally isolated and remains unconnected until Step 8 as scheduled.
