import { drainUses, pushDirty, pushTombstones, syncOnce, type EngineApi, type EngineCache } from "./engine";

export type SyncStatusName = "synced" | "syncing" | "pending" | "offline" | "conflict";

export interface SyncStatus {
	state: SyncStatusName;
	/** Local dirty rows not yet pushed. */
	pending: number;
	/** Rows waiting on the conflict dialog. */
	conflicts: number;
	lastPullAt: string | null;
	lastError: string | null;
}

export interface SchedulerDeps {
	cache: EngineCache;
	api: EngineApi;
	now?: () => number;
	onStatus?: (status: SyncStatus) => void;
}

const FOCUS_MIN_INTERVAL_MS = 60_000;
const PERIODIC_MS = 5 * 60_000;
const PUSH_DEBOUNCE_MS = 3_000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Background sync triggers (REFACTORING.md section 6.5): startup (the
 * caller runs `syncNow` after the sign-in gate), window focus at most
 * once a minute, every 5 minutes, 3 s after a local edit (push only),
 * and on the browser `online` event. Never at print time — the print
 * pipeline never calls this module.
 *
 * Failures back off exponentially (5 s doubling to 5 min) and report
 * `offline`; success resets the backoff. Concurrent runs never overlap:
 * a trigger while syncing sets a flag for one re-run afterwards.
 */
export function createSyncScheduler(deps: SchedulerDeps) {
	const now = deps.now ?? (() => Date.now());
	let started = false;
	let running = false;
	let rerun = false;
	let failures = 0;
	let backoffUntil = 0;
	let lastPullAt: string | null = null;
	let lastError: string | null = null;
	let conflictIds: string[] = [];
	let pushTimer: ReturnType<typeof setTimeout> | null = null;
	let periodicTimer: ReturnType<typeof setInterval> | null = null;
	let lastFocusRun = 0;
	let disposed = false;

	const emit = async (state: SyncStatusName) => {
		if (!deps.onStatus) {
			return;
		}
		let pending = 0;
		try {
			pending = (await deps.cache.listDirty()).length;
		} catch {
			pending = 0;
		}
		deps.onStatus({ state, pending, conflicts: conflictIds.length, lastPullAt, lastError });
	};

	const backoffMs = () => Math.min(BASE_BACKOFF_MS * 2 ** failures, MAX_BACKOFF_MS);

	async function runPushOnly(): Promise<void> {
		await pushTombstones(deps.cache, deps.api);
		const { conflicts } = await pushDirty(deps.cache, deps.api);
		conflictIds = conflicts;
		await drainUses(deps.cache, deps.api);
	}

	async function syncNowFull(): Promise<void> {
		if (running) {
			rerun = true;
			return;
		}
		if (now() < backoffUntil) {
			return;
		}
		running = true;
		await emit("syncing");
		try {
			const res = await syncOnce(deps.cache, deps.api);
			conflictIds = res.conflicts;
			lastPullAt = new Date(now()).toISOString();
			lastError = null;
			failures = 0;
			backoffUntil = 0;
			await emit(conflictIds.length > 0 ? "conflict" : "synced");
			// Lists read the cache on mount; a completed pull must refresh
			// them (F3/F4: B shows A's template with no manual step).
			if (typeof window !== "undefined" && !disposed) {
				window.dispatchEvent(
					new CustomEvent("sync:pulled", { detail: { pulled: res.pulled, pushed: res.pushed } }),
				);
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			failures += 1;
			backoffUntil = now() + backoffMs();
			await emit("offline");
		} finally {
			running = false;
			if (rerun && !disposed) {
				rerun = false;
				void syncNowFull();
			}
		}
	}

	async function pushSoon(): Promise<void> {
		if (running) {
			rerun = true;
			return;
		}
		if (now() < backoffUntil) {
			return;
		}
		running = true;
		try {
			await runPushOnly();
			lastError = null;
			failures = 0;
			backoffUntil = 0;
			await emit(conflictIds.length > 0 ? "conflict" : "pending");
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			failures += 1;
			backoffUntil = now() + backoffMs();
			await emit("offline");
		} finally {
			running = false;
			if (rerun && !disposed) {
				rerun = false;
				void syncNowFull();
			}
		}
	}

	function schedulePushSoon(): void {
		if (disposed) {
			return;
		}
		if (pushTimer) {
			clearTimeout(pushTimer);
		}
		void emit("pending");
		pushTimer = setTimeout(() => {
			pushTimer = null;
			void pushSoon();
		}, PUSH_DEBOUNCE_MS);
	}

	function onFocus(): void {
		if (now() - lastFocusRun < FOCUS_MIN_INTERVAL_MS) {
			return;
		}
		lastFocusRun = now();
		void syncNowFull();
	}

	function onOnline(): void {
		void syncNowFull();
	}

	function start(): void {
		if (started) {
			return;
		}
		started = true;
		if (typeof window !== "undefined") {
			window.addEventListener("focus", onFocus);
			window.addEventListener("online", onOnline);
		}
		periodicTimer = setInterval(() => {
			void syncNowFull();
		}, PERIODIC_MS);
		// Startup trigger: the caller starts the scheduler after the gate.
		void syncNowFull();
	}

	function stop(): void {
		disposed = true;
		started = false;
		if (pushTimer) {
			clearTimeout(pushTimer);
			pushTimer = null;
		}
		if (periodicTimer) {
			clearInterval(periodicTimer);
			periodicTimer = null;
		}
		if (typeof window !== "undefined") {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("online", onOnline);
		}
	}

	return {
		start,
		stop,
		/** Full sync now (startup, focus, timer, online). */
		syncNow: syncNowFull,
		/** Push-only 3 s after a local edit. */
		schedulePushSoon,
		/** Test seam: backoff state. */
		_debug: () => ({ failures, backoffUntil, running }),
	};
}

export type SyncScheduler = ReturnType<typeof createSyncScheduler>;
