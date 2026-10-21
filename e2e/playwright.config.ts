import { defineConfig, devices } from "@playwright/test";

// The e2e stack (REFACTORING.md Phase 1): globalSetup starts PostgreSQL,
// runs the committed migrations, starts the built service and bundles the
// fake agent; every spec gets a fresh browser context through fixtures.
// Vite serves the app at 1420; the API port is the setup's business.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  retries: process.env.CI ? 1 : 0,
  // Worker count matches the e2e stack (support/stack.ts): the setup
  // starts one isolated API+database per worker. Keep the two in sync;
  // E2E_WORKERS overrides both.
  workers: Number(process.env.E2E_WORKERS ?? (process.env.CI ? 4 : 2)),
  globalSetup: "./support/stack.ts",
  globalTeardown: "./support/stack-teardown.ts",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm -C .. dev",
    url: "http://localhost:1420",
    // Never reuse a stale dev server in CI: a leftover bundle from an
    // earlier run would false-pass every spec.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
