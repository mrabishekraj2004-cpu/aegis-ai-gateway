const clone = value => structuredClone(value);
const seeds = {
  aster: {
    tenantId: "tenant_demo_aster", tenantName: "Aster Labs", initials: "A",
    budget: { limit_uusd: 20_000_000, settled_uusd: 7_420_000, reserved_uusd: 0, window_start: "2026-11-01T00:00:00Z", window_end: "2026-12-01T00:00:00Z" },
    nextRequest: 4,
    entries: [
      { request_id: "req_ast_003", model: "demo-model", route: { provider: "mock", model: "mock-chat-v1" }, input_tokens: 400, output_tokens: 142, total_tokens: 542, cost_uusd: 182_000, created_at: "Today, 10:42 AM", status: "completed" },
      { request_id: "req_ast_002", model: "demo-model", route: { provider: "mock", model: "mock-chat-v1" }, input_tokens: 218, output_tokens: 84, total_tokens: 302, cost_uusd: 126_000, created_at: "Today, 9:18 AM", status: "completed" },
      { request_id: "req_ast_001", model: "demo-model", route: { provider: "mock", model: "mock-chat-v1" }, input_tokens: 510, output_tokens: 200, total_tokens: 710, cost_uusd: 214_000, created_at: "Yesterday, 4:06 PM", status: "completed" }
    ]
  },
  juniper: {
    tenantId: "tenant_demo_juniper", tenantName: "Juniper Health", initials: "J",
    budget: { limit_uusd: 10_000_000, settled_uusd: 0, reserved_uusd: 0, window_start: "2026-11-01T00:00:00Z", window_end: "2026-12-01T00:00:00Z" },
    nextRequest: 1,
    entries: []
  }
};

const available = budget => budget.limit_uusd - budget.settled_uusd - budget.reserved_uusd;
const pause = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

export function createSimulatedAdapter({ delayMs = 0 } = {}) {
  let tenants = clone(seeds);
  let providerCalls = 0;

  function selectTenant(tenantId) {
    const tenant = tenants[tenantId];
    if (!tenant) throw new Error("Unknown simulated tenant.");
    return tenant;
  }

  function snapshot(tenant) {
    return clone({ tenantId: tenant.tenantId, tenantName: tenant.tenantName, initials: tenant.initials, budget: tenant.budget, entries: tenant.entries });
  }

  return {
    mode: "simulated",
    async listTenants() {
      return Object.entries(tenants).map(([id, tenant]) => ({ id, name: tenant.tenantName, initials: tenant.initials }));
    },
    async getOverview(tenantId = "aster") {
      await pause(delayMs);
      return snapshot(selectTenant(tenantId));
    },
    async submitRequest({ tenantId = "aster", model = "demo-model", prompt, maxTokens = 128, scenario = "success" }) {
      await pause(delayMs);
      const tenant = selectTenant(tenantId);
      const requestId = `req_${tenantId === "aster" ? "ast" : "jun"}_${String(tenant.nextRequest++).padStart(3, "0")}`;
      if (!String(prompt || "").trim()) throw new Error("A prompt is required.");

      if (scenario === "denied") {
        const quoted = 13_000_000;
        const remaining = available(tenant.budget);
        if (quoted <= remaining) throw new Error("Denial fixture must quote above the tenant's remaining budget.");
        return { kind: "denied", requestId, code: "budget_exceeded", quote_uusd: quoted, remaining_uusd: remaining, budget: clone(tenant.budget), providerCalled: false };
      }

      if (scenario === "failure") {
        providerCalls += 1;
        const quote = 340_000;
        tenant.budget.reserved_uusd += quote;
        return { kind: "failure", requestId, code: "provider_error", message: "The mock provider returned no final usage.", providerCalled: true, settlement_state: "reconcile_required", reserved_uusd: quote, budget: clone(tenant.budget) };
      }

      const cost = 340_000;
      const remaining = available(tenant.budget);
      if (cost > remaining) return { kind: "denied", requestId, code: "budget_exceeded", quote_uusd: cost, remaining_uusd: remaining, budget: clone(tenant.budget), providerCalled: false };
      providerCalls += 1;
      const entry = {
        request_id: requestId, model,
        route: { provider: "mock", model: "mock-chat-v1" },
        input_tokens: 128, output_tokens: 42, total_tokens: 170,
        cost_uusd: cost, created_at: "Just now", status: "completed"
      };
      tenant.budget.settled_uusd += cost;
      tenant.entries.unshift(entry);
      return { kind: "success", requestId, response: "The top themes are delivery experience and product reliability. Customers value the fast turnaround and want clearer status updates.", usage: clone(entry), budget: clone(tenant.budget), route: clone(entry.route), providerCalled: true };
    },
    reset() {
      tenants = clone(seeds);
      providerCalls = 0;
    },
    getProviderCallCount() {
      return providerCalls;
    }
  };
}
