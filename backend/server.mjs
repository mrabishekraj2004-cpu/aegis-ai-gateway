import { createServer as nodeCreateServer } from "node:http";
import { createGateway } from "./src/gateway.js";
import { localDemoCredentialsFromEnv } from "./src/auth.js";
import { MockProvider } from "./src/mock-provider.js";
import { createProviderRegistry } from "./src/providers.js";
import { initializeTelemetry } from "./src/observability.js";

class RequestBodyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request, maxBytes = 1_000_000) {
  if (request.method === "GET" || request.method === "OPTIONS") return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestBodyError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!size) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestBodyError(400, "Request body must be valid JSON."); }
}

export function createHttpServer({ mode = "disabled", credentials, store, provider, providers, keyPepper = process.env.AEGIS_KEY_PEPPER, allowedOrigin = "http://127.0.0.1:4173" } = {}) {
  if (!store) throw new Error("A storage adapter must be explicitly configured.");
  if (mode === "production" && (!keyPepper || keyPepper.length < 32)) throw new Error("Production API-key authentication requires AEGIS_KEY_PEPPER with at least 32 characters.");
  const configuredProviders = providers ?? (mode === "production" ? createProviderRegistry({ includeMock: false }) : new Map([["mock", provider ?? new MockProvider()]]));
  if (mode === "production" && configuredProviders.size === 0) throw new Error("Production mode has no configured provider credentials.");
  const gateway = createGateway({ mode, credentials, store, provider, providers: configuredProviders, keyPepper, allowedOrigin });
  const server = nodeCreateServer(async (request, response) => {
    const abortController=new AbortController();
    request.once("aborted",()=>abortController.abort());
    response.once("close",()=>{if(!response.writableEnded)abortController.abort();});
    try {
      const body = await readJson(request);
      const result = await gateway.handle({ method: request.method, path: request.url, headers: request.headers, body, signal:abortController.signal });
      response.writeHead(result.status, result.headers);
      if (result.writeTo) {
        response.flushHeaders?.();
        await result.writeTo(response);
        return;
      }
      const contentType=result.headers?.["Content-Type"]??result.headers?.["content-type"]??"";
      response.end(result.status === 204 ? undefined : contentType.startsWith("text/plain") ? result.body : JSON.stringify(result.body));
    } catch (error) {
      if (response.headersSent) { if(!response.destroyed&&!response.writableEnded) response.end(); return; }
      const origin = request.headers.origin;
      const cors = origin === allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, "Vary": "Origin" } : {};
      const status = error instanceof RequestBodyError ? error.status : 500;
      const message = error instanceof RequestBodyError ? error.message : "The gateway could not complete this storage operation.";
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors });
      response.end(JSON.stringify({ error: { code: status === 400 ? "invalid_request" : status === 413 ? "payload_too_large" : "internal_error", message } }));
    }
  });
  server.gateway = gateway;
  return server;
}

if (process.argv[1] && process.argv[1].toLowerCase().endsWith("server.mjs")) {
  const mode = process.env.AEGIS_MODE === "local" ? "local" : process.env.AEGIS_MODE === "production" ? "production" : "disabled";
  const allowedOrigin = process.env.AEGIS_ALLOWED_ORIGIN || "http://127.0.0.1:4173";
  const port = Number(process.env.PORT || 4174);
  (async()=>{
    const telemetry=await initializeTelemetry();
    const { createStorageFromEnv }=await import("./src/storage.js");
    const store = await createStorageFromEnv();
    const credentials = mode === "local" ? localDemoCredentialsFromEnv() : undefined;
    const providers = mode === "production" ? createProviderRegistry({ includeMock: false }) : new Map([["mock", new MockProvider()]]);
    const server = createHttpServer({ mode, credentials, store, providers, keyPepper: process.env.AEGIS_KEY_PEPPER, allowedOrigin });
    const host=process.env.AEGIS_HOST || (mode === "production" ? "0.0.0.0" : "127.0.0.1");
    server.listen(port, host, () => {
      console.log(`Aegis gateway API listening on ${host}:${port} (mode: ${mode})`);
      console.log(`Storage mode: ${process.env.AEGIS_STORAGE || "postgres"}`);
      if (mode === "local") console.log("Local mock mode enabled; demo bearer tokens are read from environment variables.");
    });
    const shutdown=()=>server.close(async()=>{await telemetry.shutdown?.();await store.pool?.end?.();});
    process.once("SIGINT",shutdown);
    process.once("SIGTERM",shutdown);
  })().catch(error => {
    console.error(`Aegis startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
