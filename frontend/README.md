# Aegis console

A Next.js operations console for the Aegis FastAPI gateway. Its eight screens share a component system with light and dark palettes, responsive navigation, keyboard focus, status labels, and chart data tables.

## Run locally

Use Node.js 22 or newer. From the project root:

```bash
cd frontend
npm ci
npm run dev
```

Open http://localhost:3000. The first view uses visibly labeled demo data. Build the static production output with `npm run build`. To preview that output locally, run `python3 -m http.server 3100 --directory out` from `frontend`.

## Connect the existing backend

1. Start the FastAPI gateway using the project [backend instructions](../README.md) and provision a scoped key. The connection probe requires `models:read`. Add `usage:read` for reporting and `chat:write` for the playground.
2. Set the backend’s `AEGIS_ALLOWED_ORIGINS` to the exact frontend origin, for example `["http://localhost:3000"]`, and restart the gateway. The direct browser connection uses the existing CORS configuration. `localhost` and `127.0.0.1` are distinct origins.
3. Select **Connect gateway**. Enter the gateway origin and the scoped credential. Remote gateway origins require HTTPS. The browser rejects redirects and sends credentials only to the configured origin. The credential remains in memory until the session is replaced, disconnected, or reloaded.
4. To read or edit an existing routing policy, connect with a short-lived OIDC access token and its tenant UUID. The gateway checks membership and policy permissions. Publish only after reviewing the revision and adding a change reason. Disable requires explicit confirmation.

The console imports the gateway’s OpenAPI schemas for chat, health, usage, model aliases, and policy write requests. The routing policy list response and SSE frames follow the concrete FastAPI serializers because those response structures are not fully described in OpenAPI. To update the TypeScript declarations after refreshing `contracts/openapi.json` from FastAPI, run `npm run contracts`.

## UI and integration map

| Screen | Live data or behavior | Remaining integration |
| --- | --- | --- |
| Overview | Admitted requests, observed tokens, finalized spend, and coarse readiness | Per-provider availability, latency percentiles, and recent request records |
| Routing console | OIDC policy list, edit of existing targets and scoring weights, directed fallback edges, publish, disable, and activation | Deployment names and capabilities, current catalog revision discovery, enrollment of new targets, and per-request routing decisions |
| Providers | Published model aliases and coarse readiness | Provider inventory, detailed capabilities, configuration, and breaker state |
| Request analytics | Daily admitted request volume, provider attempt counts, and CSV export | Error series, latency distribution, and provider comparison |
| Cost intelligence | Daily cost and token usage, finalized spend by alias, estimated charges, and pending holds | Tenant budget limits, counters, and budget management |
| Reliability center | Coarse gateway readiness with refresh | Per-provider telemetry, failure stream, breaker transitions, retry outcomes, and fallback reasons |
| API playground | JSON and SSE completions, cancellation, incomplete output, request ID, finish reason, and reported usage | Live rate cards for a preflight cost estimate |
| Security & access | Current credential type, tenant context, and scope requirements | HTTP APIs for key issue and revocation, tenant and member management, and audit history |

Demo interactions stay local. The routing preview edits an in-memory draft. The playground generates an explicitly labeled sample response without a gateway request. Live pages show an unavailable state wherever the required API is missing. The browser does not use provider credentials or the collector token.

## Design system

The console uses Inter for navigation and content, with IBM Plex Mono for operational identifiers and numeric details. Forest-green accents, neutral surfaces, and clearly labeled severity colors work across both themes. Shared components include panels, metrics, tables, chart legends and data disclosures, alerts, status badges, modal dialogs, loading states, empty states, and responsive navigation. Native form controls and dialogs provide keyboard behavior. Layout changes preserve reading order, and reduced-motion preferences disable transitional movement.

## Verification

The [verification report](../VERIFICATION.md#commands-and-results) records the production export, TypeScript, ESLint, 12 Vitest tests, and six Playwright tests. Chromium rendered all eight routes at 1440, 1024, 820, 768, 390, and 320 CSS pixels without page overflow. Automated axe scans found no violations in either theme on the eight routes. Live browser tests used disposable PostgreSQL and Redis, a scoped key, and a signed OIDC fixture. They verified a streamed mock completion, its recorded usage, policy publication, and a confirmed disable.

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Use `CHROMIUM_PATH` to point Playwright to an existing Chromium executable. The browser suite serves the static build on `127.0.0.1:3100`. For live integration, provide disposable values in `AEGIS_E2E_KEY`, `AEGIS_E2E_URL`, `AEGIS_E2E_ACCESS_TOKEN`, and `AEGIS_E2E_TENANT`. The policy browser test actively publishes and disables a policy, so use a disposable seeded tenant. Automated axe checks cover both themes and the eight screens. Automated checks cover detectable WCAG issues and complement manual assistive-technology validation.

## Remaining frontend checklist

- [ ] Add a managed IdP sign-in and refresh flow when the deployment identity configuration is available.
- [ ] Connect provider, reliability, audit, access-management, and budget views as their protected endpoints become available.
- [ ] Add request-level traces and decision explanations after the gateway can authorize and expose those records.
- [ ] Exercise a production browser environment and complete a manual screen reader pass.
