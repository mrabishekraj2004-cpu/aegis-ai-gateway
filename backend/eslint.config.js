import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "coverage/**"] },
  {
    files: ["src/**/*.js", "server.mjs", "workers.mjs", "scripts/**/*.mjs", "test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  { files: ["src/provider-interface.js"], rules: { "require-yield": "off" } }
];
