# Step 6 — Backend Development Handoff

**Prepared:** 2026-11-25  
**Backend:** [`../backend/`](../backend/)  
**Frontend adapter checked:** [`../frontend/src/api.js`](../frontend/src/api.js) and its adapter tests  
**Repository:** `mrabishekraj2004-cpu/aegis-ai-gateway` remains inaccessible. The workspace is not a Git repository; the GitHub reader returned HTTP 404. No branch or commit was reviewed, and no existing backend framework, provider code, tests, or CI could be inspected. This implementation is a separate standalone Node.js backend; reconcile it against the real gateway when access is restored.

## Summary

The backend uses Node.js built-in HTTP and a deterministic mock provider. It implements `POST /v1/chat/completions` and tenant-scoped `GET /v1/usage`, with bearer-token tenant resolution, request idempotency, fixed integer-uUSD quotes, budget reservation, settlement, and pending provider-failure state. There are no third-party packages and no paid model credentials.

Budget and usage data use an in-memory `MemoryLedger` behind the gateway's storage interface. The test suite verifies atomic admission for concurrent requests **within one Node process**. This is intentionally not a durable or multi-process guarantee; Step 7 must replace it with transactional PostgreSQL storage.

## Start locally

Requirements: Node.js with ES module support (verified here with Node `v24.17.0`). No `npm install` is needed.

From PowerShell:

```powershell
cd .\backend
$env:AEGIS_MODE = "local"
npm start
```

The API listens on `http://127.0.0.1:4174`. Demo bearer credentials are supplied through environment variables and accepted only when `AEGIS_MODE=local` is explicitly set. Use a second shell for checks:

```powershell
cd .\backend
npm run check
npm test
```

The local CORS origin defaults to the Step 5 frontend at `http://127.0.0.1:4173`. To change it before start:

```powershell
$env:AEGIS_ALLOWED_ORIGIN = "http://127.0.0.1:4173"
```

The server binds only to loopback. With no `AEGIS_MODE=local`, the server starts in `disabled` mode and ignores local demo credentials. `production` mode also does not include demo credentials; a real identity-to-tenant authenticator must be injected later.

### Synthetic local credentials

- Set `AEGIS_DEMO_ASTER_TOKEN` for `tenant_demo_aster` (Aster Labs: $20.00 limit, $7.42 seeded settled spend).
- Set `AEGIS_DEMO_JUNIPER_TOKEN` for `tenant_demo_juniper` (Juniper Health: $10.00 limit, $0.00 seeded spend).
- Step 8 adds `AEGIS_DEMO_BUDGET_TOKEN` for `tenant_demo_budget`, a synthetic $0.34 cap used to demonstrate admission at the real limit.

Use synthetic values outside source control and logs. The server reads the token-to-tenant mapping from these environment variables only in explicit local mode. Do not deploy with `AEGIS_MODE=local`.

## API contract and Step 5 adapter compatibility

The standard success, denial, and overview shapes match the current Step 5 `createHttpAdapter` contract. The backend does not accept a tenant ID from the client; bearer credentials resolve the tenant server-side.

### `POST /v1/chat/completions`

Required headers:

```http
Authorization: Bearer <value configured in AEGIS_DEMO_ASTER_TOKEN>
Idempotency-Key: local-request-001
Content-Type: application/json
```

Request body:

```json
{
  "model": "demo-model",
  "messages": [{"role": "user", "content": "Summarize the latest customer feedback."}],
  "max_tokens": 128
}
```

`model` must resolve to `demo-model`; `max_tokens` must be an integer from 1 through 4096. The deterministic mock uses a fixed $0.34 quote and cost for a successful call, returns 128 input and 42 output tokens, and returns the same sample response each time. `max_tokens` is validated but does not change the mock quote. Real pricing and cost quoting remain Step 7/8 integration decisions.

Success response, HTTP 200:

```json
{
  "id": "req_local_000001",
  "model": "demo-model",
  "route": {"provider": "mock", "model": "mock-chat-v1"},
  "choices": [{"message": {"role": "assistant", "content": "The top themes are delivery experience and product reliability..."}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 128, "completion_tokens": 42, "total_tokens": 170, "cost_uusd": 340000},
  "budget": {"tenant_id": "tenant_demo_aster", "limit_uusd": 20000000, "settled_uusd": 7760000, "reserved_uusd": 0, "window_start": "2026-11-01T00:00:00.000Z", "window_end": "2026-12-01T00:00:00.000Z"}
}
```

The request ID is the join key across the response, idempotency record, and usage entry. The returned budget period is derived from the current UTC month.

### `GET /v1/usage`

Requires the same bearer token. It returns `{ tenant, budget, entries }`; `entries` contains only billable usage for the authenticated tenant's current window. Each entry includes `request_id`, alias, route, input/output/total tokens, integer `cost_uusd`, status, and `created_at`. Query parameters such as `tenant_id` and an `X-Tenant-ID` header are ignored; caller-supplied tenant fields in a request body are rejected.

### Errors consumed by the frontend

| HTTP | Code | Body fields relevant to Step 5 |
|---|---|---|
| 400 | `invalid_request` | `error.message` |
| 401 | `unauthorized` | Missing/invalid bearer; no tenant data |
| 404 | `model_not_found` | Alias is not configured |
| 409 | `idempotency_conflict` / `request_in_progress` | `error.request_id`; replay uses the original response |
| 429 | `budget_exceeded` | `request_id`, `quoted_uusd`, `remaining_uusd`, full `budget`, `provider_called: false` |
| 502 | `provider_error` | `request_id`, `settlement_state: "reconcile_required"`, `reserved_uusd`, current `budget`, safe message |

A budget denial commits no reservation and changes neither settled/reserved budget totals nor billable usage. A separate idempotency response record is retained so retries with the same key replay the same denial. The mock is not invoked. Provider failure is different: the mock has been invoked, usage is unknown, and the reservation stays counted as reserved until explicit reconciliation; the API does not create a usage row or report the amount as settled.

### Local scenario control

The default local request produces success. To force the other deterministic outcomes during local API checks, send `X-Aegis-Mock-Scenario` with one of:

- `budget_denial`: quote $13.00, above both seeded tenants' remaining budgets; admission returns 429 before provider invocation.
- `provider_failure`: invoke the mock once, return 502 with a $0.34 reservation marked `reconcile_required`.

This header is enabled only in `local` or `test` mode and is excluded in production mode. It is a local test control, not part of the Step 3 public request body. The current Step 5 HTTP adapter does not send this header, so Step 8 must add a local-only way to select API-mode scenarios if the UI needs to demonstrate forced denial/provider failure against this backend. Regular success and budget denial reached through normal budget state already work with the existing adapter.

## Authentication and CORS

- The server accepts `Authorization: Bearer <token>` and maps the token to a tenant before reading or mutating budget state.
- Demo tokens are enabled only by explicit local/test mode. No user-controlled tenant ID is used for access control.
- The default allowed origin is exactly `http://127.0.0.1:4173`. Configure `AEGIS_ALLOWED_ORIGIN` to a different exact origin; wildcard CORS is not used.
- Preflight supports `GET, POST, OPTIONS` and `Authorization, Content-Type, Idempotency-Key`. Local/test additionally allows `X-Aegis-Mock-Scenario`.
- For the Step 8 frontend, inject `window.AEGIS_CONFIG.apiBaseUrl = "http://127.0.0.1:4174"` and an authenticated `getAccessToken()` returning one of the local tokens only in a local integration setup. Do not put tokens in URLs or persist them in frontend storage.

## Storage interface and guarantees

`MemoryLedger` implements the methods consumed by the gateway: `getOverview`, `getBudget`, `beginRequest`, `completeRequest`, `reserve`, `markReconcileRequired`, and `settle`. Its accounting rules are:

1. Admission synchronously checks `settled_uusd + reserved_uusd + quote_uusd <= limit_uusd` and increments reserved spend before provider invocation. Equality is accepted.
2. Settlement moves the reservation out of `reserved_uusd`, adds actual integer-uUSD cost to settled spend, and inserts one usage row keyed by reservation. It rejects actual cost above the quote.
3. Repeated settlement of a settled reservation returns its existing usage row without charging twice.
4. Idempotency is scoped to tenant plus key and bound to a normalized request hash. Same key/same request replays the cached result; same key/different request returns 409.
5. Provider failure marks the reservation `reconcile_required`; it is not silently released. There is no reconciliation worker or operator endpoint in this step.

### Limits that Step 7 must replace

This backend is an in-memory, single-process demo adapter, not durable storage:

- A restart loses budgets, reservations, usage, request IDs, and idempotency records, returning to the seed data.
- Two Node processes do not share locks or budget totals. The concurrency test proves only that asynchronous requests handled by this one event loop cannot overspend the in-memory row.
- There is no reservation-expiry worker, crash recovery, historical usage API, or multi-process reconciliation.

Step 7 must preserve the tested invariants in PostgreSQL using one authoritative transaction store. Add UTC budget-window rows, a durable idempotency table with `(tenant_id, idempotency_key)` uniqueness and request hash, reservations with unique request linkage and explicit states, and usage entries unique by reservation. Admission must lock/conditionally update a tenant-window row atomically across processes and enforce `settled + reserved + quote <= limit`. Settlement must lock the reservation/window and update reservation, budget totals, usage row, and cached response in one transaction; retries must be idempotent. Denials must create no billable usage/reservation. A post-provider ambiguous result must remain reserved until reconciliation. Add multi-connection tests that race across database connections and verify the same one-winner result.

## Verification results

Run from `backend/`:

```powershell
npm run check
npm test
```

| Check | Result |
|---|---|
| Syntax checks | Passed for `server.mjs`, auth, ledger, mock provider, and gateway modules. |
| Automated tests | **13 passed, 0 failed, 0 skipped.** |
| Auth | Missing/invalid token rejected; local seeded token works only in local mode; production/disabled mode rejects it. |
| Tenant isolation | A tenant cannot select another tenant's usage/budget through query/header/body input. |
| Budget | Exact-limit request accepted; next request denied; over-budget branch leaves budget and usage unchanged and invokes provider zero times. |
| Concurrency | Two concurrent requests competing for one quote yield one success, one denial, one mock call, and no over-limit exposure in the in-memory adapter. |
| Idempotency/settlement | Duplicate request replays once; changed payload conflicts; duplicate settlement creates one usage entry and one charge. |
| Provider failure | 502 exposes `reconcile_required`; reserved amount remains visible; no settled usage is created. |
| Frontend contract | The actual Step 5 HTTP adapter was exercised through an in-process fetch bridge for overview, success, usage linkage, updated budget, and denial mapping. |
| Listener/browser integration | A live TCP listener and browser UI were not exercised in this sandbox. Step 5 desktop/narrow, keyboard/focus, and announcement checks remain pending for Step 8. |

## Step 8 and Step 7 handoff

For Step 8, the Step 5 adapter's normal contract matches this API: auth header, idempotency header, request body, success fields, GET overview, denial fields, and pending failure fields. The main difference is the local-only `X-Aegis-Mock-Scenario` control, which the adapter currently does not set. Preserve the pending Step 5 browser visual/accessibility checks; no live browser integration was performed here.

For Step 7, replace `MemoryLedger` with a PostgreSQL implementation without changing the public contract. Validate transaction isolation, multi-process reservation races, restart durability, unique/idempotent settlement, UTC rollover, and recovery of abandoned or ambiguous reservations. Do not treat this in-memory backend's concurrency pass as proof of database safety.

**Step 6 scope:** no existing Aegis files were changed; no PostgreSQL migrations, live provider integration, deployment, or push was performed.
