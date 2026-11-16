import type { ActivePolicy, Policy } from "./gateway";

export const demoTargets = [
  { deployment_id: "cad201f4-cd86-4daf-9df7-3a1fbbe07401", priority: 100, weight: 70 },
  { deployment_id: "cad201f4-cd86-4daf-9df7-3a1fbbe07402", priority: 75, weight: 30 },
  { deployment_id: "cad201f4-cd86-4daf-9df7-3a1fbbe07403", priority: 25, weight: 0 },
];
const details = new Map(demoTargets.map((target, index) => [target.deployment_id,
  { name: ["OpenAI", "Anthropic", "Aegis Mock"][index], model: ["gpt-4.1", "claude-sonnet", "mock-chat"][index],
    capabilities: index < 2 ? ["Streaming", "Tools", ...(index === 0 ? ["Vision"] : [])] : ["Streaming"] }]));
export const samplePolicies: Policy[] = [
  {
    id: "demo-auto", version_id: "demo-auto-v3", revision: 3, catalog_revision: 5, model: "auto",
    created_at: "2026-11-13T10:00:00Z", updated_at: "2026-11-16T08:00:00Z", created_by: null, status: "active",
    data_regions: ["us-east"], targets: demoTargets, fallback_edges: [
      { source: demoTargets[0].deployment_id, target: demoTargets[1].deployment_id },
      { source: demoTargets[1].deployment_id, target: demoTargets[2].deployment_id },
    ],
    weights: { cost: 35, latency: 30, reliability: 25, priority: 10 }, enable_weighted: true,
    weighted_band: 25000, default_latency_class: "standard", allowed_latency_classes: ["standard", "interactive"],
  },
  {
    id: "demo-mock", version_id: "demo-mock-v1", revision: 1, catalog_revision: 5, model: "mock-chat",
    created_at: "2026-11-13T10:00:00Z", updated_at: "2026-11-13T10:00:00Z", created_by: null, status: "active",
    data_regions: ["local"], targets: [demoTargets[2]], fallback_edges: [], default_latency_class: "standard",
  },
];
export function displayTarget(id: string, demo: boolean) {
  return (demo ? details.get(id) : null) ?? { name: id.slice(0, 8), model: "Deployment ID", capabilities: [] };
}
export function changeBody(policy: Policy, reason: string): ActivePolicy {
  return {
    model: policy.model, expected_revision: policy.revision, catalog_revision: policy.catalog_revision,
    status: "active", change_reason: reason.trim(), targets: policy.targets, fallback_edges: policy.fallback_edges,
    weights: policy.weights, weighted_band: policy.weighted_band, enable_weighted: policy.enable_weighted,
    cost_reference_microusd: policy.cost_reference_microusd, max_request_cost_microusd: policy.max_request_cost_microusd,
    allow_ambiguous_failover: policy.allow_ambiguous_failover, data_regions: policy.data_regions,
    default_latency_class: policy.default_latency_class, allowed_latency_classes: policy.allowed_latency_classes,
    enforce_predicted_ceiling: policy.enforce_predicted_ceiling,
  };
}
export function hasCycle(edges: { source: string; target: string }[]) {
  function visit(node: string, chain: Set<string>): boolean {
    if (chain.has(node)) return true;
    const next = new Set(chain).add(node);
    return edges.filter((edge) => edge.source === node).some((edge) => visit(edge.target, next));
  }
  return edges.some((edge) => visit(edge.source, new Set()));
}

const samplePenalties = [
  { cost: 3200, latency: 2450, reliability: 800 },
  { cost: 5300, latency: 3200, reliability: 1200 },
  { cost: 2400, latency: 550, reliability: 750 },
];
export function previewScores(policy: Policy) {
  const weights = { cost: 35, latency: 30, reliability: 25, priority: 10, ...policy.weights };
  return policy.targets.map((target) => {
    const sample = samplePenalties[demoTargets.findIndex((item) => item.deployment_id === target.deployment_id)];
    if (!sample) return null;
    return { id: target.deployment_id, priority: target.priority, score: weights.cost * sample.cost +
      weights.latency * sample.latency + weights.reliability * sample.reliability +
      weights.priority * (10000 - 100 * target.priority) };
  }).filter((item) => item !== null).sort((a, b) => a.score - b.score || b.priority - a.priority || a.id.localeCompare(b.id));
}
