import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit + integration (REFACTORING.md section 11). API workflows live
    // in test/e2e/*.e2e.ts and run through vitest.e2e.config.mts against
    // a running container, never in the default pass.
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/domain/**/*.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
