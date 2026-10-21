import { commandNames, handleCommand } from "./commands.js";
import { SEED_KEY } from "./store.js";

// Fake desktop agent (REFACTORING.md section 11). Bundled to one IIFE by
// esbuild in the global setup and injected with page.addInitScript before
// any app code runs, it answers IPC through Tauri v2's
// window.__TAURI_INTERNALS__.invoke — the shape the Phase 1 spike proved.
// Every call is recorded on __FAKE_AGENT_CALLS for assertions.

const calls: { cmd: string; args: unknown }[] = [];

(window as unknown as { __FAKE_AGENT_CALLS: unknown }).__FAKE_AGENT_CALLS =
  calls;

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  async invoke(cmd: string, args?: unknown) {
    calls.push({ cmd, args });
    return handleCommand(cmd, args);
  },
};

// Every module has evaluated (settings and the cache hydrated), so the
// one-shot seed is consumed: a reload behaves like restarting the app
// (persisted rows) while a new context starts from its own seed.
try {
  localStorage.removeItem(SEED_KEY);
} catch {
  // Storage unavailable: the seed simply stays put.
}

export { commandNames };
