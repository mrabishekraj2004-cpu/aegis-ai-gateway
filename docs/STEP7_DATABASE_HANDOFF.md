# Step 7 — PostgreSQL Database Handoff

**Prepared:** 2026-11-25  
**Backend:** [`../backend/`](../backend/)  
**Repository status:** This workspace is a standalone Step 6 checkout, not a Git worktree. The upstream Aegis repository remained inaccessible in earlier steps, so no branch or upstream commit was available to record. No production gateway code from that repository was inspected or changed.

## Delivered

- Added versioned migration [`../backend/migrations/001_initial.sql`](../backend/migrations/001_initial.sql) for tenants, UTC budget windows, idempotency records, reservations, and usage entries.
- Added [`../backend/src/postgres-ledger.js`](../backend/src/postgres-ledger.js), a `PostgresLedger` implementation of the Step 6 storage methods.
- Added migration runner and local synthetic tenant seeding commands.
- Added PostgreSQL integration tests that create and drop uniquely named test schemas in the database named by `AEGIS_TEST_DATABASE_URL`.
- Kept `MemoryLedger` for explicit `AEGIS_STORAGE=memory` local/test use. PostgreSQL is the default storage mode; a missing database URL, driver, or reachable database fails startup without selecting memory storage.
- Kept the Step 5 HTTP request and response shapes unchanged. Gateway storage calls now support asynchronous adapters.

## Persistence and transaction design

All money is an integer number of micro-USD (`uUSD`). PostgreSQL stores amounts as `BIGINT`; the Node adapter rejects values outside JavaScript's safe integer range. Tenant ownership is carried through composite foreign keys from reservations and usage entries to their tenant budget window. Uniqueness constraints prevent duplicate request, reservation, idempotency, and usage records.

Admission creates the current UTC month window if needed, locks the tenant's budget row with `SELECT ... FOR UPDATE`, and checks `settled_uusd + reserved_uusd + quote_uusd <= limit_uusd`. Equality is admitted. If the quote exceeds remaining funds, it returns a denial without creating a reservation or changing the budget. For admitted requests, the reservation insert and reserved balance increment commit together. Independent connections serialize on the same budget row.

Settlement locks the reservation, then updates the budget balance, reservation state, and unique usage row in one transaction. A repeated settlement returns the existing usage row and cannot charge twice. Provider failures and uncertain outcomes move an active reservation to `reconcile_required`; reserved funds remain visible and no usage row is written. The existing API contract continues to return a 502 with `settlement_state: "reconcile_required"`.

Idempotency keys are unique per tenant and store the request hash, request ID, and replay response. A duplicate key with different request content conflicts; an in-progress request returns 409. The settled ledger transaction and later cached API response write are separate transactions, as in the current gateway flow. A process crash between those writes cannot double-charge, but a retry may see `request_in_progress` until an operational reconciliation path is added.

## Local setup

Requirements: Node.js with ES modules and PostgreSQL. Install the declared `pg` dependency from `backend/`:

```powershell
cd .\backend
npm install
```

Set `DATABASE_URL` outside source control and run the versioned migrations. For local mock credentials, seed the synthetic tenants (including the exact $0.34 budget demo tenant) and start the API:

```powershell
$env:AEGIS_STORAGE = "postgres"
$env:DATABASE_URL = "<connection string for a local disposable PostgreSQL database>"
npm run migrate

$env:AEGIS_MODE = "local"
npm run seed:local
npm start
```

The API listens on loopback at `http://127.0.0.1:4174` by default. Local demo bearer tokens remain limited to `AEGIS_MODE=local`. The local CORS origin remains `http://127.0.0.1:4173`, configurable through `AEGIS_ALLOWED_ORIGIN`; `PORT` changes the listener port.

For an explicitly in-memory run, set `AEGIS_STORAGE=memory` and `AEGIS_MODE=local`. This is single-process and non-durable. `AEGIS_STORAGE` accepts only `postgres` or `memory`; it defaults to `postgres`. The server does not auto-run migrations or fall back to memory if PostgreSQL setup fails.

### Environment variables

| Variable | Use |
|---|---|
| `AEGIS_STORAGE` | `postgres` (default) or explicit `memory` for local/test only. |
| `DATABASE_URL` | Connection string for the application database and migration command. |
| `AEGIS_TEST_DATABASE_URL` | Connection string for a disposable integration-test database. Each test creates a random schema, applies migrations, and drops only that schema. The database user needs permission to create and drop schemas. |
| `AEGIS_MODE` | Set to `local` to enable the environment-configured synthetic demo tokens and local mock scenario header. |
| `AEGIS_DEMO_ASTER_TOKEN`, `AEGIS_DEMO_JUNIPER_TOKEN`, `AEGIS_DEMO_BUDGET_TOKEN` | Local-only bearer tokens mapped server-side to their synthetic tenant. Set privately in the backend environment; never commit or log their values. |
| `AEGIS_ALLOWED_ORIGIN` | Exact browser origin allowed by the API; defaults to `http://127.0.0.1:4173`. |
| `PORT` | Loopback API port; defaults to `4174`. |

Never point the integration suite at production or a database containing data that must be retained. Keep both connection strings out of source control and logs.

## Commands and verification

Run from `backend/`:

```powershell
npm run check
npm test
```

To enable PostgreSQL integration tests after installing `pg` and provisioning a disposable database:

```powershell
$env:AEGIS_TEST_DATABASE_URL = "<connection string for a disposable PostgreSQL database>"
npm test
```

The seven database tests cover fresh-schema migration and rerun, persistence after closing/reopening pools, tenant isolation, exact-limit admission and zero-call denial, concurrent reservation from two independent PostgreSQL sessions, duplicate settlement, and pending provider failure. They execute against unique temporary schemas rather than clearing shared tables.

### Results observed in this workspace

| Check | Result |
|---|---|
| `npm run check` | Passed: Node syntax checks for server, storage, migrations, adapter, scripts, and PostgreSQL integration test. |
| `npm test` | **16 passed, 0 failed, 7 skipped.** All available in-memory gateway, Step 5 adapter contract, and storage-mode checks passed. |
| PostgreSQL integration tests | **7 skipped / not executed.** `AEGIS_TEST_DATABASE_URL` is unset and `pg` is not installed. |
| Dependency install | `npm install pg` was attempted but failed because npm registry DNS lookup returned `ENOTFOUND registry.npmjs.org`. The dependency is declared in `package.json`; no lockfile was generated. |
| PostgreSQL runtime | PostgreSQL 18 binaries are present, but no configured/reachable database was available. A temporary cluster could not be brought up in the sandbox; a direct `psql` connection attempt was denied by sandbox socket permissions. |
| Storage fail-closed behavior | Confirmed: `npm start` with default PostgreSQL mode and no `DATABASE_URL` exits with a clear error; with a URL but no driver it reports that `pg` is not installed. It does not fall back to memory. |
| Explicit local memory startup | The server started with `AEGIS_STORAGE=memory` and `AEGIS_MODE=local`. A loopback HTTP probe was blocked by sandbox socket permissions, so live endpoint behavior was not verified here. |
| Git state | No `.git` worktree in this workspace; branch and commit are unavailable. |

The suite verifies the Step 6 API contract and single-process memory behavior. It does **not** verify PostgreSQL migration execution, restart durability, database isolation, or cross-connection locking in this environment. Those seven integration checks remain acceptance blockers until the `pg` dependency and disposable test database are available.

## Step 8 frontend integration handoff

The frontend can keep its current API contract:

- `POST /v1/chat/completions`: bearer authentication, `Idempotency-Key`, `{ model, messages, max_tokens }`; success returns request ID, selected route, usage cost, and current budget.
- `GET /v1/usage`: bearer-scoped `{ tenant, budget, entries }`.
- Budget denial remains HTTP 429 with `quoted_uusd`, `remaining_uusd`, `budget`, and `provider_called: false`.
- Provider failure remains HTTP 502 with `settlement_state: "reconcile_required"`, the still-reserved amount, and current budget.

No frontend files were changed. Step 8 still needs to connect the Step 5 adapter to the API listener, decide how its local-only mock scenario control is exposed, and carry forward the pending desktop/narrow layout, keyboard/focus, and live status-announcement checks. The listener and browser checks could not be completed because this sandbox blocks local socket access. The live PostgreSQL concurrency and persistence checks should also pass before describing the storage guarantees as verified.

## Step 8 / operations blockers

- Install `pg` successfully in `backend/` (or provide an approved package cache and lockfile).
- Provide a reachable, disposable PostgreSQL database through `AEGIS_TEST_DATABASE_URL`; run migrations, then the seven integration tests.
- Run the live frontend/API listener and browser checks in an environment where loopback sockets and the browser are available.
- Add an operational reconciliation process for abandoned `active`/`reconcile_required` reservations and idempotency rows left `in_progress`. No automatic timeout releases spend, because an uncertain provider outcome must not be treated as a confirmed non-charge.
- Reconcile the standalone backend with the upstream Aegis checkout when repository access returns; this workspace has no branch/commit metadata.
