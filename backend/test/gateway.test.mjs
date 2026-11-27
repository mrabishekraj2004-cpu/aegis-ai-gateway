import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";
import { MemoryLedger } from "../src/ledger.js";
import { MockProvider } from "../src/mock-provider.js";

const credentials = new Map([
  ["token-aster", "tenant_demo_aster"],
  ["token-juniper", "tenant_demo_juniper"]
]);
const sampleBody = {
  model: "demo-model",
  messages: [{ role: "user", content: "Summarize the latest customer feedback." }],
  max_tokens: 128
};
const request = (gateway, { method = "POST", path = "/v1/chat/completions", token = "token-aster", key = "request-key-1", body = sampleBody, headers = {} } = {}) => gateway.handle({
  method,
  path,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { "idempotency-key": key } : {}), ...headers },
  body
});
function makeGateway({ mode = "test", tenants, provider = new MockProvider(), allowedOrigin } = {}) {
  const store = new MemoryLedger(tenants ? { tenants } : undefined);
  return { gateway: createGateway({ mode, credentials, store, provider, allowedOrigin }), store, provider };
}

test("missing and invalid bearer credentials are rejected", async () => {
  const { gateway } = makeGateway();
  const missing = await request(gateway, { method: "GET", path: "/v1/usage", token: null, key: null });
  const invalid = await request(gateway, { method: "GET", path: "/v1/usage", token: "not-a-token", key: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, "unauthorized");
  assert.equal(invalid.status, 401);
});

test("authenticated success returns route, request ID, usage and settled budget", async () => {
  const { gateway, store, provider } = makeGateway();
  const response = await request(gateway);
  assert.equal(response.status, 200);
  assert.match(response.body.id, /^req_local_/);
  assert.equal(response.body.route.provider, "mock");
  assert.equal(response.body.route.model, "mock-chat-v1");
  assert.equal(response.body.route.decision.reason, "priority_weighted");
  assert.equal(response.body.usage.prompt_tokens, 128);
  assert.equal(response.body.usage.completion_tokens, 42);
  assert.equal(response.body.usage.cost_uusd, 340_000);
  assert.equal(response.body.budget.settled_uusd, 7_760_000);
  assert.equal(response.body.budget.reserved_uusd, 0);
  const overview = await request(gateway, { method: "GET", path: "/v1/usage", key: null });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.entries[0].request_id, response.body.id);
  assert.equal(overview.body.entries[0].cost_uusd, response.body.usage.cost_uusd);
  assert.equal(provider.calls, 1);
  assert.equal(store.getUsageCount("tenant_demo_aster"), 1);
});

test("usage and budget are scoped to the authenticated tenant, not query/header selectors", async () => {
  const { gateway } = makeGateway();
  const response = await request(gateway, { method: "GET", path: "/v1/usage?tenant_id=tenant_demo_juniper", key: null, headers: { "x-tenant-id": "tenant_demo_juniper" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.tenant.id, "tenant_demo_aster");
  assert.equal(response.body.budget.limit_uusd, 20_000_000);
  assert.equal(response.body.entries.length, 0);
  const spoofedBody = await request(gateway, { body: { ...sampleBody, tenant_id: "tenant_demo_juniper" } });
  assert.equal(spoofedBody.status, 400);
  assert.equal(spoofedBody.body.error.code, "invalid_request");
});

test("over-budget denial leaves budget and usage unchanged and invokes no provider", async () => {
  const { gateway, store, provider } = makeGateway();
  const before = store.getOverview("tenant_demo_aster");
  const response = await request(gateway, { headers: { "x-aegis-mock-scenario": "budget_denial" } });
  const after = store.getOverview("tenant_demo_aster");
  assert.equal(response.status, 429);
  assert.equal(response.body.error.code, "budget_exceeded");
  assert.equal(response.body.error.quoted_uusd, 13_000_000);
  assert.equal(response.body.error.remaining_uusd, 12_580_000);
  assert.equal(response.body.error.provider_called, false);
  assert.deepEqual(after.budget, before.budget);
  assert.deepEqual(after.entries, before.entries);
  assert.equal(provider.calls, 0);
});

test("exact-limit admission succeeds and next positive-cost request is denied", async () => {
  const tenants = [{ id: "tenant_demo_aster", name: "Exact Limit", limit_uusd: 340_000, seeded_settled_uusd: 0 }];
  const { gateway, store, provider } = makeGateway({ tenants });
  const accepted = await request(gateway, { key: "exact-one" });
  const denied = await request(gateway, { key: "exact-two" });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.budget.settled_uusd, 340_000);
  assert.equal(accepted.body.budget.reserved_uusd, 0);
  assert.equal(denied.status, 429);
  assert.equal(provider.calls, 1);
  const budget = store.getBudget("tenant_demo_aster");
  assert.equal(budget.settled_uusd + budget.reserved_uusd, budget.limit_uusd);
});

test("concurrent requests cannot reserve more than the remaining budget", async () => {
  const tenants = [{ id: "tenant_demo_aster", name: "Concurrent", limit_uusd: 340_000, seeded_settled_uusd: 0 }];
  const provider = new MockProvider({ delayMs: 20 });
  const { gateway, store } = makeGateway({ tenants, provider });
  const responses = await Promise.all([
    request(gateway, { key: "race-one" }),
    request(gateway, { key: "race-two" })
  ]);
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 429]);
  assert.equal(provider.calls, 1);
  const budget = store.getBudget("tenant_demo_aster");
  assert.ok(budget.settled_uusd + budget.reserved_uusd <= budget.limit_uusd);
  assert.equal(store.getUsageCount("tenant_demo_aster"), 1);
});

test("duplicate settlement is idempotent", () => {
  const store = new MemoryLedger({ tenants: [{ id: "tenant_demo_aster", name: "Exact Limit", limit_uusd: 340_000, seeded_settled_uusd: 0 }] });
  const reservation = store.reserve({ tenantId: "tenant_demo_aster", requestId: "req_manual_1", quoteUusd: 340_000 });
  assert.equal(reservation.admitted, true);
  const usage = { model: "demo-model", route: { provider: "mock", model: "mock-chat-v1" }, input_tokens: 128, output_tokens: 42, cost_uusd: 340_000 };
  const first = store.settle({ reservationId: reservation.reservation.reservation_id, usage });
  const second = store.settle({ reservationId: reservation.reservation.reservation_id, usage });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.getUsageCount("tenant_demo_aster"), 1);
  assert.equal(store.getBudget("tenant_demo_aster").settled_uusd, 340_000);
});

test("same idempotency key replays result; changed payload conflicts", async () => {
  const { gateway, provider } = makeGateway();
  const first = await request(gateway, { key: "stable-key" });
  const replay = await request(gateway, { key: "stable-key" });
  const conflict = await request(gateway, { key: "stable-key", body: { ...sampleBody, messages: [{ role: "user", content: "Different prompt" }] } });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers["Idempotency-Replayed"], "true");
  assert.equal(replay.body.id, first.body.id);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "idempotency_conflict");
  assert.equal(provider.calls, 1);
});

test("provider failure returns pending reconciliation and keeps reservation visible", async () => {
  const { gateway, store, provider } = makeGateway();
  const before = store.getOverview("tenant_demo_aster");
  const response = await request(gateway, { headers: { "x-aegis-mock-scenario": "provider_failure" } });
  const after = store.getOverview("tenant_demo_aster");
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, "provider_error");
  assert.equal(response.body.error.settlement_state, "reconcile_required");
  assert.equal(response.body.error.reserved_uusd, 340_000);
  assert.equal(response.body.error.budget.reserved_uusd, 340_000);
  assert.equal(after.budget.settled_uusd, before.budget.settled_uusd);
  assert.equal(after.entries.length, before.entries.length);
  assert.equal(provider.calls, 1);
});

test("local demo credentials are unavailable outside local mode", async () => {
  const gateway = createGateway({ mode: "production", store: new MemoryLedger(), provider: new MockProvider() });
  const response = await request(gateway, { method: "GET", path: "/v1/usage", token: "synthetic-local-token", key: null });
  assert.equal(response.status, 401);
});

test("local demo credentials require explicit token-to-tenant configuration", async () => {
  const local = createGateway({ mode: "local", credentials: new Map([["synthetic-local-token", "tenant_demo_aster"]]), store: new MemoryLedger(), provider: new MockProvider() });
  const disabled = createGateway({ mode: "disabled", store: new MemoryLedger(), provider: new MockProvider() });
  const localResponse = await request(local, { method: "GET", path: "/v1/usage", token: "synthetic-local-token", key: null });
  const disabledResponse = await request(disabled, { method: "GET", path: "/v1/usage", token: "synthetic-local-token", key: null });
  assert.equal(localResponse.status, 200);
  assert.equal(localResponse.body.tenant.id, "tenant_demo_aster");
  assert.equal(disabledResponse.status, 401);
});

test("health response identifies the active storage adapter", async () => {
  const { gateway } = makeGateway();
  const response = await gateway.handle({ method: "GET", path: "/healthz" });
  assert.equal(response.status, 200);
  assert.equal(response.body.storage_mode, "memory");
});

test("local CORS preflight is explicit and rejects unlisted origins", async () => {
  const { gateway } = makeGateway({ mode: "local", allowedOrigin: "http://127.0.0.1:4173" });
  const allowed = await gateway.handle({ method: "OPTIONS", path: "/v1/chat/completions", headers: { origin: "http://127.0.0.1:4173" } });
  const denied = await gateway.handle({ method: "OPTIONS", path: "/v1/chat/completions", headers: { origin: "http://evil.example" } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], "http://127.0.0.1:4173");
  assert.match(allowed.headers["Access-Control-Allow-Headers"], /Idempotency-Key/);
  assert.match(allowed.headers["Access-Control-Allow-Headers"], /X-Aegis-Mock-Scenario/);
  assert.equal(denied.status, 403);
});
