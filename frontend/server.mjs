import { createServer as nodeCreateServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function runtimeConfig(env) {
  const localDemoMode = env.AEGIS_LOCAL_DEMO === "true";
  return {
    apiBaseUrl: env.AEGIS_API_BASE_URL || "http://127.0.0.1:4174",
    neonAuthUrl: env.AEGIS_NEON_AUTH_URL || "",
    localDemoMode,
    demoTokens: localDemoMode ? {
      aster: env.AEGIS_DEMO_ASTER_TOKEN || "",
      juniper: env.AEGIS_DEMO_JUNIPER_TOKEN || "",
      budget: env.AEGIS_DEMO_BUDGET_TOKEN || ""
    } : {}
  };
}

export function createServer({ env = process.env } = {}) {
  return nodeCreateServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, securityHeaders(env, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD" }));
      response.end("Method not allowed");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      response.writeHead(400, securityHeaders(env, { "Content-Type": "text/plain; charset=utf-8" }));
      response.end("Bad request");
      return;
    }
    if (pathname === "/") pathname = "/index.html";
    if (pathname === "/runtime-config.js") {
      response.writeHead(200, securityHeaders(env, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      }));
      response.end(`window.AEGIS_CONFIG = Object.assign(window.AEGIS_CONFIG || {}, ${JSON.stringify(runtimeConfig(env))}); if (window.AEGIS_CONFIG.neonAuthUrl) document.documentElement.classList.add("auth-pending");`);
      return;
    }
    const target = resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403, securityHeaders(env, { "Content-Type": "text/plain; charset=utf-8" }));
      response.end("Forbidden");
      return;
    }
    try {
      const content = await readFile(target);
      response.writeHead(200, securityHeaders(env, {
        "Content-Type": mime[extname(target)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      }));
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      response.writeHead(404, securityHeaders(env, { "Content-Type": "text/plain; charset=utf-8" }));
      response.end("Not found");
    }
  });
}

function securityHeaders(env, headers = {}) {
  let connectSource = "'self'";
  try { connectSource += ` ${new URL(env.AEGIS_API_BASE_URL || "http://127.0.0.1:4174").origin}`; } catch {}
  try { if (env.AEGIS_NEON_AUTH_URL) connectSource += ` ${new URL(env.AEGIS_NEON_AUTH_URL).origin}`; } catch {}
  return {
    ...headers,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connectSource}; base-uri 'self'; frame-ancestors 'none'`
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = createServer();
  server.listen(port, envHost(), () => {
    console.log(`Aegis frontend available at http://127.0.0.1:${port}`);
  });
}

function envHost() { return process.env.AEGIS_HOST || "127.0.0.1"; }
