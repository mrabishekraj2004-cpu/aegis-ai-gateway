"use client";

import { useCallback, useState, type FormEvent } from "react";
import { ArrowRight, CircleCheck, GitBranch, GitFork, Layers3, LockKeyhole, Plus, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { useConsole, useResource } from "./session";
import { ConsoleButton, SourceNotice } from "./shell-parts";
import { Badge, Busy, Empty, Hint, Issue, Modal, Notice, PageHead, Panel, Spinner, Table } from "./ui";
import { changeBody, displayTarget, hasCycle, previewScores, samplePolicies } from "@/lib/policies";
import { errorText, GatewayError, policies, savePolicy, type Policy, type PolicyChange, type Session } from "@/lib/gateway";

const flags = ["Streaming", "Tools", "Vision"];
const weights = ["cost", "latency", "reliability", "priority"] as const;
const defaults = { cost: 35, latency: 30, reliability: 25, priority: 10 };

function RouteGraph({ policy, demo }: { policy: Policy; demo: boolean }) {
  const edges = policy.fallback_edges ?? [];
  const ordered = [...policy.targets].sort((a, b) => b.priority - a.priority);
  return <>
    <div className="route-source"><Layers3 size={16} /><span><strong>Incoming request</strong><small>{policy.model}</small></span></div>
    <div className="route-tree" role="group" aria-label="Eligible policy targets in priority order">
      {ordered.map((target) => { const display = displayTarget(target.deployment_id, demo); return (
        <div className="route-target" key={target.deployment_id} title={demo ? undefined : target.deployment_id}>
          <span><strong>{display.name}</strong><small>{display.model}</small></span><Badge>{target.priority}</Badge>
        </div>); })}
    </div>
    <div className="route-edges"><h3>Fallback edges</h3>
      {edges.length ? edges.map((edge) => <div key={`${edge.source}:${edge.target}`}>
        <span>{displayTarget(edge.source, demo).name}</span><ArrowRight size={14} aria-hidden="true" /><span className="sr-only">to</span>
        <span>{displayTarget(edge.target, demo).name}</span></div>) : <p className="muted small">No fallback edges configured.</p>}
    </div>
  </>;
}

function PolicyEditor({ initial, connection, onSaved }: {
  initial: Policy; connection: Session | null; onSaved: (value: Policy) => void;
}) {
  const demo = !connection;
  const [draft, setDraft] = useState(initial);
  const [filter, setFilter] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [source, setSource] = useState(draft.targets[0]?.deployment_id ?? "");
  const [target, setTarget] = useState(draft.targets[1]?.deployment_id ?? "");
  const [busy, setBusy] = useState(false);
  const terms = { ...defaults, ...draft.weights };
  const sum = Object.values(terms).reduce((total, term) => total + term, 0);
  const edges = draft.fallback_edges ?? [];
  const invalidReason = reason.trim().length === 0 || new TextEncoder().encode(reason.trim()).byteLength > 256;
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const visible = draft.targets.filter((item) => !demo || filter.every((flag) => displayTarget(item.deployment_id, true).capabilities.includes(flag)));
  function editTarget(id: string, field: "priority" | "weight", value: number) {
    setDraft((previous) => ({ ...previous, targets: previous.targets.map((item) => item.deployment_id === id ? { ...item, [field]: value } : item) }));
  }
  function addEdge() {
    setError("");
    if (!source || !target || source === target || edges.some((edge) => edge.source === source && edge.target === target)) {
      setError("Choose two distinct deployments with no existing edge between them in that direction.");
      return;
    }
    const next = [...edges, { source, target }];
    if (hasCycle(next)) {
      setError("That edge would create a cycle. Choose another target.");
      return;
    }
    setDraft({ ...draft, fallback_edges: next });
  }
  async function persist(disable = false) {
    if (!connection || busy) return;
    setError("");
    if (invalidReason) {
      setError("Add a change reason from 1 to 256 UTF-8 bytes.");
      return;
    }
    if (!disable && sum !== 100) { setError("Scoring weights must add up to 100."); return; }
    if (!disable && draft.targets.some((item) => [item.priority, item.weight].some((value) =>
      !Number.isInteger(value) || value < 0 || value > 100))) {
      setError("Target priority and allocation must be integers from 0 to 100.");
      return;
    }
    const body: PolicyChange = disable ? {
      model: draft.model, status: "disabled", expected_revision: initial.revision,
      catalog_revision: initial.catalog_revision, change_reason: reason.trim(),
    } : changeBody(draft, reason);
    setBusy(true);
    try {
      const policy = await savePolicy(connection, body, AbortSignal.timeout(15_000));
      setConfirm(false);
      onSaved(policy);
    } catch (cause) {
      setConfirm(false);
      if (cause instanceof GatewayError && cause.status === 409) {
        setError(`${cause.message} Refresh policies before retrying. If the catalog changed, an operator may need to republish the policy.`);
      } else if (cause instanceof GatewayError && cause.status > 0 && cause.status < 500) {
        setError(cause.message);
      } else {
        setError(`${errorText(cause)} A response did not confirm the change. Refresh policies before trying again.`);
      }
    } finally {
      setBusy(false);
    }
  }
  const showFlags = (item: string) => setFilter((previous) => previous.includes(item) ? previous.filter((flag) => flag !== item) : [...previous, item]);
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void persist(); }
  return <form className="routing-grid" onSubmit={submit}>
    <div className="view-stack">
      <Panel title="Deployment targets" description={demo ? "Sample configuration · adjust values to preview" : "Edit existing targets for this alias"}>
        {demo && <div className="filter-row" role="group" aria-label="Filter by capability">{flags.map((flag) =>
          <button type="button" key={flag} className={`button filter ${filter.includes(flag) ? "selected" : ""}`}
            aria-pressed={filter.includes(flag)} onClick={() => showFlags(flag)}>{flag}</button>)}</div>}
        {!demo && <p className="panel-note">The policy contract exposes deployment IDs. Capability details and enrollment are managed outside this console.</p>}
        {visible.length ? <Table label="Policy deployment targets" headers={["Deployment", "Priority", "Allocation"]}>
          {visible.map((item) => {
            const label = displayTarget(item.deployment_id, demo);
            return <tr key={item.deployment_id}>
              <td title={item.deployment_id}><strong>{label.name}</strong><small className="cell-sub">{label.model}</small></td>
              <td><input className="number-input" aria-label={`Priority for ${label.name}`} type="number" min={0} max={100}
                value={item.priority} onChange={(event) => editTarget(item.deployment_id, "priority", Number(event.target.value))} /></td>
              <td><input className="number-input" aria-label={`Allocation weight for ${label.name}`} type="number" min={0} max={100}
                value={item.weight} onChange={(event) => editTarget(item.deployment_id, "weight", Number(event.target.value))} /></td>
            </tr>;
          })}
        </Table> : <Empty title="No matching deployments" description="Remove a capability filter to see more targets." />}
      </Panel>
      <Panel title="Scoring policy" description="Define how eligible targets are ranked" action={<Hint text="Scoring applies after capability and safety checks." />}>
        <div className="panel-body form-stack">
          <div className="weights">{weights.map((term) => <label key={term}>{term}
            <input type="number" min={0} max={100} aria-label={`${term} scoring weight`}
              value={terms[term] ?? defaults[term]} onChange={(event) => setDraft({ ...draft, weights: { ...terms, [term]: Number(event.target.value) } })} />
          </label>)}</div>
          <div className="form-meta">
            <span className={sum === 100 ? "muted" : "danger-text"}>Total {sum} / 100</span>
            <label className="check-field"><input type="checkbox" checked={draft.enable_weighted ?? false}
              onChange={(event) => setDraft({ ...draft, enable_weighted: event.target.checked })} /> Weighted distribution</label>
          </div>
          <div className="form-meta"><span>Data regions</span><div className="badges">{draft.data_regions.map((region) => <Badge key={region}>{region}</Badge>)}</div></div>
        </div>
      </Panel>
      {!demo && <Panel title="Publish change" description="Publish using the revision read from the gateway">
        <div className="panel-body form-stack">
          <label>Change reason<input value={reason} maxLength={256} onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this policy changing?" required /></label>
          {error && <Notice tone="bad">{error}</Notice>}
          <div className="button-row">
            <button type="submit" className="button primary" disabled={busy || (!changed && draft.status === "active")}>
              {busy ? <Spinner /> : <CircleCheck size={15} />}{draft.status === "disabled" ? "Activate policy" : "Publish change"}
            </button>
            {draft.status === "active" && <button type="button" className="button danger" disabled={busy}
              onClick={() => { if (invalidReason) setError("Add a change reason before disabling the policy."); else setConfirm(true); }}>Disable policy</button>}
          </div>
        </div>
      </Panel>}
      {demo && <Notice icon={LockKeyhole}>Edits update this preview. Connect with an authorized OIDC token to publish a real policy.</Notice>}
    </div>
    <div className="view-stack">
      <Panel title="Fallback topology" description="Authorized transitions between deployments" action={<GitBranch size={18} className="muted" />}>
        <div className="panel-body">
          <RouteGraph policy={draft} demo={demo} />
          {draft.targets.length > 1 && <div className="edge-editor">
            <label>From<select value={source} onChange={(event) => setSource(event.target.value)}>
              {draft.targets.map((item) => <option key={item.deployment_id} value={item.deployment_id}>{displayTarget(item.deployment_id, demo).name}</option>)}
            </select></label>
            <label>To<select value={target} onChange={(event) => setTarget(event.target.value)}>
              {draft.targets.map((item) => <option key={item.deployment_id} value={item.deployment_id}>{displayTarget(item.deployment_id, demo).name}</option>)}
            </select></label>
            <button className="button secondary" type="button" onClick={addEdge}><Plus size={15} /> Add edge</button>
          </div>}
          {edges.length > 0 && <div className="edge-actions">{edges.map((edge) => {
            const name = `${displayTarget(edge.source, demo).name} to ${displayTarget(edge.target, demo).name}`;
            return <button type="button" key={name} className="inline-button" onClick={() => setDraft({ ...draft, fallback_edges: edges.filter(
              (item) => item.source !== edge.source || item.target !== edge.target) })}><Trash2 size={13} /> Remove {name}</button>;
          })}</div>}
          {demo && error && <Notice tone="bad">{error}</Notice>}
        </div>
      </Panel>
      <Panel title="Decision explanation" description={demo ? "How the demo policy is evaluated" : "Evaluation rules from the gateway contract"}
        action={<SlidersHorizontal size={18} className="muted" />}>
        <ol className="decision-steps">
          <li><strong>Apply eligibility</strong><span>Filter by tenant policy, region, model capability, budget, and provider health.</span></li>
          <li><strong>Score eligible targets</strong><span>Cost {terms.cost} · latency {terms.latency} · reliability {terms.reliability} · priority {terms.priority}.</span></li>
          <li><strong>Apply fallback</strong><span>Follow approved edges before any streamed content is committed.</span></li>
        </ol>
        {demo ? <div className="score-preview">
          <h3>Example candidate scores</h3>
          {sum === 100 ? previewScores(draft).map((row) => <div key={row.id}><span>{displayTarget(row.id, true).name}</span>
            <strong className="mono">{row.score.toLocaleString("en-US")}</strong></div>) :
            <p className="small muted">Set scoring weights to a total of 100.</p>}
          <p className="small muted">Lower scores rank first in this example. A real request also uses live eligibility and health.</p>
        </div> : <p className="panel-note bottom">Per-request decision records are unavailable to this console.</p>}
      </Panel>
    </div>
    <Modal open={confirm} title="Disable routing policy?" description={`Disabling ${draft.model} removes its active policy. Save a new active revision to restore it.`}
      onClose={() => { if (!busy) setConfirm(false); }}>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
        <button type="button" className="button danger" onClick={() => void persist(true)} disabled={busy}>{busy && <Spinner />} Disable policy</button></div>
    </Modal>
  </form>;
}

export function Routing() {
  const { connection, sessionVersion } = useConsole();
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState<{ session: Session; value: Policy } | null>(null);
  const task = useCallback((signal: AbortSignal) => policies(connection!, signal), [connection]);
  const result = useResource(connection?.kind === "user" ? task : null);
  const confirmed = saved && saved.session === connection ? saved.value : null;
  const list = connection ? result.data ?? [] : samplePolicies;
  const candidate = list.find((item) => item.model === selected) ?? list[0];
  const policy = confirmed?.model === candidate?.model && confirmed && confirmed.revision >= (candidate?.revision ?? 0) ? confirmed : candidate;
  return <>
    <PageHead title="Routing console" description="Inspect policy versions, deployment priorities, and permitted fallback paths."><ConsoleButton /></PageHead>
    <SourceNotice />
    {connection?.kind === "key" ? <Panel title="Routing policies"><Empty icon={ShieldCheck} title="A tenant access token is required"
      description="The gateway limits policy reads and writes to authorized OIDC members. Scoped service keys cannot manage routing policies."><ConsoleButton /></Empty></Panel> :
      result.loading ? <Busy label="Loading routing policies" /> : result.error ? <Issue message={result.error} retry={result.retry} /> :
      policy ? <>
        <div className="selection-bar"><GitFork size={18} /><label>Model policy<select value={policy.model} onChange={(event) => setSelected(event.target.value)}>
          {list.map((row) => <option key={row.id} value={row.model}>{row.model}</option>)}
        </select></label><Badge tone={policy.status === "active" ? "good" : "neutral"} dot>{policy.status === "active" ? "Active" : "Disabled"}</Badge>
          <span className="mono muted">v{policy.revision}</span>{connection && <button type="button" className="inline-button" onClick={result.retry}>Refresh policies</button>}</div>
        {confirmed && <Notice tone="good" icon={CircleCheck}>Gateway confirmed version {confirmed.revision} for {confirmed.model}.</Notice>}
        <PolicyEditor key={`${sessionVersion}:${policy.id}:${policy.version_id}`} initial={policy} connection={connection} onSaved={(value) => {
          if (connection) setSaved({ session: connection, value });
        }} />
      </> : <Panel title="Routing policies"><Empty title="No policies found" description="Enroll a deployment and seed a policy with the gateway operator CLI." /></Panel>}
  </>;
}
