// In-memory settings store for the fake agent. State is loaded from the
// one-shot seed (written by fixtures before the bundle runs) and saved to
// localStorage on every mutation, so a page reload behaves like restarting
// the app while a second browser context starts with its own empty cache.

export type AgentSeed = {
	settings?: Record<string, string | null>;
};

export type AgentState = {
	settings: Record<string, string | null>;
};

const STATE_KEY = "fake-agent:state";
const SEED_KEY = "fake-agent:seed";

function defaultSettings(): Record<string, string | null> {
	return {
		onboarding_done: "true",
		share_service_url: null,
		share_session_token: null,
	};
}

function loadSeed(): AgentSeed {
	try {
		const raw = localStorage.getItem(SEED_KEY);
		if (!raw) return {};
		localStorage.removeItem(SEED_KEY);
		return JSON.parse(raw) as AgentSeed;
	} catch {
		return {};
	}
}

function loadState(): AgentState {
	const seed = loadSeed();
	try {
		const raw = localStorage.getItem(STATE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<AgentState>;
			return {
				settings: { ...defaultSettings(), ...(parsed.settings ?? {}) },
			};
		}
	} catch {
		// Corrupt state falls through to the seed.
	}
	return { settings: { ...defaultSettings(), ...(seed.settings ?? {}) } };
}

const state: AgentState = loadState();

function save(): void {
	try {
		localStorage.setItem(STATE_KEY, JSON.stringify(state));
	} catch {
		// Storage full or unavailable: the agent keeps serving memory.
	}
}

export function getSetting(key: string): string | null {
	return state.settings[key] ?? null;
}

export function setSetting(key: string, value: string | null): void {
	state.settings[key] = value;
	save();
}

/** Test hook: which commands the page has invoked so far. */
export function agentCalls(): { cmd: string; args: unknown }[] {
	return (window as unknown as { __FAKE_AGENT_CALLS: { cmd: string; args: unknown }[] }).__FAKE_AGENT_CALLS;
}
