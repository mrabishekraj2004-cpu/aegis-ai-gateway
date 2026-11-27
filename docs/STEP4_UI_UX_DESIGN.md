# Step 4 — UI/UX Design

**Prepared:** 2026-11-25  
**Prototype:** [`../prototype/step4/index.html`](../prototype/step4/index.html)  
**Inputs:** Step 1 project plan, Step 2 requirements, Step 3 proposed architecture

## Design goal

A single dashboard lets a first-time visitor submit a sample request and understand the path from model alias to route, budget decision, response, and usage. The page is explicitly simulated. It uses local synthetic fixtures only; it makes no gateway or provider calls and requires no credentials, packages, or server. A Figma connection was not available, so the standalone HTML prototype is the clickable deliverable.

## Demo walkthrough

1. Open `prototype/step4/index.html` in a browser. The header and provider note identify the experience as simulated and mock-only.
2. The initial tenant is **Aster Labs (synthetic Tenant A)**. The form is prefilled with a sample prompt and `demo-model`; **In-budget success** is selected by default. Select **Run request**.
3. Observe the brief loading state, then the success panel: HTTP 200 simulation, request ID, route `mock / mock-chat-v1`, response, 170 tokens, and settled cost **$0.34**. The budget changes from **$7.42 settled / $12.58 available** to **$7.76 settled / $12.24 available**. A new usage-history row appears with the same request ID. Selecting its request ID opens the linked usage detail in the latest-request panel.
4. To show denial with a clean baseline, select **Reset demo data**, choose **Budget denial**, then run the request. The fixture quote is **$13.00**, above Aster Labs' **$12.58** available. The panel states that admission denied the request before provider invocation, no usage record was created, and the budget/history did not change.
5. Reset again, choose **Provider failure**, and run. The mock returns an error after invocation without final usage. The panel reports one provider invocation and **$0.34 reserved pending reconciliation**. Settled spend remains **$7.42**, available capacity becomes **$12.24**, and the interface explicitly says the reservation has not been charged or released. No billable usage row is added.
6. Switch **Demo tenant** to **Juniper Health (synthetic Tenant B)** to see an independent **$10.00** limit and empty-history state. Running a success there adds a row only to Juniper's history. Switching back restores Aster's separate fixture state.

| Scenario | Deterministic fixture result | Visible budget/history effect |
|---|---|---|
| Success | `req_ast_004` on a fresh Aster fixture; mock route; 128 input + 42 output tokens; $0.34 settled | Settled $7.76, available $12.24; matching usage row added |
| Budget denial | $13.00 quote against $12.58 available | No provider call, no billable usage, no budget/history change |
| Provider failure | Provider invoked; no final usage; $0.34 quote retained as a reservation | Settled remains $7.42; available $12.24; no billable usage row |
| Empty state / isolation | Juniper starts with $10.00 available and no entries | Empty history is explained; its data remains separate from Aster |

Request IDs are deterministic sequence fixtures for this browser session and may advance if the same scenario is run repeatedly. Reset restores the synthetic seed values. All displayed values are illustrative, not production prices or actual tenant data.

## Screen states and decisions

- **Dashboard / ready:** request composer, model alias, prompt, maximum output token control, three scenario choices, current tenant budget, and usage history are visible together. Native form controls and a primary action keep the first action obvious.
- **Loading:** the action disables briefly, the result area says it is checking budget and routing, and a polite live region announces progress.
- **Success:** response, route, request ID, token counts, settled cost, refreshed remaining budget, and correlated usage row are shown.
- **Budget denial:** the copy explains the quote-versus-available comparison, `budget_exceeded` / proposed HTTP 429, no usage entry, and **provider never called**. The history and budget are not mutated.
- **Provider failure:** proposed HTTP 502 is shown; the UI distinguishes a provider invocation from settled usage and shows the quote as reserved pending reconciliation. It does not imply the reservation was released or recommend a blind retry.
- **Empty usage:** Juniper's clean fixture demonstrates no billable requests yet; the message tells the user how the list becomes populated.
- **Tenant switch:** explicitly labeled as a demo control. There is no caller-editable tenant ID. Each synthetic tenant has a separate budget, usage array, and request sequence.

Budget arithmetic follows Step 2's proposed integer micro-USD (`uUSD`) rule internally. Currency display rounds to two decimal places. The visual budget bar represents settled spend plus active reservations; the separate settled and reserved amounts make the difference visible.

## Proposed API mapping and assumptions for Step 5

| UI state | Proposed Step 3 API mapping | UI behavior |
|---|---|---|
| Submit / loading | `POST /v1/chat/completions`, bearer credential, `Idempotency-Key`, model alias, prompt, and `max_tokens`; response pending | Show progress; prevent double submission while pending |
| Success | HTTP 200 with request ID, requested alias, route observability, token usage, `cost_uusd`, and budget totals | Add billable usage row keyed by request ID; update settled/reserved/available amounts |
| Budget denial | HTTP 429 `budget_exceeded` with request ID, remaining budget, and quoted amount; provider must not be invoked | Keep history and budget unchanged; explain the pre-provider denial |
| Provider failure, known no charge | HTTP 502 `provider_error`; no provider usage | Reflect the API's definitive reservation release and no billable entry |
| Provider failure, charge unknown | HTTP 502 or operation state with unresolved settlement; Step 3 proposes `reconcile_required` | Keep the reservation visible; say it is pending, not settled or released; gate retry |
| Usage detail | Proposed tenant-scoped usage read, e.g. `GET /v1/usage` | Correlate the selected row by request ID and never accept an untrusted tenant selector |

The prototype simulates these responses locally. Endpoint path, auth, exact response fields, denial code/status, cost quote, reservation lifecycle, and retry behavior remain proposed until verified against the restored repository and Step 5's frontend/API integration plan. In particular, a real API may need a distinct asynchronous settlement state rather than completing all calls synchronously as this mock does.

## Responsive and accessibility design

- Desktop uses a fixed navigation rail and a two-column request/budget workspace; the usage table spans the content width.
- CSS stacks navigation, request, budget, result, and history at viewport widths below **740 px**, and changes scenario choices and form actions to a one-column layout below **480 px**. The table hides secondary token/time columns on narrow screens while keeping request ID, route, cost, and status.
- Keyboard support is built from native links, selects, radio inputs, textarea, and buttons; a skip-to-content link is first in tab order. Labels are associated with fields, the scenario group has a legend, progress is exposed as a labeled progressbar, and request-detail links have descriptive names.
- Focus-visible outlines are defined for interactive controls, including the visible label for scenario radios. A live status region announces loading and result summaries; denial and provider failure use alert roles. `prefers-reduced-motion` disables the spinner/transition animation.
- Messages use explicit state labels and explain budget effects. Denial says no provider call/no usage; provider failure says the amount remains reserved and unresolved. Color is paired with text labels and icons.

## Verification record and limitation

The prototype is one self-contained HTML file with inline CSS/JavaScript and no external assets. The embedded JavaScript passed `node --check`. Static inspection confirms the desktop/narrow breakpoints, semantic labels, skip link, visible focus styling, live status region, reduced-motion rule, and distinct scenario copy.

A live desktop/narrow browser rendering and keyboard walkthrough could not be completed: the available browser tool rejected the local `file:` URL under its security policy and explicitly prohibited opening the same artifact through a workaround. No browser or network workaround was used. Therefore the visual fit and actual keyboard/screen-reader announcements remain to be confirmed by opening the local file in a browser; the static design intent is documented above.

## Step 5 — Frontend Development handoff

1. Preserve the single-dashboard hierarchy: request composer and current budget above latest outcome; usage history below.
2. Replace fixture state with authenticated API data. Derive tenant identity from the server session/token, never a client-provided tenant ID.
3. Map UI types to verified API response/error schemas and uUSD integer values; keep currency formatting at the display boundary.
4. Make loading, success, denial, known provider failure, and `reconcile_required` states explicit. Do not clear a pending reservation locally until the API confirms settlement or release.
5. Keep request and usage linkage on request ID; add a row only for billable usage. Denied/ambiguous attempts may appear in an activity surface, but must not masquerade as settled usage.
6. Retain a deterministic mock adapter/fixture path with no paid keys for local demos and CI. Verify provider call count stays unchanged for a budget denial.
7. Recheck responsive layout and keyboard/screen-reader behavior in the implemented frontend at desktop and narrow widths. Confirm focus order, visible focus, live announcements, error recovery, and tenant isolation with real API responses.

**Dependencies for Step 5:** repository/API access is still missing; exact API contract and authentication model are unverified. The prototype itself has no runtime dependencies. A final browser-based responsive/accessibility walkthrough remains pending because of the local-file browser policy block.
