import test from "node:test";
import assert from "node:assert/strict";
import { createHttpAdapter } from "../../frontend/src/api.js";
import { createGateway } from "../src/gateway.js";
import { MemoryLedger } from "../src/ledger.js";
import { MockProvider } from "../src/mock-provider.js";

test("Step 5 HTTP adapter interoperates with the backend contract", async () => {
  const store = new MemoryLedger({ tenants: [{ id: "tenant_demo_aster", name: "Aster Labs", limit_uusd: 340_000, seeded_settled_uusd: 0 }] });
  const provider = new MockProvider();
  const gateway = createGateway({ mode: "test", credentials: new Map([["frontend-token", "tenant_demo_aster"]]), store, provider });
  let keyCounter = 0;
  const adapter = createHttpAdapter({
    baseUrl: "http://gateway.test",
    getAccessToken: async () => "frontend-token",
    makeIdempotencyKey: () => `frontend-key-${++keyCounter}`,
    fetchImpl: async (url, options = {}) => {
      const address = new URL(url);
      const reply = await gateway.handle({
        method: options.method ?? "GET",
        path: address.pathname + address.search,
        headers: options.headers ?? {},
        body: options.body ? JSON.parse(options.body) : null
      });
      return new Response(reply.body == null ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
    }
  });

  const before = await adapter.getOverview();
  assert.equal(before.tenantId, "tenant_demo_aster");
  assert.equal(before.entries.length, 0);
  const success = await adapter.submitRequest({ model: "demo-model", prompt: "Hello from the frontend", maxTokens: 128 });
  assert.equal(success.kind, "success");
  assert.equal(success.requestId, "req_local_000001");
  assert.deepEqual(success.route, { provider: "mock", model: "mock-chat-v1" });
  assert.equal(success.usage.cost_uusd, 340_000);
  assert.equal(success.budget.settled_uusd, 340_000);
  const overview = await adapter.getOverview();
  assert.equal(overview.entries[0].request_id, success.requestId);

  const denied = await adapter.submitRequest({ model: "demo-model", prompt: "Second request", maxTokens: 128 });
  assert.equal(denied.kind, "denied");
  assert.equal(denied.providerCalled, false);
  assert.equal(denied.quote_uusd, 340_000);
  assert.equal(denied.remaining_uusd, 0);
  assert.equal(provider.calls, 1);
});
