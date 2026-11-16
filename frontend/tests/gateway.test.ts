import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, dates, frames, gatewayBase, models, usage, type Session } from "@/lib/gateway";
import { demoUsage, series, totals, usd } from "@/lib/data";
import { changeBody, hasCycle, samplePolicies } from "@/lib/policies";

const session: Session = { base: "https://aegis.test", token: "test-credential", tenant: "", kind: "key" };
const input = { model: "mock-chat", messages: [{ role: "user" as const, content: "hello" }], stream: true };
const bytes = new TextEncoder();
const readStream = (parts: Uint8Array[]) => new ReadableStream<Uint8Array>({
  start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); },
});
const mockStream = (body: string) => new Response(readStream([bytes.encode(body)]), {
  headers: { "Content-Type": "text/event-stream", "X-Request-ID": "test-request" },
});
const chunk = 'data: {"id":"test-completion","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n';
const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
const final = 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n';

afterEach(() => vi.unstubAllGlobals());

describe("FastAPI client", () => {
  it("accepts HTTPS and loopback origins and rejects credential-bearing, nested, and cleartext remote URLs", () => {
    expect(gatewayBase(" https://gateway.test/v1/ ")).toBe("https://gateway.test");
    expect(gatewayBase("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
    expect(() => gatewayBase("https://user:pass@gateway.test")).toThrow(/without credentials/);
    expect(() => gatewayBase("https://gateway.test/private")).toThrow(/gateway origin/);
    expect(() => gatewayBase("http://gateway.test")).toThrow(/HTTPS/);
  });
  it("parses fragmented Unicode frames with CRLF and ignores comments", async () => {
    const all = bytes.encode(': ping\r\n\r\nevent: update\r\ndata: {"text":"é✓"}\r\n\r\n');
    const chunks = Array.from(all, (byte) => Uint8Array.of(byte));
    const output = [];
    for await (const event of frames(readStream(chunks))) output.push(event);
    expect(output).toEqual([{ event: "update", data: '{"text":"é✓"}' }]);
  });
  it("returns completion metadata only after the success terminator", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(mockStream(chunk + finish + final + "data: [DONE]\n\n"))));
    const text: string[] = [];
    const result = await complete(session, input, new AbortController().signal, (delta) => text.push(delta));
    expect(result).toEqual({ requestId: "test-request", completionId: "test-completion", finish: "stop",
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    expect(text.join("")).toBe("Hello");
  });
  it("keeps partial output when the stream closes without a success terminator", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(mockStream(chunk + finish))));
    const text: string[] = [];
    await expect(complete(session, input, new AbortController().signal, (delta) => text.push(delta)))
      .rejects.toMatchObject({ code: "stream_incomplete", requestId: "test-request" });
    expect(text).toEqual(["Hello"]);
  });
  it("propagates a committed SSE error without retrying the request", async () => {
    const fetcher = vi.fn(() => Promise.resolve(mockStream(chunk +
      'event: error\ndata: {"error":{"code":"provider_error","message":"Provider failed"}}\n\n')));
    vi.stubGlobal("fetch", fetcher);
    await expect(complete(session, input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "provider_error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps the bearer origin-bound and rejects redirects", async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetcher);
    await models(session);
    expect(fetcher).toHaveBeenCalledWith("https://aegis.test/v1/models", expect.objectContaining({
      redirect: "error", credentials: "omit", headers: expect.any(Headers),
    }));
  });
  it("follows usage pagination cursors and preserves decimal-string fields", async () => {
    const report = demoUsage(7);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...report, data: report.data.slice(0,1),
      has_more: true, next_cursor: "page.two" })).mockResolvedValueOnce(Response.json({ ...report, data: report.data.slice(1) }));
    vi.stubGlobal("fetch", fetcher);
    const result = await usage(session, 7, "day");
    expect(result.data).toEqual(report.data);
    expect(String(fetcher.mock.calls[1][0])).toContain("cursor=page.two");
  });
});

describe("reporting and policy transforms", () => {
  it("constructs an exclusive UTC date range and fills missing day buckets", () => {
    expect(dates(7, new Date("2026-01-01T18:00:00Z"))).toEqual({ from: "2025-12-26", to: "2026-01-02" });
    const sample = demoUsage(14);
    expect(series({ ...sample, data: [] })).toHaveLength(14);
    expect(series({ ...sample, data: [] }).every((row) => row.requests === 0)).toBe(true);
  });
  it("preserves integer precision in financial sums", () => {
    const usage = demoUsage(7).data[0];
    expect(totals([{ ...usage, total_finalized_microusd: "900719925474099300" }]).total_finalized_microusd)
      .toBe(900719925474099300n);
    expect(usd(900719925474099300n)).toBe("$900,719,925,474.10");
  });
  it("sends the expected optimistic policy revision and detects cycles", () => {
    const [policy] = samplePolicies;
    const change = changeBody(policy, "  plan  ");
    expect(change).toMatchObject({ expected_revision: 3, model: "auto", catalog_revision: 5, change_reason: "plan" });
    expect(change).not.toHaveProperty("version_id");
    expect(hasCycle([{ source: "one", target: "two" }, { source: "two", target: "one" }])).toBe(true);
    expect(hasCycle([{ source: "one", target: "two" }])).toBe(false);
  });
});
