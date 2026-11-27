import { createServer as nodeCreateServer } from "node:http";
import { createGateway } from "./src/gateway.js";
import { localDemoCredentialsFromEnv } from "./src/auth.js";
import { MockProvider } from "./src/mock-provider.js";

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

export function createHttpServer({ mode = "disabled", credentials, store, provider = new MockProvider(), allowedOrigin = "http://127.0.0.1:4173" } = {}) {
  if (!store) throw new Error("A storage adapter must be explicitly configured.");
  const gateway = createGateway({ mode, credentials, store, provider, allowedOrigin });
  const server = nodeCreateServer(async (request, response) => {
    try {
      const body = await readJson(request);
      const result = await gateway.handle({ method: request.method, path: request.url, headers: request.headers, body });
      response.writeHead(result.status, result.headers);
      response.end(result.status === 204 ? undefined : JSON.stringify(result.body));
    } catch (error) {
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
  const mode = process.env.AEGIS_MODE === "local" ? "local" : "disabled";
  const allowedOrigin = process.env.AEGIS_ALLOWED_ORIGIN || "http://127.0.0.1:4173";
  const port = Number(process.env.PORT || 4174);
  import("./src/storage.js").then(async ({ createStorageFromEnv }) => {
    const store = await createStorageFromEnv();
    const credentials = mode === "local" ? localDemoCredentialsFromEnv() : undefined;
    const server = createHttpServer({ mode, credentials, store, allowedOrigin });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Aegis gateway API listening at http://127.0.0.1:${port} (mode: ${mode})`);
      console.log(`Storage mode: ${process.env.AEGIS_STORAGE || "postgres"}`);
      if (mode === "local") console.log("Local mock mode enabled; demo bearer tokens are read from environment variables.");
    });
  }).catch(error => {
    console.error(`Aegis startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
