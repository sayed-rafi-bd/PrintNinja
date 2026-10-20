import { defineConfig, devices } from "@playwright/test";

// Phase 1 spike, item 4: Vite serves the app at 1420 (the dev port, strict),
// Chromium drives it, and support/fake-agent.mjs answers the Tauri IPC.
// The Phase 1 e2e deliverable extends this with stack setup, fixtures and the
// F-series specs.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm -C .. dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
