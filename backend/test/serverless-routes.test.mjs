import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rootHandler = require("../../api/[...path].js");

test("Vercel API paths share the gateway request handler", async () => {
  assert.equal(typeof rootHandler, "function");
  assert.equal(require("../../api/v1/usage.js"), rootHandler);
  assert.equal(require("../../api/v1/chat/completions.js"), rootHandler);
  assert.equal(require("../../api/v1/admin/[...path].js"), rootHandler);
});
