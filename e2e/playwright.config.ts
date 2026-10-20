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
  workers: process.env.CI ? 4 : undefined,
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
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
