const pause = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

export class MockProvider {
  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs;
    this.calls = 0;
    this.route = { provider: "mock", model: "mock-chat-v1" };
  }

  resolveRoute(alias) {
    if (alias !== "demo-model") return null;
    return { ...this.route };
  }

  quote({ scenario = "success" } = {}) {
    // The local denial scenario deliberately exceeds both seeded tenants' budgets.
    return scenario === "budget_denial" ? 13_000_000 : 340_000;
  }

  async invoke({ route, prompt, scenario = "success" }) {
    this.calls += 1;
    await pause(this.delayMs);
    if (scenario === "provider_failure") {
      return { kind: "failure", message: "The deterministic mock failed before returning usage." };
    }
    return {
      kind: "success",
      response: "The top themes are delivery experience and product reliability. Customers value the fast turnaround and want clearer status updates.",
      usage: {
        model: "demo-model",
        route: { ...route },
        input_tokens: 128,
        output_tokens: 42,
        cost_uusd: 340_000,
        status: "completed"
      }
    };
  }
}
