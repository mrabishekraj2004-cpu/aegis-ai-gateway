import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    reducedMotion: "reduce",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: { command: "python3 -m http.server 3100 --bind 127.0.0.1 --directory out",
    url: "http://127.0.0.1:3100", reuseExistingServer: false, timeout: 15000, stderr: "ignore", stdout: "ignore" },
});
