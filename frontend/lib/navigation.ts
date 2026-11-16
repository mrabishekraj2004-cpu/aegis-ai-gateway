import { Activity, BarChart3, Boxes, CircleDollarSign, Gauge, GitFork, Shield, SquareTerminal } from "lucide-react";

export const navigation = [
  { key: "overview", label: "Overview", href: "/", group: "Monitor", icon: Gauge, description: "Gateway traffic, usage, and availability" },
  { key: "analytics", label: "Request analytics", href: "/analytics/", group: "Monitor", icon: BarChart3, description: "Request volume, errors, and latency" },
  { key: "cost", label: "Cost intelligence", href: "/cost/", group: "Monitor", icon: CircleDollarSign, description: "Token consumption, costs, and budgets" },
  { key: "reliability", label: "Reliability center", href: "/reliability/", group: "Monitor", icon: Activity, description: "Health, retries, fallbacks, and circuit breakers" },
  { key: "routing", label: "Routing console", href: "/routing/", group: "Configure", icon: GitFork, description: "Policy versions, priorities, and fallback paths" },
  { key: "providers", label: "Providers", href: "/providers/", group: "Configure", icon: Boxes, description: "Provider inventory and model aliases" },
  { key: "access", label: "Security & access", href: "/access/", group: "Configure", icon: Shield, description: "Credentials, tenants, and audit controls" },
  { key: "playground", label: "Playground", href: "/playground/", group: "Develop", icon: SquareTerminal, description: "Run completion requests and inspect streaming output" },
] as const;
export type View = typeof navigation[number]["key"];
