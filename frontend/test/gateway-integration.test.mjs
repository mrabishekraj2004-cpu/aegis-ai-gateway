import test from "node:test";
import assert from "node:assert/strict";
import { createHttpAdapter } from "../src/api.js";
import { MemoryLedger } from "../../backend/src/ledger.js";
import { MockProvider } from "../../backend/src/mock-provider.js";
import { createGateway } from "../../backend/src/gateway.js";

test("Step 8 live adapter flow covers success, actual cap denial, provider failure, and tenant isolation", async () => {
  const store = new MemoryLedger();
  const provider = new MockProvider();
  const tokens = new Map([
    ["synthetic-aster-token", "tenant_demo_aster"],
    ["synthetic-juniper-token", "tenant_demo_juniper"],
    ["synthetic-budget-token", "tenant_demo_budget"]
  ]);
  const gateway = createGateway({ mode: "local", credentials: tokens, store, provider, allowedOrigin: "http://127.0.0.1:4173" });
  let accessToken = "synthetic-budget-token";
  let keyNumber = 0;
  const adapter = createHttpAdapter({
    baseUrl: "http://gateway.local",
    localDemoMode: true,
    getAccessToken: async () => accessToken,
    makeIdempotencyKey: () => `step8-${++keyNumber}`,
    fetchImpl: async (address, options = {}) => {
      const url = new URL(address);
      const response = await gateway.handle({
        method: options.method ?? "GET",
        path: url.pathname + url.search,
        headers: { ...(options.headers ?? {}), origin: "http://127.0.0.1:4173" },
        body: options.body ? JSON.parse(options.body) : null
      });
      return new Response(response.body == null ? null : JSON.stringify(response.body), { status: response.status, headers: response.headers });
    }
  });

  const initial = await adapter.getOverview();
  assert.equal(initial.tenantId, "tenant_demo_budget");
  assert.equal(initial.storageMode, "memory");
  assert.equal(initial.budget.limit_uusd, 340_000);
  assert.equal(initial.entries.length, 0);

  const success = await adapter.submitRequest({
    model: "demo-model", prompt: "Summarize feedback", maxTokens: 128, tenantId: "spoofed-tenant", scenario: "success"
  });
  assert.equal(success.kind, "success");
  assert.equal(success.route.provider, "mock");
  assert.equal(success.route.model, "mock-chat-v1");
  assert.equal(success.route.alias, "demo-model");
  assert.ok(success.route.config_version);
  assert.equal(success.route.decision.reason, "priority_weighted");
  assert.equal(success.response.length > 0, true);
  assert.equal(success.usage.cost_uusd, 340_000);
  assert.equal(success.budget.settled_uusd, 340_000);
  const afterSuccess = await adapter.getOverview();
  assert.equal(afterSuccess.entries.length, 1);
  assert.equal(afterSuccess.entries[0].request_id, success.requestId);
  assert.equal(afterSuccess.entries[0].cost_uusd, success.usage.cost_uusd);
  assert.equal(afterSuccess.budget.limit_uusd - afterSuccess.budget.settled_uusd - afterSuccess.budget.reserved_uusd, 0);
  assert.equal(provider.calls, 1);

  const denied = await adapter.submitRequest({ model: "demo-model", prompt: "Run against the actual cap", maxTokens: 128, scenario: "denied" });
  assert.equal(denied.kind, "denied");
  assert.equal(denied.quote_uusd, 340_000);
  assert.equal(denied.remaining_uusd, 0);
  assert.equal(denied.providerCalled, false);
  const afterDenial = await adapter.getOverview();
  assert.deepEqual(afterDenial.budget, afterSuccess.budget);
  assert.deepEqual(afterDenial.entries, afterSuccess.entries);
  assert.equal(provider.calls, 1);

  accessToken = "synthetic-aster-token";
  const aster = await adapter.getOverview();
  assert.equal(aster.tenantId, "tenant_demo_aster");
  assert.equal(aster.budget.limit_uusd, 20_000_000);
  assert.notEqual(aster.budget.limit_uusd, afterDenial.budget.limit_uusd);
  const failure = await adapter.submitRequest({ model: "demo-model", prompt: "Trigger pending reconciliation", maxTokens: 128, scenario: "failure" });
  assert.equal(failure.kind, "failure");
  assert.equal(failure.providerCalled, true);
  assert.equal(failure.settlement_state, "reconcile_required");
  assert.equal(failure.reserved_uusd, 340_000);
  const afterFailure = await adapter.getOverview();
  assert.equal(afterFailure.budget.reserved_uusd, 340_000);
  assert.equal(afterFailure.budget.settled_uusd, aster.budget.settled_uusd);
  assert.equal(afterFailure.entries.length, aster.entries.length);
  assert.equal(provider.calls, 2);

  accessToken = "synthetic-juniper-token";
  const juniper = await adapter.getOverview();
  assert.equal(juniper.tenantId, "tenant_demo_juniper");
  assert.equal(juniper.budget.limit_uusd, 10_000_000);
  assert.equal(juniper.entries.length, 0);
  assert.equal((await adapter.getOverview()).storageMode, "memory");
});

test("live API adapter reports no fallback when the gateway is unreachable", async () => {
  const adapter = createHttpAdapter({
    baseUrl: "http://gateway.local",
    getAccessToken: async () => "synthetic-token",
    fetchImpl: async () => { throw new Error("connection refused"); }
  });
  await assert.rejects(adapter.getOverview(), /connection refused/);
  await assert.rejects(adapter.submitRequest({ model: "demo-model", prompt: "Hello", maxTokens: 128 }), /connection refused/);
});
