// In-memory settings store for the fake agent. State is loaded from the
// one-shot seed (written by fixtures before the bundle runs) and saved to
// localStorage on every mutation, so a page reload behaves like restarting
// the app while a second browser context starts with its own empty cache.

export type AgentSeed = {
	settings?: Record<string, string | null>;
	/** Templates to pre-seed the fake sync cache (see cache.ts SeedTemplate). */
	templates?: Array<Record<string, unknown>>;
	/** System printers for enumerate_system_printers (device-local). */
	printers?: Array<{ name: string; address?: string; printer_type?: string; language?: string }>;
};

export type AgentState = {
	settings: Record<string, string | null>;
};

const STATE_KEY = "fake-agent:state";

function defaultSettings(): Record<string, string | null> {
	return {
		onboarding_done: "true",
		share_service_url: null,
		share_session_token: null,
	};
}

export const SEED_KEY = "fake-agent:seed";

function loadSeed(): AgentSeed {
	// One-shot: the bundle entry removes the key after every module has
	// evaluated, so settings and templates hydrate from the same seed
	// regardless of module evaluation order.
	try {
		const raw = localStorage.getItem(SEED_KEY);
		if (!raw) return {};
		return JSON.parse(raw) as AgentSeed;
	} catch {
		return {};
	}
}

/** Templates pre-seeded for this context (F-series specs). Read live so
 * unit tests can seed after import; the bundle consumes the key once. */
export function seedTemplates(): Array<Record<string, unknown>> {
	try {
		const raw = localStorage.getItem(SEED_KEY);
		if (!raw) return [];
		const seed = JSON.parse(raw) as AgentSeed;
		return Array.isArray(seed.templates) ? seed.templates : [];
	} catch {
		return [];
	}
}

/** System printers pre-seeded for this context (F-series specs). */
export function seedPrinters(): Array<Record<string, unknown>> {
	try {
		const raw = localStorage.getItem(SEED_KEY);
		if (!raw) return [];
		const seed = JSON.parse(raw) as AgentSeed;
		return Array.isArray(seed.printers) ? seed.printers : [];
	} catch {
		return [];
	}
}

function loadState(): AgentState {
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
	return { settings: { ...defaultSettings(), ...(loadSeed().settings ?? {}) } };
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
