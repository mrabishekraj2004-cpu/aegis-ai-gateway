import { dayString, dates, type UsageRow, type UsagePage } from "./gateway";

const anchor = new Date("2026-11-16T00:00:00Z");
const requestShape = [4.9, 6.8, 6.4, 8.1, 7.7, 9.2, 8.1, 10.5, 9.8, 11.7, 10.9, 13.5, 12.1, 14.1, 13.4, 15.8];
const modelNames = ["gpt-4.1", "claude-sonnet", "mock-chat"] as const;

export const demoProviders = [
  { name: "OpenAI", mark: "O", color: "teal", state: "Operational", availability: "99.98%", latency: "842 ms", models: 2, breaker: "Closed", load: 67 },
  { name: "Anthropic", mark: "A", color: "sand", state: "Operational", availability: "99.95%", latency: "1.18 s", models: 1, breaker: "Closed", load: 30 },
  { name: "Aegis Mock", mark: "M", color: "slate", state: "Operational", availability: "100%", latency: "24 ms", models: 1, breaker: "Closed", load: 3 },
] as const;

export const demoModels = [
  { id: "gpt-4.1", provider: "OpenAI", context: "1,047,576", capabilities: ["Streaming", "Tools", "Vision"], input: 2_000_000, output: 8_000_000 },
  { id: "gpt-4.1-mini", provider: "OpenAI", context: "1,047,576", capabilities: ["Streaming", "Tools", "Vision"], input: 400_000, output: 1_600_000 },
  { id: "claude-sonnet", provider: "Anthropic", context: "200,000", capabilities: ["Streaming", "Tools"], input: 3_000_000, output: 15_000_000 },
  { id: "mock-chat", provider: "Aegis Mock", context: "18,432", capabilities: ["Streaming"], input: 1_000_000, output: 2_000_000 },
];

export const demoActivity = [
  { id: "req_81f2ab", ago: "2 min ago", model: "gpt-4.1", provider: "OpenAI", latency: "842 ms", tokens: 1284, state: "Completed" },
  { id: "req_97c1de", ago: "5 min ago", model: "claude-sonnet", provider: "Anthropic", latency: "1.18 s", tokens: 2496, state: "Completed" },
  { id: "req_3acb80", ago: "8 min ago", model: "gpt-4.1", provider: "OpenAI", latency: "1.65 s", tokens: 1056, state: "Fallback" },
  { id: "req_64bd10", ago: "12 min ago", model: "mock-chat", provider: "Aegis Mock", latency: "24 ms", tokens: 384, state: "Completed" },
  { id: "req_21d7f4", ago: "16 min ago", model: "claude-sonnet", provider: "Anthropic", latency: "—", tokens: 112, state: "Rate limited" },
];

export const demoBudgets = [
  { name: "Platform engineering", spent: 548.16, limit: 1000 },
  { name: "Applied research", spent: 218.40, limit: 300 },
  { name: "Internal automation", spent: 57.60, limit: 150 },
];

export const demoIncidents = [
  { date: "Nov 16 · 10:28 UTC", provider: "Anthropic", event: "Rate limit reached", result: "Traffic shifted to OpenAI", tone: "warn" },
  { date: "Nov 15 · 21:14 UTC", provider: "OpenAI", event: "Transient upstream timeout", result: "Retry succeeded", tone: "info" },
  { date: "Nov 15 · 08:42 UTC", provider: "Anthropic", event: "Circuit closed", result: "Probe succeeded", tone: "good" },
] as const;

export const demoAudit = [
  { date: "Nov 16 · 09:40 UTC", action: "Routing policy updated", actor: "alex@example.test", target: "Default route" },
  { date: "Nov 15 · 17:25 UTC", action: "API key rotated", actor: "ops@example.test", target: "inference-worker" },
  { date: "Nov 15 · 11:06 UTC", action: "Tenant member added", actor: "alex@example.test", target: "Applied research" },
];

export function demoUsage(days: number): UsagePage {
  const period = dates(days, anchor);
  const data = Array.from({ length: days }, (_, index): UsageRow => {
    const day = dayString(new Date(Date.parse(period.from) + index * 86_400_000));
    const wave = requestShape[(index + requestShape.length - (days % requestShape.length)) % requestShape.length];
    const requests = Math.round(wave * (days < 15 ? 940 : 890) + (index % 4) * 105);
    const prompt = Math.round(requests * (366 + index % 5 * 11));
    const completion = Math.round(requests * (207 + index % 3 * 17));
    const finalized = Math.round(requests * (4948 + index % 4 * 265));
    const estimated = Math.round(finalized * 0.078);
    return {
      day, model: null, requests: String(requests), attempts: String(requests + 44),
      reported_attempts: String(requests + 19), estimated_attempts: "18", adjusted_attempts: "2",
      confirmed_nonbillable_attempts: "3", pending_attempts: "2",
      prompt_tokens_observed: String(prompt), completion_tokens_observed: String(completion),
      unknown_token_attempts: "25", reported_microusd: String(finalized - estimated - 13422),
      estimated_microusd: String(estimated), adjusted_microusd: "13422", pending_hold_microusd: "38400",
      total_finalized_microusd: String(finalized),
    };
  });
  return { data, object: "list", currency: "USD", as_of: "2026-11-16T14:30:00Z",
    complete_through: "2026-11-15", has_more: false, next_cursor: null, range: period };
}

const sums = ["requests", "attempts", "prompt_tokens_observed", "completion_tokens_observed",
  "unknown_token_attempts", "reported_microusd", "estimated_microusd", "adjusted_microusd",
  "pending_hold_microusd", "total_finalized_microusd"] as const;
export type SumKey = typeof sums[number];

export function totals(rows: UsageRow[]) {
  const out = Object.fromEntries(sums.map((key) => [key, 0n])) as Record<SumKey, bigint>;
  for (const row of rows) for (const key of sums) out[key] += BigInt(row[key]);
  return out;
}

export function demoModelUsage(days: number) {
  const summary = totals(demoUsage(days).data);
  return modelNames.map((model, index) => ({ model, share: [54, 43, 3][index],
    spend: summary.total_finalized_microusd * BigInt([54, 43, 3][index]) / 100n,
    tokens: (summary.prompt_tokens_observed + summary.completion_tokens_observed) * BigInt([61, 34, 5][index]) / 100n }));
}

export function compact(value: number | bigint) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
export function number(value: number | bigint) {
  return new Intl.NumberFormat("en-US").format(value);
}
export function usd(micro: number | bigint) {
  const value = BigInt(micro);
  const negative = value < 0n;
  const cents = ((negative ? -value : value) + 5000n) / 10000n;
  return `${negative ? "−" : ""}$${number(cents / 100n)}.${String(cents % 100n).padStart(2, "0")}`;
}
export function dateLabel(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso));
}
export function series(page: UsagePage, previous = false) {
  const indexed = new Map(page.data.map((row) => [row.day, row]));
  const start = Date.parse(page.range.from), end = Date.parse(page.range.to);
  return Array.from({ length: Math.round((end - start) / 86_400_000) }, (_, index) => {
    const day = dayString(new Date(start + index * 86_400_000));
    const row = indexed.get(day);
    return {
      day, label: dateLabel(day),
      requests: Number(row?.requests ?? 0),
      previous: previous ? Math.round(Number(row?.requests ?? 0) * (0.75 + 0.13 * Math.sin(index * 0.91))) : undefined,
      reported: Number(row?.reported_microusd ?? 0) / 1e6,
      estimated: Number(row?.estimated_microusd ?? 0) / 1e6,
      adjusted: Number(row?.adjusted_microusd ?? 0) / 1e6,
      input: Number(row?.prompt_tokens_observed ?? 0),
      output: Number(row?.completion_tokens_observed ?? 0),
      error: previous ? Number((0.33 + 0.14 * (1 + Math.sin(index * 1.42)) + (index % 9 === 4 ? 0.41 : 0)).toFixed(2)) : undefined,
    };
  });
}

export type SeriesPoint = ReturnType<typeof series>[number];
