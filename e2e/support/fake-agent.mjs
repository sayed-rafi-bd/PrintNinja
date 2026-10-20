// Phase 1 spike, item 4: the fake desktop agent. Loaded into the page before
// any app code (Playwright addInitScript), it answers the IPC commands the
// boot path and the sign-in gate need through Tauri v2's
// `window.__TAURI_INTERNALS__.invoke`. The full harness (REFACTORING.md
// Phase 1 deliverable) moves this to bundled TypeScript with the command
// contract test; the shape below is what the spike proves.
const settings = {
  onboarding_done: "true",
  share_service_url: "http://127.0.0.1:3001",
  share_session_token: null,
};

const calls = [];

window.__FAKE_AGENT_CALLS = calls;
window.__TAURI_INTERNALS__ = {
  async invoke(cmd, args) {
    calls.push({ cmd, args });
    switch (cmd) {
      case "get_setting":
        return settings[args?.key] ?? null;
      case "set_setting":
        settings[args?.key] = args?.value ?? null;
        return null;
      case "ping":
        return null;
      default:
        console.warn("[fake-agent] unhandled command", cmd, args);
        return null;
    }
  },
};
