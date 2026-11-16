"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleAlert, Clipboard, Code2, Play, Square, SquareTerminal } from "lucide-react";
import { demoModels, number, usd } from "@/lib/data";
import { complete, errorText, GatewayError, models, type RunResult, type Session } from "@/lib/gateway";
import { useConsole, useResource } from "./session";
import { ConsoleButton, SourceNotice } from "./shell-parts";
import { Badge, Busy, Empty, Issue, Notice, PageHead, Panel, Spinner } from "./ui";

const sample = "Handle the timeout according to when it occurred. Before the first response byte, an eligible request can retry only if the routing policy and remaining budget allow it. After streaming begins, preserve the partial output and mark the stream incomplete. Record the upstream attempt so its cost can be reconciled.";
type Status = "idle" | "running" | "complete" | "partial" | "error" | "cancelled";

function Runner({ connection }: { connection: Session | null }) {
  const demo = !connection;
  const load = useCallback((signal: AbortSignal) => models(connection!, signal), [connection]);
  const result = useResource(connection ? load : null);
  const aliases = demo ? ["auto", ...demoModels.map(({ id }) => id)] : result.data?.map((item) => item.id) ?? [];
  const [modelChoice, setModel] = useState("auto");
  const model = aliases.includes(modelChoice) ? modelChoice : aliases[0] ?? "";
  const [prompt, setPrompt] = useState(demo ? "How should a gateway handle an upstream timeout?" : "");
  const [limit, setLimit] = useState("256");
  const [stream, setStream] = useState(true);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [metadata, setMetadata] = useState<RunResult | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);

  const bytes = new TextEncoder().encode(prompt).byteLength;
  const promptUnits = bytes ? Math.ceil(bytes / 4) + 8 : 0;
  const max = Number(limit);
  const rate = demo ? demoModels.find((item) => item.id === model) : undefined;
  const estimate = rate && max > 0 ? Math.ceil(promptUnits * rate.input / 1e6) + Math.ceil(max * rate.output / 1e6) : null;
  const busy = status === "running";
  const copyText = async () => {
    try { await navigator.clipboard.writeText(text); setCopy("done"); }
    catch { setCopy("failed"); }
  };

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!model || !prompt.trim() || bytes > 65_536 || !Number.isInteger(max) || max < 1 || max > 2048) {
      setError("Select a model, enter a prompt, and set an output limit from 1 to 2,048 tokens.");
      return;
    }
    const controller = new AbortController();
    const limitSignal = AbortSignal.timeout(100_000);
    const signal = AbortSignal.any([limitSignal, controller.signal]);
    operation.current = controller;
    const started = performance.now();
    let currentText = "";
    const append = (value: string) => { currentText += value; setText(currentText); };
    setStatus("running"); setError(""); setText(""); setMetadata(null); setDuration(null); setCopy("idle");
    try {
      if (connection) {
        const data = await complete(connection, { model, messages: [{ role: "user", content: prompt }],
          max_completion_tokens: max, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }, signal, append);
        setMetadata(data);
      } else {
        const words = sample.split(" ");
        const preview = words.slice(0, Math.min(max, words.length)).join(" ");
        if (stream) {
          for (const chunk of preview.match(/.{1,20}/g) ?? []) {
            await new Promise((resolve) => setTimeout(resolve, 18));
            if (signal.aborted) throw signal.reason;
            append(chunk);
          }
        } else append(preview);
      }
      setStatus("complete");
    } catch (cause) {
      if (controller.signal.aborted) {
        setStatus("cancelled");
      } else {
        if (cause instanceof GatewayError && cause.requestId) setMetadata({ usage: null, requestId: cause.requestId });
        setError(limitSignal.aborted ? "The gateway did not finish before the request deadline." : errorText(cause));
        setStatus(currentText ? "partial" : "error");
      }
    } finally {
      setDuration(Math.round(performance.now() - started));
      operation.current = null;
    }
  }
  const tone = status === "complete" ? "good" : status === "error" ? "bad" : status === "partial" ? "warn" : "neutral";
  const stateLabel: Record<Status, string> = {
    idle: "Idle", running: stream ? "Streaming" : "Waiting", complete: demo ? "Sample complete" : "Complete",
    partial: "Partial response", error: "Request failed", cancelled: "Cancelled",
  };
  return <>
    <div className="playground-grid">
      <Panel title="Request" description="Configure a text completion" action={<Code2 size={18} className="muted" />}>
        <form className="panel-body form-stack" onSubmit={run}>
          {result.loading && <Busy compact label="Loading model aliases" />}
          {result.error && <Issue message={result.error} retry={result.retry} />}
          <label>Model alias<select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || !aliases.length}>
            {!aliases.length && <option value="">No model aliases available</option>}
            {aliases.map((alias) => <option key={alias} value={alias}>{alias}</option>)}</select></label>
          <label>Prompt<textarea rows={8} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={16000}
            placeholder="Enter a system task or user question…" disabled={busy} required /></label>
          <div className="form-meta small"><span>{number(bytes)} UTF-8 bytes</span><span>Approx. {number(promptUnits)} prompt units</span></div>
          <div className="request-settings"><label>Max output tokens<input type="number" min={1} max={2048}
            value={limit} onChange={(event) => setLimit(event.target.value)} required disabled={busy} /></label>
            <label className="check-field"><input type="checkbox" checked={stream}
              onChange={(event) => setStream(event.target.checked)} disabled={busy} /> Stream response</label></div>
          <p className="small muted">{demo ? "Sample output runs locally. No gateway request is made."
            : "This sends your prompt to the connected gateway and may incur inference charges."}</p>
          <div className="button-row">
            <button type="submit" className="button primary" disabled={busy || !model}>{busy ? <Spinner /> : <Play size={15} />}{demo ? "Run sample" : "Run inference"}</button>
            {busy && <button type="button" className="button secondary" onClick={() => operation.current?.abort()}><Square size={14} /> Stop</button>}
          </div>
        </form>
      </Panel>
      <Panel title="Response" description={demo ? "Illustrative completion output" : "Output from the gateway"}
        action={<Badge tone={tone} dot>{stateLabel[status]}</Badge>} className="response-panel">
        <div className="response-content">
          {error && <Notice tone="bad" icon={CircleAlert}>{error}</Notice>}
          {status === "cancelled" && <Notice tone="warn">{text ? "The request was cancelled. Partial output is preserved." : "The request was cancelled."}</Notice>}
          {text ? <pre className="response-text" tabIndex={0} aria-label="Completion output">{text}</pre> :
            busy ? <Busy compact label="Waiting for output" /> :
            <Empty title="No output yet" description="Run a completion to view the response here." icon={SquareTerminal} />}
        </div>
        <div className="response-foot">
          <span className="small muted" role="status">{status === "complete" && duration !== null ? `Received in ${number(duration)} ms` :
            status === "running" ? "Request in progress" : status === "partial" ? "Incomplete output" : ""}</span>
          {text && <button type="button" className="button secondary" onClick={() => void copyText()}>{copy === "done" ? <Check size={15} /> : <Clipboard size={15} />}
            {copy === "done" ? "Copied" : copy === "failed" ? "Copy unavailable" : "Copy response"}</button>}
        </div>
      </Panel>
    </div>
    <Panel title="Request metadata" description={demo ? "Local estimate for the sample input" : "Identifiers and usage from the winning provider attempt"}>
      <dl className="facts inset">
        <div><dt>Model alias</dt><dd className="mono">{model || "—"}</dd></div>
        <div><dt>{demo ? "Estimated input and output ceiling" : "Cost estimate"}</dt><dd>{demo ?
          (estimate === null ? "Select a named sample model" : estimate < 10_000 ? "<$0.01 (sample rates)" : `${usd(estimate)} (sample rates)`) :
          "Rate cards unavailable through the tenant API"}</dd></div>
        <div><dt>Request ID</dt><dd className="mono wrap-anywhere">{metadata?.requestId ?? (demo ? "Sample only" : "—")}</dd></div>
        <div><dt>Finish reason</dt><dd className="mono">{metadata?.finish ?? "—"}</dd></div>
        <div><dt>Reported tokens</dt><dd>{metadata?.usage ? `${number(metadata.usage.total_tokens)} total · ${number(metadata.usage.prompt_tokens)} input · ${number(metadata.usage.completion_tokens)} output` :
          demo ? "Sample only" : "No token totals reported yet"}</dd></div>
      </dl>
    </Panel>
  </>;
}

export function Playground() {
  const { connection, sessionVersion } = useConsole();
  return <>
    <PageHead title="API playground" description="Run a completion and inspect its streamed response, identifiers, and usage."><ConsoleButton /></PageHead>
    <SourceNotice />
    <Runner key={sessionVersion} connection={connection} />
  </>;
}
