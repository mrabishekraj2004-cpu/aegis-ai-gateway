import type { components } from "./openapi";

type Schema = components["schemas"];
export type Model = Schema["ModelEntry"];
export type Health = Schema["Health"];
export type UsageRow = Schema["UsageRow"];
export type UsagePage = Schema["UsagePage"];
export type ChatInput = Schema["Chat"];
export type Completion = Schema["ChatCompletion"];
export type Usage = Schema["PublicUsage"];
export type ActivePolicy = Schema["ActivePolicyChange"];
export type PolicyChange = ActivePolicy | Schema["DisabledPolicyChange"];
export type Policy = Omit<ActivePolicy, "status" | "expected_revision" | "change_reason"> & {
  id: string;
  version_id: string;
  revision: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  status: "active" | "disabled";
};
export type Session = { base: string; token: string; tenant: string; kind: "key" | "user" };
export type Group = "day" | "model" | "day_model";

export class GatewayError extends Error {
  constructor(message: string, public status = 0, public code?: string, public requestId?: string) {
    super(message);
    this.name = "GatewayError";
  }
}

export function gatewayBase(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a complete gateway URL, including the scheme.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Use HTTPS for a remote gateway. HTTP is available for localhost.");
  }
  if (url.username || url.password || url.search || url.hash || !/^\/(v1\/?)?$/.test(url.pathname)) {
    throw new Error("Enter a gateway origin or its /v1 URL, without credentials or query parameters.");
  }
  return url.origin;
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "The gateway request failed.";
}

function payloadError(value: unknown, status: number, requestId?: string): GatewayError {
  if (value && typeof value === "object" && "error" in value) {
    const { error, request_id } = value as { error: { message?: unknown; code?: string }; request_id?: string };
    return new GatewayError(typeof error?.message === "string" ? error.message : "The gateway rejected the request.",
      status, error?.code, request_id ?? requestId);
  }
  return new GatewayError(`Gateway returned HTTP ${status}.`, status, undefined, requestId);
}

async function request(session: Session, path: string, init: RequestInit = {}, authenticated = true) {
  const headers = new Headers(init.headers);
  if (authenticated) {
    headers.set("Authorization", `Bearer ${session.token}`);
    if (session.tenant) headers.set("X-Tenant-ID", session.tenant);
  }
  if (init.body) headers.set("Content-Type", "application/json");
  try {
    return await fetch(`${session.base}/v1${path}`, {
      ...init, headers, redirect: "error", credentials: "omit", cache: "no-store",
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new GatewayError("Could not reach the gateway. Check the URL and allow this console origin in the gateway’s CORS configuration.");
  }
}

async function checked(response: Response) {
  if (!response.ok) {
    throw payloadError(await response.json().catch(() => null), response.status,
      response.headers.get("X-Request-ID") ?? undefined);
  }
  return response;
}

export async function models(session: Session, signal?: AbortSignal): Promise<Model[]> {
  const response = await checked(await request(session, "/models", { signal }));
  const body: Schema["ModelList"] = await response.json();
  return body.data;
}

export async function health(session: Session, signal?: AbortSignal): Promise<Health> {
  const response = await request(session, "/health", { signal }, false);
  if (response.status !== 503) await checked(response);
  return response.json();
}

export const dayString = (date: Date) => date.toISOString().slice(0, 10);
export function dates(days: number, now = new Date()) {
  const midnight = new Date(`${dayString(now)}T00:00:00Z`).getTime();
  return { from: dayString(new Date(midnight - (days - 1) * 86_400_000)),
    to: dayString(new Date(midnight + 86_400_000)) };
}

type List<T> = { data: T[]; next_cursor: string | null; has_more: boolean };

async function listPage<T, P extends List<T>>(
  session: Session, path: string, filters: Record<string, string>, signal?: AbortSignal,
): Promise<{ rows: T[]; first: P }> {
  const rows: T[] = [];
  let first: P | undefined;
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const params = new URLSearchParams({ ...filters, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const response = await checked(await request(session, `${path}?${params}`, { signal }));
    const page: P = await response.json();
    first ??= page;
    rows.push(...page.data);
    cursor = page.has_more ? page.next_cursor : null;
    if (cursor && (seen.has(cursor) || seen.size >= 19)) {
      throw new GatewayError("Gateway pagination did not complete. Narrow the date range and try again.");
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { rows, first: first! };
}

export async function usage(session: Session, days: number, group: Group, signal?: AbortSignal) {
  const { rows, first } = await listPage<UsageRow, UsagePage>(
    session, "/usage", { ...dates(days), group_by: group }, signal,
  );
  return { ...first, data: rows };
}

export async function policies(session: Session, signal?: AbortSignal) {
  return (await listPage<Policy, List<Policy>>(session, "/admin/routing-policies", {}, signal)).rows;
}

export async function savePolicy(session: Session, change: PolicyChange, signal?: AbortSignal): Promise<Policy> {
  const response = await checked(await request(session, "/admin/routing-policies",
    { method: "POST", body: JSON.stringify(change), signal }));
  return response.json();
}

export type RunResult = { usage: Usage | null; requestId?: string; completionId?: string; finish?: string };

export async function* frames(source: ReadableStream<Uint8Array>) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let event = "";
  let data: string[] = [];
  let eventSize = 0;
  let done = false;
  try {
    while (!done) {
      const result = await reader.read();
      done = result.done;
      pending += decoder.decode(result.value, { stream: !done });
      if (pending.length > 512_000) throw new GatewayError("The gateway sent an oversized stream event.");
      let boundary = pending.indexOf("\n");
      while (boundary >= 0) {
        const line = pending.slice(0, boundary).replace(/\r$/, "");
        pending = pending.slice(boundary + 1);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          event = "";
          data = [];
          eventSize = 0;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventSize += line.length;
          if (eventSize > 512_000) throw new GatewayError("The gateway sent an oversized stream event.");
          data.push(line.slice(5).replace(/^ /, ""));
        }
        boundary = pending.indexOf("\n");
      }
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function complete(
  session: Session, input: ChatInput, signal: AbortSignal, onText: (delta: string) => void,
): Promise<RunResult> {
  const response = await checked(await request(session, "/chat/completions",
    { method: "POST", body: JSON.stringify(input), signal }));
  const requestId = response.headers.get("X-Request-ID") ?? undefined;
  if (!input.stream) {
    const body: Completion = await response.json();
    onText(body.choices[0]?.message.content ?? "");
    return { usage: body.usage, requestId, completionId: body.id, finish: body.choices[0]?.finish_reason };
  }
  if (!response.body || !response.headers.get("Content-Type")?.startsWith("text/event-stream")) {
    throw new GatewayError("The gateway did not return a streaming response.", response.status, undefined, requestId);
  }
  const result: RunResult = { usage: null, requestId };
  for await (const frame of frames(response.body)) {
    if (frame.data === "[DONE]") {
      if (!result.finish) throw new GatewayError("The stream ended without a finish reason.", 502, "stream_incomplete", requestId);
      return result;
    }
    let data: unknown;
    try { data = JSON.parse(frame.data); }
    catch { throw new GatewayError("The gateway sent an invalid stream event.", 502, undefined, requestId); }
    if (frame.event === "error" || (data && typeof data === "object" && "error" in data)) {
      throw payloadError(data, 502, requestId);
    }
    if (!data || typeof data !== "object") {
      throw new GatewayError("The gateway sent an invalid stream event.", 502, undefined, requestId);
    }
    const chunk = data as { id?: string; usage?: Usage; choices?: { delta?: { content?: string }; finish_reason?: string }[] };
    if (chunk.id) result.completionId = chunk.id;
    if (chunk.usage) result.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) onText(choice.delta.content);
    if (choice?.finish_reason) result.finish = choice.finish_reason;
  }
  throw new GatewayError("The stream closed before completion. Partial output is shown below.", 502, "stream_incomplete", requestId);
}
