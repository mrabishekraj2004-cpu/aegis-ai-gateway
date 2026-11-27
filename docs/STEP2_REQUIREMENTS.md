# Step 2 — Aegis AI Gateway Requirements

**Prepared:** 2026-11-25  
**Input:** [`docs/STEP1_PROJECT_PLAN.md`](./STEP1_PROJECT_PLAN.md)  
**Repository requested:** [mrabishekraj2004-cpu/aegis-ai-gateway](https://github.com/mrabishekraj2004-cpu/aegis-ai-gateway)

## 1. Repository evidence and access blocker

The requested source repository could not be opened. The supplied workspace is not a Git checkout (`git` reports that the current directory is not a repository). The GitHub repository reader returned HTTP 404 for the supplied URL, and the connected account's repository listing/search did not include `aegis-ai-gateway`. The 404 does not establish whether the repository is private, renamed, or the URL is incorrect.

Therefore, there is **no branch or commit reviewed**. The README, request routes, authentication, source, dependency manifests, tests, workflow definitions, and CI results could not be inspected. The only project-specific input available is the Step 1 planning document; it is scope intent, not implementation or test evidence.

| Capability / evidence area | Verified in code/tests/CI | Implemented but unverified | Unknown / evidence unavailable |
|---|---|---|---|
| Request routes and tenant authentication | None | None identifiable | Routes, trusted identity source, tenant mapping |
| Model routing | None | None identifiable | Alias handling, provider/model selection, route observability |
| Budget enforcement | None | None identifiable | Budget representation, timing, exact-limit behavior, atomicity |
| Usage recording | None | None identifiable | Ledger/schema, fields, failure/cancel treatment, persistence |
| Mock provider | None | None identifiable | Adapter, deterministic cost/usage, paid-key requirement |
| Local dependencies | None | None identifiable | Runtime, packages, services, environment variables, setup commands |
| Tests and CI | None | None identifiable | Test coverage, CI configuration and latest available results |

No capability is claimed as present or covered by tests. The requirements below are **proposed** where they settle choices that repository evidence cannot settle. Step 3 should adapt them if source evidence becomes available and contradicts these choices.

## 2. Prioritized first-release requirements

**Priority:** P0 is required for the portfolio demo; P1 is useful but can follow without blocking the core demonstration. “Proposed” marks a decision made for planning, not an observed repository behavior.

| ID | Priority | Requirement and measurable outcome | Decision status |
|---|---|---|---|
| R-01 Trusted tenant identity | P0 | The gateway derives a tenant ID from a validated credential or trusted server-side principal. It must ignore/reject caller-supplied tenant IDs in request bodies or headers unless those values are checked against the authenticated principal. Demo credentials map deterministically to two configured tenants. | **Proposed:** use static, local-only demo credentials mapped server-side; do not treat an arbitrary `X-Tenant-ID` as identity. |
| R-02 Model routing | P0 | A request's permitted model alias resolves to a configured provider and model. The selected alias/provider/model is observable in the response or structured request record. | Required by Step 1; existing behavior unknown. |
| R-03 Budget unit and period | P0 | Each tenant has an independent limit and spend total for a defined window. | **Proposed:** integer micro-USD (`$1 = 1,000,000 µUSD`) to avoid floating-point currency math; budget windows are UTC calendar months `[00:00 UTC on day 1, 00:00 UTC on day 1 of next month)`. Use a fixed clock/seeded window for a repeatable demo. |
| R-04 Exact-limit behavior | P0 | A request whose reserved cost makes total spend exactly equal to the limit is allowed; a request that would make it greater is denied. | **Proposed:** compare `settled spend + active reservations + new reservation <= limit`; equality passes. |
| R-05 Pre-provider enforcement | P0 | Before calling a provider, the gateway computes/obtains a deterministic request cost ceiling and atomically reserves it against the authenticated tenant/window. If reservation would exceed the limit, deny without invoking the provider. | **Proposed:** local demo uses a deterministic mock quote/cost. A production cost-estimation policy is not established by available evidence. |
| R-06 Concurrent requests | P0 | Concurrent requests for one tenant cannot each spend the same remaining budget. Reservation/check/update must be atomic per tenant/window. Every reservation is released or settled once; retries must not double-charge the same request. | **Proposed:** use request IDs and idempotent settlement; storage and reservation mechanism are Step 3 decisions. |
| R-07 Usage record | P0 | Each completed billable request produces a usage entry linked to request and tenant, including timestamp/window, requested alias, selected provider/model, available input/output usage counts, cost in µUSD, and outcome. A request ID allows the response and usage entry to be correlated. | Required by Step 1; exact schema/storage unknown. Fields above are the minimum proposed demo fields. |
| R-08 Tenant isolation | P0 | Budgets, reservations, and usage queries/writes are scoped to the trusted tenant ID; a request for one tenant cannot read, consume, or alter another tenant's records or budget. | Required for per-tenant behavior; implementation unknown. |
| R-09 Denial behavior | P0 | If the reservation would exceed the limit, return a stable machine-readable budget-exceeded result before provider invocation. Denied calls create no billable usage or spend; an attempt/denial event may be recorded separately. | **Proposed:** HTTP 429 with error code `budget_exceeded`; this is an API contract proposal, not existing behavior. |
| R-10 Failed/cancelled request accounting | P0 | Track attempt outcome separately from billable usage. A failed/cancelled request with no provider-reported usage releases its reservation and creates no billable spend; reported partial usage is recorded and settled. Cancellation before provider invocation releases the reservation. | **Proposed for deterministic local mock:** mock failures/cancellations consume no spend unless usage was explicitly returned. Real-provider charges after timeout/cancellation remain an architecture/product policy question. |
| R-11 No-paid-key demo | P0 | A clean local demo runs without paid API credentials or external provider calls. It uses a deterministic mock adapter that returns predictable response, usage, and cost, and supports an invocation counter/spy for pre-call denial assertions. | **Required:** mock support is unverified and must be implemented if absent. |
| R-12 Basic reproducibility | P1 | The repository documents local setup and provides a command/test path to seed two tenants, run the demo, and inspect route, usage, and denial results. CI runs the core behavior tests when CI is available. | Proposed; project scripts and CI unknown. |

### Budget accounting rules proposed for the demo

1. Quote/reserve a known upper bound before provider invocation. For the deterministic mock, its configured fixed cost/usage makes that bound repeatable.
2. On success, record actual mock usage and settle spend; release any excess reservation. A settled request must not be charged again on retry/duplicate settlement.
3. On a pre-provider denial, do not invoke the provider and do not create billable usage. A separate denial event is allowed for auditability.
4. On mock failure/cancellation with no returned usage, release the reservation. If the mock returns partial usage, persist it and settle that amount.
5. At UTC month rollover, new requests use the new period's limit/spend. Historical usage remains queryable. The demo uses a fixed clock or explicit seeded period so acceptance tests do not depend on the real date.

## 3. Given / When / Then acceptance scenarios

The scenarios define required behavior, not tests already present. A test implementation should use the deterministic mock and inspect both response and provider call/usage state.

### A. In-budget request is routed

- **Given** tenant A is authenticated through its configured demo credential, has sufficient budget, and alias `demo-model` maps to a known mock provider/model
- **When** tenant A submits a valid request using `demo-model`
- **Then** the gateway returns the mock response and exposes the selected provider/model and request ID
- **And** exactly one provider invocation is observed for that request.

### B. Successful request has a matching usage record

- **Given** tenant A's in-budget request has completed successfully with deterministic mock usage
- **When** the usage ledger is read through an authorized tenant-scoped path or test fixture
- **Then** exactly one billable entry matches the response request ID and tenant A
- **And** it contains the requested alias, selected provider/model, timestamp/window, usage counts returned by the mock, settled cost in µUSD, and successful outcome
- **And** tenant A's spend increases by that settled cost only.

### C. Over-budget request is denied before provider invocation

- **Given** tenant A's settled spend plus active reservations leaves less budget than the mock's known request quote
- **When** tenant A submits that request
- **Then** the gateway returns the proposed `budget_exceeded` denial (proposed HTTP 429)
- **And** the mock provider invocation count does not increase
- **And** no billable usage or spend is added for the denied request.

### D. Tenant identity and records are isolated

- **Given** tenant A and tenant B have separate credentials, budgets, and usage entries
- **When** a request authenticated as tenant A supplies tenant B's ID in an untrusted field, and tenant A requests usage/budget data
- **Then** the gateway either ignores the supplied ID or rejects the request, but never performs it under tenant B
- **And** tenant A sees only its own budget/usage; tenant B's spend and records remain unchanged.

### E. Concurrent requests compete for one remaining budget

- **Given** tenant A has exactly enough remaining budget for one request at the known mock quote, and two valid requests arrive concurrently
- **When** both attempt reservation at the same time
- **Then** exactly one reservation succeeds and invokes the mock
- **And** the other request is denied before provider invocation
- **And** total settled spend plus active reservations never exceeds the tenant limit.

### F. Exact limit is allowed; above limit is denied

- **Given** tenant A has remaining budget exactly equal to one request's quote
- **When** that request is submitted
- **Then** it is accepted and may settle spend exactly at the limit
- **And** a subsequent positive-cost request is denied before provider invocation.

### G. Failed or cancelled mock request releases unused reservation

- **Given** a request has reserved budget and the deterministic mock fails or is cancelled before reporting usage
- **When** the gateway finalizes that attempt
- **Then** the outcome is observable as failed/cancelled, the reservation is released, and billable usage/spend remains unchanged
- **And** if the mock reports partial usage before failure, that usage is recorded and only its known cost is settled.

## 4. Smallest demo and dependency status

**Smallest demo proposal:** run the local gateway against two seeded tenants and one deterministic mock route. Send one in-budget request, inspect its route and correlated usage entry, then send an over-budget request and show the budget denial plus unchanged provider call count. Run an isolation check and a two-request concurrency test as automated acceptance scenarios. No paid API key or external model call is permitted in this demo.

A deterministic mock is a **P0 requirement** because its existence cannot be verified. The repository's language/runtime, package manifests, databases/services, setup commands, and CI dependencies are unknown. Step 3 must choose an implementation shape compatible with actual repository evidence once a checkout is available; do not assume a database or framework here.

## 5. Step 3 — System Architecture handoff

Step 3 should obtain access to the repository first, record branch and commit, and validate these proposed requirements against routes, source, tests, dependency files, and CI. Then resolve:

1. What authenticated credential/principal maps to a tenant, and how will local demo credentials be isolated from production identity?
2. Where do tenant budgets, monthly window boundaries, reservations, usage entries, and denial events live? What persistence does the existing project already use?
3. What operation makes budget reservation/check atomic across concurrent requests? What happens on process crash, provider timeout, retry, duplicate request, or duplicate settlement?
4. How does the gateway obtain a pre-call cost quote or safe maximum, and how are actual provider usage and price discrepancies reconciled?
5. What provider interface and mock implementation fit the current route path, and how can tests prove the provider was never called on denial?
6. What API response and status code should represent budget denial, authentication failure, provider failure, and cancellation? Confirm or revise the proposed HTTP 429 contract.
7. What event/ledger model distinguishes attempts, billable usage, partial usage, failed calls, and cancellations while keeping tenant reads isolated?
8. How will the UTC monthly reset/window be represented and tested deterministically? Is an explicit demo reset command needed?
9. What local setup/test commands and CI workflows can validate all acceptance scenarios? What additional packages/services are actually needed?
10. Which P0 requirements are compatible with the existing code and which need scope changes before implementation?

**Step 2 completion note:** Requirements and acceptance conditions are drafted from Step 1, with proposed decisions labeled. Existing implementation and test coverage remain unknown because repository access, branch/commit, source, and CI results are unavailable. Architecture decisions should be finalized only after source review.
