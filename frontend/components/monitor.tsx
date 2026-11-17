"use client";

import { useCallback, useState, type ReactNode } from "react";
import {
  Activity, ArrowDownToLine, ArrowUpRight, CircleDollarSign, Clock3, Gauge, Globe2, Layers3, Repeat2,
  Server, Shield, Waypoints, type LucideIcon,
} from "lucide-react";
import { Chart } from "./charts";
import { ConsoleButton, DateRange, SourceNotice } from "./shell-parts";
import { useConsole, useResource } from "./session";
import { Badge, Busy, Empty, Hint, Issue, Metric, Modal, Notice, PageHead, Panel, Table, TextLink } from "./ui";
import { compact, dateLabel, demoActivity, demoBudgets, demoIncidents, demoModelUsage, demoProviders,
  demoUsage, number, series, totals, usd } from "@/lib/data";
import { health, usage, type Group, type UsageRow } from "@/lib/gateway";

function useUsage(group: Group = "day") {
  const { connection, days } = useConsole();
  const query = useCallback((signal: AbortSignal) => usage(connection!, days, group, signal), [connection, days, group]);
  const result = useResource(connection ? query : null);
  return { ...result, page: connection ? result.data : group === "day" ? demoUsage(days) : undefined };
}

export function GatewayHealth({ compact: small = false }: { compact?: boolean }) {
  const { connection } = useConsole();
  const load = useCallback((signal: AbortSignal) => health(connection!, signal), [connection]);
  const result = useResource(connection ? load : null);
  if (!connection) {
    return <div className={`health-line ${small ? "health-small" : ""}`}><Badge tone="good" dot>Operational</Badge>
      <span>Illustrative gateway readiness</span></div>;
  }
  if (result.loading) return <Busy compact label="Checking gateway readiness" />;
  if (result.error) return <Issue message={result.error} retry={result.retry} />;
  if (!result.data) return null;
  const status = result.data.status;
  return <div className={`health-line ${small ? "health-small" : ""}`}><Badge dot tone={status === "ok" ? "good" :
    status === "degraded" ? "warn" : status === "unavailable" ? "bad" : "neutral"}>
    {status === "ok" ? "Operational" : status === "degraded" ? "Degraded" : status === "unavailable" ? "Unavailable" : "Unknown"}</Badge>
    <span>Gateway readiness</span><button className="inline-button" onClick={result.retry}>Refresh</button></div>;
}

function ProviderMark({ mark, color }: { mark: string; color: string }) {
  return <span className={`provider-mark mark-${color}`} aria-hidden="true">{mark}</span>;
}
export { ProviderMark };

function ProviderAvailability() {
  const { connection } = useConsole();
  return <Panel title="Provider availability" description={connection ? "Gateway readiness probe" : "Across all configured providers"}
    action={<span className="panel-icon"><Activity size={17} aria-hidden="true" /></span>} className="providers-panel">
    {connection ? <><GatewayHealth compact /><Empty title="Provider telemetry unavailable"
      description="The gateway reports overall readiness. Per-provider uptime and latency require an operator data source." icon={Server} /></> :
      <div className="provider-list">{demoProviders.map((provider) => <div className="provider-row" key={provider.name}>
        <ProviderMark mark={provider.mark} color={provider.color} />
        <div className="provider-info"><strong>{provider.name}</strong><span><i />{provider.state}</span></div>
        <div className="provider-value"><strong>{provider.availability}</strong><span>{provider.latency} p95</span></div>
      </div>)}</div>}
    <div className="panel-foot"><TextLink href="/providers/">View providers</TextLink></div>
  </Panel>;
}

const trafficHeaders = ["Request ID", "Model", "Provider", "Status", "Latency", "Tokens", "Time"];
export function ActivityTable({ includeAll = true }: { includeAll?: boolean }) {
  const [selected, setSelected] = useState<typeof demoActivity[number] | null>(null);
  return <>
    <Table label="Sample request activity" headers={trafficHeaders} className="activity-table">
      {demoActivity.slice(0, includeAll ? 5 : 4).map((row) => <tr key={row.id}>
        <td><button className="row-link mono" onClick={() => setSelected(row)}>{row.id}</button></td>
        <td className="strong">{row.model}</td><td>{row.provider}</td>
        <td><Badge tone={row.state === "Completed" ? "good" : row.state === "Fallback" ? "info" : "warn"} dot>{row.state}</Badge></td>
        <td className="mono">{row.latency}</td><td className="mono">{number(row.tokens)}</td><td>{row.ago}</td>
      </tr>)}
    </Table>
    <Modal title="Sample request" description={selected?.id} open={Boolean(selected)} onClose={() => setSelected(null)}>
      {selected && <dl className="facts"><div><dt>Model</dt><dd>{selected.model}</dd></div><div><dt>Provider</dt><dd>{selected.provider}</dd></div>
        <div><dt>Status</dt><dd>{selected.state}</dd></div><div><dt>Latency</dt><dd>{selected.latency}</dd></div><div><dt>Tokens</dt><dd>{number(selected.tokens)}</dd></div><div><dt>Time</dt><dd>{selected.ago}</dd></div></dl>}
    </Modal>
  </>;
}

type DisplayMetric = { label: string; value: string; detail?: string; icon: LucideIcon; children?: ReactNode };
function Metrics({ items }: { items: DisplayMetric[] }) {
  return <div className="metrics">{items.map((item) => <Metric key={item.label} {...item} />)}</div>;
}
function useOverviewMetrics(data: UsageRow[], demo: boolean): DisplayMetric[] {
  const count = totals(data);
  return [
    { label: "Total requests", value: number(count.requests), detail: demo ? "vs. prior period" : "Requests admitted", icon: Activity,
      children: demo ? <span className="trend"><ArrowUpRight size={13} />{(() => {
        const comparison = data.reduce((sum, row, index) => sum + Math.round(Number(row.requests) *
          (0.75 + 0.13 * Math.sin(index * 0.91))), 0);
        return comparison ? `${Math.round(100 * (Number(count.requests) / comparison - 1))}%` : "0%";
      })()}</span> : undefined },
    { label: "Token consumption", value: compact(count.prompt_tokens_observed + count.completion_tokens_observed),
      detail: "Input and output tokens", icon: Layers3 },
    { label: demo ? "Inference cost" : "Finalized inference cost", value: usd(count.total_finalized_microusd),
      detail: demo ? "Sample finalized spend" : "Reported, estimated and adjusted", icon: CircleDollarSign },
    { label: "P95 latency", value: demo ? "1.24 s" : "—", detail: demo ? "Sample P50 580 ms · P99 2.18 s" : "Gateway does not expose latency", icon: Clock3 },
  ];
}

function UsageError({ message, retry }: { message: string; retry: () => void }) {
  return <Issue message={message} retry={retry} />;
}

export function Overview() {
  const { connection } = useConsole();
  const { page, error, loading, retry } = useUsage();
  const metrics = useOverviewMetrics(page?.data ?? [], !connection);
  return <>
    <PageHead title="Overview" description="Request traffic, inference spend, and provider availability."><DateRange /><ConsoleButton /></PageHead>
    <SourceNotice />
    <div className="overview-workbench">
      {loading ? <Busy label="Loading overview metrics" /> : error ? <UsageError message={error} retry={retry} /> : <Metrics items={metrics} />}
      <div className="overview-grid">
        <Panel title="Request volume" description="Daily requests across all model aliases"
          action={<Hint text="Counts represent admitted requests. A provider retry does not add another request." />} className="traffic-panel">
          {page ? page.data.length ? <Chart title="Daily request volume" data={series(page, !connection)} type="requests" demo={!connection} /> :
            <Empty title="No requests in this range" description="Run a completion or choose a longer date range." /> :
            loading ? <Busy /> : <Empty title="Request volume unavailable" description="The usage report could not be loaded." />}
        </Panel>
        <ProviderAvailability />
      </div>
    </div>
    <Panel title="Recent activity" description={connection ? "Request-level visibility" : "Latest requests across provider routes"}
      action={<TextLink href="/analytics/">View analytics</TextLink>} className="activity-panel">
      {connection ? <Empty title="Request history unavailable" description="This gateway exposes aggregate usage. Run a request in the playground to inspect its output and request ID." /> :
        <ActivityTable includeAll={false} />}
    </Panel>
  </>;
}

function exportUsage(rows: UsageRow[]) {
  const fields = ["day", "requests", "attempts", "prompt_tokens_observed", "completion_tokens_observed",
    "total_finalized_microusd", "pending_hold_microusd"] as const;
  const csv = [fields.join(","), ...rows.map((row) => fields.map((key) => row[key] ?? "").join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "aegis-daily-usage.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Export({ data }: { data?: UsageRow[] }) {
  return <button className="button secondary" disabled={!data?.length} onClick={() => { if (data) exportUsage(data); }}>
    <ArrowDownToLine size={16} aria-hidden="true" /> Export CSV</button>;
}

export function Analytics() {
  const { connection } = useConsole();
  const { page, loading, error, retry } = useUsage();
  const count = totals(page?.data ?? []);
  const latency = [
    { label: "<250 ms", count: 4280 }, { label: "250–500", count: 32400 }, { label: "500–1k", count: 46125 },
    { label: "1k–2k", count: 19820 }, { label: ">2k ms", count: 2990 },
  ];
  return <>
    <PageHead title="Request analytics" description="Review traffic patterns, response times, and request outcomes."><DateRange /><Export data={page?.data} /></PageHead>
    <SourceNotice />
    {loading ? <Busy /> : error ? <UsageError message={error} retry={retry} /> : <Metrics items={[
      { label: "Total requests", value: number(count.requests), detail: "Admitted requests", icon: Activity },
      { label: "Provider attempts", value: number(count.attempts), detail: "Includes additional attempts", icon: Layers3 },
      { label: "Error rate", value: connection ? "—" : "0.58%", detail: connection ? "Metric unavailable" : "Sample error rate", icon: Gauge },
      { label: "P95 latency", value: connection ? "—" : "1.24 s", detail: connection ? "Metric unavailable" : "Sample response time", icon: Clock3 },
    ]} />}
    <Panel title="Request volume" description="Admitted requests by UTC day">
      {page?.data.length ? <Chart title="Requests by UTC day" type="requests" data={series(page, !connection)} demo={!connection} height={268} /> :
        loading ? <Busy /> : <Empty title="No traffic to chart" description={error ? "Restore access to the usage report to view this chart." : "Select a range with completed usage."} />}
    </Panel>
    <div className="equal-grid">
      <Panel title="Error rate" description="Daily share of failed requests">
        {!connection && page ? <Chart title="Sample error rates by day" type="errors" data={series(page, true)} height={195} /> :
          <Empty title="Error rate unavailable" description="The usage response has no error-rate dimension." />}
      </Panel>
      <Panel title="Latency distribution" description="Request count by duration">
        {!connection ? <Chart title="Sample latency distribution" type="latency" data={latency} height={195} /> :
          <Empty title="Latency distribution unavailable" description="Live latency histograms are not available to tenant credentials." />}
      </Panel>
    </div>
    <Panel title="Provider comparison" description="Availability, traffic share, and response time">
      {connection ? <Empty title="Provider breakdown unavailable" description="Live usage can be grouped by model alias. Provider-level metrics require operator access." /> :
        <Table label="Sample provider comparisons" headers={["Provider", "Traffic share", "Availability", "P95 latency"]}>
          {demoProviders.map((row) => <tr key={row.name}><td className="strong">{row.name}</td><td><span className="bar-cell">
            <span className="mini-bar"><i style={{ width: `${row.load}%` }} /></span>{row.load}%</span></td><td>{row.availability}</td><td>{row.latency}</td></tr>)}
        </Table>}
    </Panel>
    {!connection && <Panel title="Sample requests"><ActivityTable /></Panel>}
  </>;
}

export function Cost() {
  const { connection, days } = useConsole();
  const { page, loading, error, retry } = useUsage();
  const modelUsage = useUsage("model");
  const count = totals(page?.data ?? []);
  const modelRows = connection ? modelUsage.page?.data.map((row) => ({
    model: row.model, spend: BigInt(row.total_finalized_microusd),
    tokens: BigInt(row.prompt_tokens_observed) + BigInt(row.completion_tokens_observed),
  })) ?? [] : demoModelUsage(days);
  return <>
    <PageHead title="Cost intelligence" description="Review inference spend, token consumption, and budget exposure."><DateRange /><Export data={page?.data} /></PageHead>
    <SourceNotice />
    {loading ? <Busy /> : error ? <UsageError message={error} retry={retry} /> : <Metrics items={[
      { label: "Finalized spend", value: usd(count.total_finalized_microusd), detail: "USD across all attempts", icon: CircleDollarSign },
      { label: "Estimated charges", value: usd(count.estimated_microusd), detail: "Included in finalized spend", icon: Gauge },
      { label: "Pending holds", value: usd(count.pending_hold_microusd), detail: "Exposure awaiting settlement", icon: Clock3 },
      { label: "Observed tokens", value: compact(count.prompt_tokens_observed + count.completion_tokens_observed),
        detail: `${number(count.unknown_token_attempts)} attempts without token counts`, icon: Layers3 },
    ]} />}
    <div className="equal-grid">
      <Panel title="Daily inference cost" description="Reported, estimated, and adjusted charges">
        {page?.data.length ? <Chart title="Daily spend in US dollars" data={series(page)} type="cost" /> :
          loading ? <Busy /> : <Empty title="No spend to chart" description="A usage report with recorded attempts is needed." />}
      </Panel>
      <Panel title="Token consumption" description="Observed input and output tokens">
        {page?.data.length ? <Chart title="Daily token consumption" data={series(page)} type="tokens" /> :
          loading ? <Busy /> : <Empty title="No token usage to chart" description="Gateway usage appears here once a provider reports it." />}
      </Panel>
    </div>
    <div className="equal-grid">
      <Panel title="Cost by model alias" description="Finalized spend within the selected period">
        {modelUsage.error ? <Issue message={modelUsage.error} retry={modelUsage.retry} /> : modelUsage.loading ? <Busy /> :
          modelRows.length ? <Table label="Spend by model alias" headers={["Model alias", "Observed tokens", "Spend"]}>
            {[...modelRows].sort((a, b) => a.spend > b.spend ? -1 : a.spend < b.spend ? 1 : 0).map((row) =>
              <tr key={row.model}><td className="strong">{row.model}</td><td className="mono">{compact(row.tokens)}</td><td className="mono">{usd(row.spend)}</td></tr>)}
          </Table> : <Empty title="No model usage" description="The gateway returned no usage for this range." />}
      </Panel>
      <Panel title="Tenant budgets" description={connection ? "Budget policy visibility" : "Current month · sample organizations"}>
        {connection ? <Empty title="Budget limits unavailable" description="Usage exposes pending holds and charges. Budget limits are managed through the gateway operator CLI." /> :
          <div className="budget-rows">{demoBudgets.map((row) => <div key={row.name}>
            <div className="budget-label"><strong>{row.name}</strong><span>${row.spent.toFixed(2)} / ${row.limit.toLocaleString("en-US")}</span></div>
            <progress max={row.limit} value={row.spent} aria-label={`${row.name} budget used`} />
          </div>)}</div>}
      </Panel>
    </div>
    {page && connection && <p className="report-note">Usage through {page.complete_through ? dateLabel(page.complete_through) : "the current partial reporting period"} · USD · UTC</p>}
  </>;
}

export function Reliability() {
  const { connection } = useConsole();
  return <>
    <PageHead title="Reliability center" description="Inspect gateway readiness, upstream failures, and recovery behavior."><ConsoleButton /></PageHead>
    <SourceNotice />
    <div className="equal-grid reliability-first">
      <Panel title="Gateway health" description="PostgreSQL and Redis readiness" action={<span className="panel-icon"><Globe2 size={17} /></span>}>
        <GatewayHealth />
        <p className="panel-note">Readiness reflects whether the gateway can accept work. It does not establish availability for each upstream provider.</p>
      </Panel>
      <Panel title="Circuit breakers" description="Provider admission state" action={<span className="panel-icon"><Shield size={17} /></span>}>
        {connection ? <Empty title="Breaker details unavailable" description="The gateway’s collector metrics endpoint is reserved for operators." /> :
          <div className="compact-list">{demoProviders.map((item) => <div key={item.name}>
            <span>{item.name}</span><Badge tone="good" dot>{item.breaker}</Badge>
          </div>)}</div>}
      </Panel>
    </div>
    <Panel title="Failure events" description="Recent upstream timeouts, rate limits, and recovery">
      {connection ? <Empty title="Failure event stream unavailable" description="An operator events endpoint is required to display live incidents." /> :
        <Table label="Sample failure events" headers={["Time", "Provider", "Event", "Outcome"]}>
          {demoIncidents.map((item) => <tr key={item.date}><td>{item.date}</td><td className="strong">{item.provider}</td>
            <td><Badge tone={item.tone}>{item.event}</Badge></td><td>{item.result}</td></tr>)}
        </Table>}
    </Panel>
    <Panel title="Retry and fallback" description="Recovery attempts after upstream failure">
      {connection ? <Empty title="Retry breakdown unavailable" description="Usage reports total attempts. Retry and fallback reasons are available to the operator through telemetry." /> :
        <Metrics items={[
          { label: "Retries", value: "284", detail: "Sample period", icon: Repeat2 },
          { label: "Fallbacks", value: "91", detail: "Sample period", icon: Waypoints },
          { label: "Retry success", value: "96.1%", detail: "Sample period", icon: Activity },
          { label: "Open circuits", value: "0", detail: "Sample snapshot", icon: Shield },
        ]} />}
    </Panel>
    {connection && <Notice>Provider health, circuit-breaker states, and failure events are intentionally scoped to operator telemetry in this release.</Notice>}
  </>;
}
