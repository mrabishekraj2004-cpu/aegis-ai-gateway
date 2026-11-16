"use client";

import { useCallback, useState } from "react";
import { Eye, KeyRound, LockKeyhole, Search, Server, ShieldCheck, Users } from "lucide-react";
import { ConsoleButton, SourceNotice } from "./shell-parts";
import { useConsole, useResource } from "./session";
import { GatewayHealth, ProviderMark } from "./monitor";
import { Badge, Busy, Empty, Issue, Modal, Notice, PageHead, Panel, Table } from "./ui";
import { demoAudit, demoModels, demoProviders } from "@/lib/data";
import { models } from "@/lib/gateway";

export function Providers() {
  const { connection } = useConsole();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<typeof demoProviders[number] | null>(null);
  const load = useCallback((signal: AbortSignal) => models(connection!, signal), [connection]);
  const result = useResource(connection ? load : null);
  const query = filter.toLowerCase().trim();
  const list = connection ? result.data?.map((item) => ({ id: item.id, provider: null, context: null, capabilities: [] })) ?? [] : demoModels;
  const matching = list.filter((item) => `${item.id} ${item.provider ?? ""} ${item.capabilities.join(" ")}`.toLowerCase().includes(query));
  return <>
    <PageHead title="Providers" description="Inspect provider status, enrolled models, and deployment details."><ConsoleButton /></PageHead>
    <SourceNotice />
    {connection ? <Panel title="Gateway readiness" description="Overall service status"><GatewayHealth /></Panel> :
      <div className="provider-cards">{demoProviders.map((provider) => <section className="panel provider-card" key={provider.name}>
        <div className="provider-card-head"><ProviderMark mark={provider.mark} color={provider.color} /><div><h2>{provider.name}</h2>
          <Badge tone="good" dot>Operational</Badge></div></div>
        <dl><div><dt>Models</dt><dd>{provider.models}</dd></div><div><dt>Breaker</dt><dd>{provider.breaker}</dd></div></dl>
        <button className="button secondary" onClick={() => setSelected(provider)}><Eye size={15} /> Inspect provider</button>
      </section>)}</div>}
    <Panel title={connection ? "Published model aliases" : "Model catalog"}
      description={connection ? "Models visible to the connected identity" : "Sample provider models and supported capabilities"}
      action={<label className="search-field"><span className="sr-only">Filter models</span><Search size={16} aria-hidden="true" />
        <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter models" /></label>}>
      {result.loading ? <Busy /> : result.error ? <Issue message={result.error} retry={result.retry} /> :
        matching.length ? <Table label="Model catalog" headers={connection ? ["Model alias", "Availability"] :
          ["Model", "Provider", "Context window", "Capabilities"]}>
          {matching.map((item) => <tr key={item.id}><td className="mono strong">{item.id}</td>
            {connection ? <td><Badge tone="neutral">Published</Badge></td> : <>
              <td>{item.provider}</td><td className="mono">{item.context}</td><td><div className="badges">{item.capabilities.map((capability) =>
                <Badge key={capability}>{capability}</Badge>)}</div></td>
            </>}
          </tr>)}
        </Table> : <Empty title={query ? "No models match your filter" : "No models published"}
          description={query ? "Try a different model or provider name." : "The connected identity has no visible model aliases."} />}
    </Panel>
    {connection && <Panel title="Provider configuration" description="Operator controls">
      <Empty icon={Server} title="Configuration and break­ers are operator-managed"
        description="The model endpoint exposes aliases. Provider credentials, configuration, breaker state, and per-provider uptime are unavailable through this tenant API." />
    </Panel>}
    <Modal title={selected?.name ?? "Provider"} description="Sample configuration" open={Boolean(selected)} onClose={() => setSelected(null)}>
      {selected && <dl className="facts"><div><dt>Availability</dt><dd>{selected.availability}</dd></div><div><dt>Breaker</dt><dd>{selected.breaker}</dd></div>
        <div><dt>P95 latency</dt><dd>{selected.latency}</dd></div><div><dt>Published models</dt><dd>{selected.models}</dd></div>
        <div><dt>Configuration</dt><dd>Operator managed</dd></div></dl>}
    </Modal>
  </>;
}

export function Access() {
  const { connection } = useConsole();
  return <>
    <PageHead title="Security & access" description="Review the workspace identity, API key controls, and audit visibility."><ConsoleButton /></PageHead>
    <SourceNotice />
    <div className="equal-grid">
      <Panel title="Workspace identity" description="Credential and tenant context">
        <dl className="facts inset">
          <div><dt>Connection</dt><dd><Badge tone={connection ? "good" : "warn"} dot>{connection ? "Live gateway" : "Demo workspace"}</Badge></dd></div>
          <div><dt>Credential</dt><dd>{connection ? (connection.kind === "key" ? "Scoped API key" : "OIDC access token") : "Sample identity"}</dd></div>
          <div><dt>Tenant</dt><dd className={connection?.tenant ? "mono wrap-anywhere" : ""}>{connection ?
            connection.tenant || "Resolved from the key" : "Demo organization"}</dd></div>
          <div><dt>Storage</dt><dd>Credential held in tab memory</dd></div>
        </dl>
      </Panel>
      <Panel title="Access controls" description="Permissions are enforced by the connected gateway">
        <div className="access-controls">
          <div><ShieldCheck size={19} /><span><strong>Model catalog</strong><small>{connection ? "Model discovery verified at connection" : "Demo dataset"}</small></span>
            <Badge tone={connection ? "good" : "neutral"}>{connection ? "Verified" : "Demo"}</Badge></div>
          <div><LockKeyhole size={19} /><span><strong>Routing policy changes</strong><small>OIDC membership and policy scope</small></span>
            <Badge>{connection?.kind === "user" ? "Checked by API" : connection ? "Restricted" : "Demo"}</Badge></div>
          <div><KeyRound size={19} /><span><strong>Key lifecycle</strong><small>Provision and revoke from the operator CLI</small></span><Badge>Operator</Badge></div>
        </div>
      </Panel>
    </div>
    <Panel title="API keys" description={connection ? "Key inventory and lifecycle" : "Sample key inventory"}>
      {connection ? <Empty icon={KeyRound} title="API key inventory unavailable" description="Use aegis-admin issue-key and aegis-admin revoke-key with your admin database login." /> :
        <Table label="Sample API keys" headers={["Name", "Key suffix", "Scopes", "State"]}>
          <tr><td className="strong">inference-worker</td><td className="mono">•••• k3G7</td><td>Chat, models</td><td><Badge tone="good" dot>Active</Badge></td></tr>
          <tr><td className="strong">usage-reporter</td><td className="mono">•••• b8Q2</td><td>Usage, models</td><td><Badge tone="good" dot>Active</Badge></td></tr>
          <tr><td className="strong">legacy-dev</td><td className="mono">•••• v5N9</td><td>Chat</td><td><Badge>Revoked</Badge></td></tr>
        </Table>}
    </Panel>
    <Panel title="Tenant management" description="Tenant identity and membership">
      {connection ? <Empty icon={Users} title="Membership inventory unavailable" description="Use the gateway operator CLI to enroll users and manage tenant membership." /> :
        <Table label="Sample tenants" headers={["Tenant", "Members", "State"]}>
          <tr><td className="strong">Platform engineering</td><td>12</td><td><Badge tone="good" dot>Active</Badge></td></tr>
          <tr><td className="strong">Applied research</td><td>7</td><td><Badge tone="good" dot>Active</Badge></td></tr>
          <tr><td className="strong">Internal automation</td><td>3</td><td><Badge tone="good" dot>Active</Badge></td></tr>
        </Table>}
    </Panel>
    <Panel title="Audit history" description="Administrative changes">
      {connection ? <Empty title="Audit endpoint unavailable" description="The backend persists audit records. The current API does not expose those records to the console." /> :
        <Table label="Sample audit history" headers={["Time", "Action", "Actor", "Target"]}>
          {demoAudit.map((row) => <tr key={row.date}><td>{row.date}</td><td className="strong">{row.action}</td><td>{row.actor}</td><td>{row.target}</td></tr>)}
        </Table>}
    </Panel>
    {connection && <Notice icon={ShieldCheck}>The console never requests provider or collector credentials.</Notice>}
  </>;
}
