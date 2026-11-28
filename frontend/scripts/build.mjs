import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(["index.html", "styles.css"].map(file => cp(resolve(root, file), resolve(output, file))));
const publicConfig = {
  apiBaseUrl: process.env.AEGIS_API_BASE_URL ?? "",
  neonAuthUrl: process.env.AEGIS_NEON_AUTH_URL ?? ""
};
const runtime = `window.AEGIS_CONFIG = ${JSON.stringify(publicConfig)};\nif (window.AEGIS_CONFIG.neonAuthUrl) document.documentElement.classList.add("auth-pending");\n`;
await writeFile(resolve(output, "runtime-config.js"), runtime, "utf8");
await build({
  entryPoints: [resolve(root, "src/main.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: resolve(output, "app.js")
});
console.log("Built Aegis frontend assets.");
