const usdToUusd = price => Math.ceil(price * 1_000_000);

export class PricingCatalog {
  constructor({ versions = [] } = {}) { this.versions = versions; }

  find({ provider, model, region = "global", at = new Date() }) {
    return this.versions
      .filter(row => row.provider === provider && row.model === model && (row.region === region || row.region === "global") && Date.parse(row.effective_at) <= at.getTime() && (!row.effective_until || Date.parse(row.effective_until) > at.getTime()))
      .sort((a, b) => Date.parse(b.effective_at) - Date.parse(a.effective_at))[0] ?? null;
  }

  calculate({ pricing, inputTokens, outputTokens, fixedCostUusd = 0 }) {
    if (!pricing) return fixedCostUusd;
    const input = usdToUusd((inputTokens / 1_000_000) * Number(pricing.input_usd_per_million));
    const output = usdToUusd((outputTokens / 1_000_000) * Number(pricing.output_usd_per_million));
    return input + output + fixedCostUusd;
  }
}

export function createDefaultPricing() {
  return new PricingCatalog({ versions: [
    { version: "mock-v1", provider: "mock", model: "mock-chat-v1", region: "global", unit: "token", input_usd_per_million: 0, output_usd_per_million: 0, effective_at: "2020-01-01T00:00:00.000Z" }
  ] });
}
