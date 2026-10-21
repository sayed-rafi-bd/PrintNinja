import { defineConfig } from "vitest/config";

// API end-to-end workflows (REFACTORING.md section 11): complete flows
// over HTTP against a running container (docker compose up), through
// plain fetch — no fakes, no inject. Needs E2E_BASE_URL; fails fast
// without a stack to talk to. Not part of `pnpm test`.
//
// Files run SEQUENTIALLY: they share one stack, and E10 restarts the
// service mid-file while E8 and E11 assert exact request counts —
// parallel files would sever each other's connections and pollute the
// rate-limit windows.
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/e2e/**/*.e2e.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
});
