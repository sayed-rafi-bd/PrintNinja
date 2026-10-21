import type { Browser, BrowserContext, Page } from "@playwright/test";
import { apiRegister } from "./api.js";
import { readStackState } from "./stack-state.js";
import type { AgentSeed } from "./fakeAgent/store.js";

// pc() opens a new browser context with its own fake agent; a second
// context is a second PC with its own empty cache (REFACTORING.md
// section 11). The agent bundle path and the service URL come from the
// global setup's stack file, so fixtures work wherever the stack runs.

export interface Pc {
  context: BrowserContext;
}

function stack() {
  return readStackState();
}

/** Installs the fake agent into a page or context with the given seed.
 * The seed script runs first (registration order), so the bundle picks
 * the seed up on load; the seed key is consumed once. */
export async function installAgent(
  target: Page | BrowserContext,
  seed: AgentSeed = {},
): Promise<void> {
  const { agentBundle } = stack();
  await target.addInitScript({
    content: `localStorage.setItem('fake-agent:seed', '${JSON.stringify(seed).replace(/'/g, "\\'")}')`,
  });
  await target.addInitScript({ path: agentBundle });
}

/** A fresh PC: default seed (onboarding done, service URL set, no token). */
export async function pc(browser: Browser, seed: AgentSeed = {}): Promise<Pc> {
  const context = await browser.newContext();
  await installAgent(context, {
    settings: {
      onboarding_done: "true",
      share_service_url: stack().apiUrl,
      share_session_token: null,
      ...(seed.settings ?? {}),
    },
    ...(seed.templates !== undefined ? { templates: seed.templates } : {}),
    ...(seed.printers !== undefined ? { printers: seed.printers } : {}),
  });
  return { context };
}

export interface SignedInPc extends Pc {
  token: string;
  handle: string;
  userId: string;
}

/** A PC whose agent already holds a live session token. */
export async function signedInPc(
  browser: Browser,
  handle = `e2e-${Date.now().toString(36)}`,
  password = "password123",
): Promise<SignedInPc> {
  const auth = await apiRegister(handle, password);
  const contextPc = await pc(browser, {
    settings: { share_session_token: auth.token },
  });
  return {
    ...contextPc,
    token: auth.token,
    handle,
    userId: auth.user.id,
  };
}
