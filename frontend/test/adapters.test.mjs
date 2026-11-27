import test from "node:test";
import assert from "node:assert/strict";
import { createSimulatedAdapter } from "../src/fixtures.js";
import { createHttpAdapter } from "../src/api.js";

const sample = { tenantId: "aster", model: "demo-model", prompt: "Summarize customer feedback", maxTokens: 128 };

test("successful fixture returns route, usage, correlated ID, and settled budget", async () => {
  const adapter = createSimulatedAdapter();
  const before = await adapter.getOverview("aster");
  assert.equal(before.budget.settled_uusd, 7_420_000);
  assert.equal(before.entries.length, 3);

  const result = await adapter.submitRequest({ ...sample, scenario: "success" });
  const after = await adapter.getOverview("aster");
  assert.equal(result.kind, "success");
  assert.equal(result.requestId, "req_ast_004");
  assert.deepEqual(result.route, { provider: "mock", model: "mock-chat-v1" });
  assert.equal(result.usage.cost_uusd, 340_000);
  assert.equal(result.usage.total_tokens, 170);
  assert.equal(after.budget.settled_uusd, 7_760_000);
  assert.equal(after.budget.limit_uusd - after.budget.settled_uusd - after.budget.reserved_uusd, 12_240_000);
  assert.equal(after.entries[0].request_id, result.requestId);
  assert.equal(adapter.getProviderCallCount(), 1);
});

test("budget denial changes neither budget nor usage and never calls provider", async () => {
  const adapter = createSimulatedAdapter();
  const before = await adapter.getOverview("aster");
  const result = await adapter.submitRequest({ ...sample, scenario: "denied" });
  const after = await adapter.getOverview("aster");
  assert.equal(result.kind, "denied");
  assert.equal(result.providerCalled, false);
  assert.equal(result.quote_uusd, 13_000_000);
  assert.deepEqual(after.budget, before.budget);
  assert.deepEqual(after.entries, before.entries);
  assert.equal(adapter.getProviderCallCount(), 0);
});

test("provider failure keeps its reservation visible without settled usage", async () => {
  const adapter = createSimulatedAdapter();
  const before = await adapter.getOverview("aster");
  const result = await adapter.submitRequest({ ...sample, scenario: "failure" });
  const after = await adapter.getOverview("aster");
  assert.equal(result.kind, "failure");
  assert.equal(result.settlement_state, "reconcile_required");
  assert.equal(after.budget.settled_uusd, before.budget.settled_uusd);
  assert.equal(after.budget.reserved_uusd, 340_000);
  assert.equal(after.entries.length, before.entries.length);
  assert.equal(after.budget.limit_uusd - after.budget.settled_uusd - after.budget.reserved_uusd, 12_240_000);
  assert.equal(adapter.getProviderCallCount(), 1);
});

test("simulated tenants keep budgets and histories separate", async () => {
  const adapter = createSimulatedAdapter();
  const asterBefore = await adapter.getOverview("aster");
  const juniperBefore = await adapter.getOverview("juniper");
  assert.equal(juniperBefore.budget.limit_uusd, 10_000_000);
  assert.equal(juniperBefore.entries.length, 0);
  await adapter.submitRequest({ ...sample, tenantId: "juniper", scenario: "success" });
  const asterAfter = await adapter.getOverview("aster");
  const juniperAfter = await adapter.getOverview("juniper");
  assert.deepEqual(asterAfter, asterBefore);
  assert.equal(juniperAfter.entries.length, 1);
  assert.equal(juniperAfter.budget.settled_uusd, 340_000);
});

test("simulated adapter rejects unknown tenants and blank prompts", async () => {
  const adapter = createSimulatedAdapter();
  await assert.rejects(adapter.getOverview("unknown"), /Unknown simulated tenant/);
  await assert.rejects(adapter.submitRequest({ ...sample, prompt: "  " }), /prompt is required/i);
});

test("HTTP adapter uses bearer auth and idempotency without sending a tenant ID", async () => {
  const requests = [];
  const http = createHttpAdapter({
    baseUrl: "http://gateway.test/",
    getAccessToken: async () => "test-token",
    makeIdempotencyKey: () => "idem-test-1",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: "req_live_1", model: "demo-model", route: { provider: "mock", model: "mock-chat-v1" }, choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost_uusd: 1000 }, budget: { limit_uusd: 1000000, settled_uusd: 1000, reserved_uusd: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await http.submitRequest({ ...sample, tenantId: "must-not-be-sent" });
  assert.equal(result.kind, "success");
  assert.equal(requests[0].url, "http://gateway.test/v1/chat/completions");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(requests[0].options.headers["Idempotency-Key"], "idem-test-1");
  assert.equal("tenantId" in JSON.parse(requests[0].options.body), false);
  assert.equal(JSON.parse(requests[0].options.body).max_tokens, 128);
});

test("HTTP adapter maps budget and provider errors into distinct UI states", async () => {
  const body = status => async () => new Response(JSON.stringify({ error: { code: status === 429 ? "budget_exceeded" : "provider_error", request_id: "req_error_1", quoted_uusd: 13_000_000, remaining_uusd: 12_580_000, reserved_uusd: 340_000, message: "fixture error" } }), { status, headers: { "content-type": "application/json" } });
  const options = { baseUrl: "http://gateway.test", getAccessToken: async () => "token", makeIdempotencyKey: () => "idempotent" };
  const denied = await createHttpAdapter({ ...options, fetchImpl: body(429) }).submitRequest(sample);
  const failed = await createHttpAdapter({ ...options, fetchImpl: body(502) }).submitRequest(sample);
  assert.equal(denied.kind, "denied");
  assert.equal(denied.providerCalled, false);
  assert.equal(failed.kind, "failure");
  assert.equal(failed.settlement_state, "reconcile_required");
  assert.equal(failed.reserved_uusd, 340_000);
});

test("HTTP adapter loads tenant-scoped overview and requires API configuration", async () => {
  const requestedUrls = [];
  const adapter = createHttpAdapter({
    baseUrl: "http://gateway.test",
    getAccessToken: async () => "tenant-token",
    fetchImpl: async url => {
      requestedUrls.push(url);
      if (url.endsWith("/healthz")) return new Response(JSON.stringify({ status: "ok", storage_mode: "postgres" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({
        tenant: { id: "server-resolved", name: "Authenticated tenant" },
        budget: { limit_uusd: 1_000_000, settled_uusd: 200_000, reserved_uusd: 100_000, window_start: "2026-11-01T00:00:00Z", window_end: "2026-12-01T00:00:00Z" },
        entries: []
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const overview = await adapter.getOverview();
  assert.deepEqual(requestedUrls.sort(), ["http://gateway.test/healthz", "http://gateway.test/v1/usage"]);
  assert.equal(overview.tenantId, "server-resolved");
  assert.equal(overview.budget.reserved_uusd, 100_000);
  assert.equal(overview.storageMode, "postgres");
  assert.deepEqual(overview.entries, []);

  const unconfigured = createHttpAdapter({ fetchImpl: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(unconfigured.getOverview(), /apiBaseUrl/);
});

test("local API demo sends only the deterministic provider-failure control", async () => {
  const requests = [];
  const options = {
    baseUrl: "http://gateway.test",
    getAccessToken: async () => "test-local-token",
    makeIdempotencyKey: () => "local-demo-key",
    localDemoMode: true,
    fetchImpl: async (url, request = {}) => {
      requests.push({ url, request });
      return new Response(JSON.stringify({ id: "req_demo", model: "demo-model", route: { provider: "mock", model: "mock-chat-v1" }, choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_uusd: 340_000 }, budget: { limit_uusd: 340_000, settled_uusd: 340_000, reserved_uusd: 0 } }), { status: 200 });
    }
  };
  const adapter = createHttpAdapter(options);
  await adapter.submitRequest({ ...sample, scenario: "denied" });
  await adapter.submitRequest({ ...sample, scenario: "failure" });
  assert.equal(requests[0].request.headers["X-Aegis-Mock-Scenario"], undefined);
  assert.equal(requests[1].request.headers["X-Aegis-Mock-Scenario"], "provider_failure");
  assert.equal("tenantId" in JSON.parse(requests[1].request.body), false);

  const nonDemoRequests = [];
  const nonDemo = createHttpAdapter({ ...options, localDemoMode: false, fetchImpl: async (url, request = {}) => {
    nonDemoRequests.push(request);
    return new Response(JSON.stringify({ id: "req_demo", choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
  } });
  await nonDemo.submitRequest({ ...sample, scenario: "failure" });
  assert.equal(nonDemoRequests[0].headers["X-Aegis-Mock-Scenario"], undefined);
});

test("API network failure is surfaced without a fixture result", async () => {
  const adapter = createHttpAdapter({
    baseUrl: "http://gateway.test",
    getAccessToken: async () => "test-token",
    fetchImpl: async () => { throw new Error("gateway unavailable"); }
  });
  await assert.rejects(adapter.submitRequest(sample), /gateway unavailable/);
});
