class RequestBodyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request, maxBytes = 1_000_000) {
  if (request.method === "GET" || request.method === "OPTIONS") return null;
  if (request.body !== undefined && request.body !== null && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) throw new RequestBodyError(413, "Request body is too large.");
    chunks.push(part);
  }
  if (!size) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestBodyError(400, "Request body must be valid JSON."); }
}

module.exports = async function handler(request, response) {
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  response.once("close", () => { if (!response.writableEnded) abortController.abort(); });
  try {
    const body = await readJson(request);
    const path = String(request.url || "/").replace(/^\/api(?=\/|\?|$)/, "") || "/";
    const { getGatewayRuntime } = await import("../backend/src/serverless-runtime.js");
    const gateway = await getGatewayRuntime();
    const result = await gateway.handle({
      method: request.method,
      path,
      headers: request.headers,
      body,
      signal: abortController.signal
    });
    response.writeHead(result.status, result.headers || {});
    if (result.writeTo) {
      response.flushHeaders?.();
      await result.writeTo(response);
      return;
    }
    const type = result.headers?.["Content-Type"] ?? result.headers?.["content-type"] ?? "";
    response.end(result.status === 204 ? undefined : type.startsWith("text/plain") ? result.body : JSON.stringify(result.body));
  } catch (error) {
    if (response.headersSent) {
      if (!response.destroyed && !response.writableEnded) response.end();
      return;
    }
    const allowedOrigin = process.env.AEGIS_ALLOWED_ORIGIN ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
    const cors = request.headers.origin && request.headers.origin === allowedOrigin
      ? { "Access-Control-Allow-Origin": allowedOrigin, "Vary": "Origin" }
      : {};
    const status = error instanceof RequestBodyError ? error.status : 500;
    const code = status === 400 ? "invalid_request" : status === 413 ? "payload_too_large" : "internal_error";
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors });
    response.end(JSON.stringify({ error: { code, message: error instanceof RequestBodyError ? error.message : "The gateway could not complete this request safely." } }));
  }
};
