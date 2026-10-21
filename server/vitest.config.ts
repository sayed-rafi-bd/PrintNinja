import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit + integration (REFACTORING.md section 11). API workflows live
    // in test/e2e/*.e2e.ts and run through vitest.e2e.config.mts against
    // a running container, never in the default pass.
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
  },
});
