import { ProviderAdapter } from "./provider-interface.js";

const pause = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

export class MockProvider extends ProviderAdapter {
  constructor({ delayMs = 0, reconcile = async () => ({ kind: "unknown", message: "The mock has no provider receipt for this request." }) } = {}) {
    super("mock");
    this.delayMs = delayMs;
    this.reconcileOutcome = reconcile;
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

  async *stream({ route, prompt, scenario = "success", signal }) {
    this.calls += 1;
    await pause(this.delayMs);
    if (scenario === "provider_failure") throw Object.assign(new Error("The deterministic mock failed before returning usage."), { outcomeUnknown: true, retryable: false });
    const answer="The top themes are delivery experience and product reliability. Customers value the fast turnaround and want clearer status updates.";
    let output="";
    for (let offset=0;offset<answer.length;offset+=18) {
      if (signal?.aborted) break;
      const text=answer.slice(offset,offset+18);
      output+=text;
      yield {type:"delta",text};
      await pause(this.delayMs);
    }
    const inputTokens=128;
    const outputTokens=Math.ceil(output.length/4);
    const cost=output.length===answer.length?340_000:Math.ceil(340_000*(inputTokens+outputTokens)/(128+42));
    yield {type:"usage",usage:{model:"demo-model",route,input_tokens:inputTokens,output_tokens:outputTokens,cost_uusd:cost,provider_cost_uusd:cost,status:output.length===answer.length?"completed":"partial"}};
    yield {type:"done"};
  }

  async reconcile(context) { return this.reconcileOutcome(context); }
}
