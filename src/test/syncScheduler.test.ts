import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncScheduler, type SyncStatus } from "@/lib/sync/scheduler";
import type { EngineApi, EngineCache } from "@/lib/sync/engine";

function setup(over: { cache?: Partial<EngineCache>; api?: Partial<EngineApi>; now?: () => number } = {}) {
	const statuses: SyncStatus[] = [];
	const cache: EngineCache = {
		getCursor: async () => "",
		listDirty: async () => [],
		listTombstoned: async () => [],
		listSynced: async () => [],
		applyChanges: async () => ({ applied_upserts: 0, applied_deletes: 0, skipped_dirty: 0 }),
		markPushed: async () => {},
		markConflicted: async () => {},
		forgetTemplate: async () => true,
		listQueuedUses: async () => [],
		drainUse: async () => {},
		...over.cache,
	};
	const api: EngineApi = {
		fetchChanges: async () => ({ changes: [], next_cursor: "MQ==", has_more: false, reset: false }),
		putTemplate: async () => ({ revision: 1 }),
		deleteTemplate: async () => {},
		postUse: async () => {},
		...over.api,
	};
	const scheduler = createSyncScheduler({ cache, api, now: over.now, onStatus: (s) => statuses.push(s) });
	return { scheduler, statuses, cache, api };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("sync scheduler", () => {
	it("runs a full sync at startup and reports synced", async () => {
		const { scheduler, statuses } = setup();
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(statuses.some((s) => s.state === "synced")).toBe(true));
		scheduler.stop();
	});

	it("debounces local edits into one push-only run after 3 s", async () => {
		let puts = 0;
		const { scheduler } = setup({
			cache: {
				listDirty: async () => [
					{
						id: 1,
						server_id: "srv-1",
						name: "T",
						summary: "",
						page_w_mm: 210,
						page_h_mm: 297,
						readme: "",
						html: "<p></p>",
						css: "",
						base_revision: 1,
					},
				],
			},
			api: {
				putTemplate: async () => {
					puts += 1;
					return { revision: 2 };
				},
			},
		});
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		puts = 0;
		scheduler.schedulePushSoon();
		scheduler.schedulePushSoon();
		scheduler.schedulePushSoon();
		await vi.advanceTimersByTimeAsync(3_000);
		await vi.waitFor(() => expect(puts).toBe(1));
		scheduler.stop();
	});

	it("backs off after failures and recovers on success", async () => {
		let calls = 0;
		let failNext = true;
		let t = 1_000_000;
		const { scheduler, statuses } = setup({
			now: () => t,
			api: {
				fetchChanges: async () => {
					calls += 1;
					if (failNext) {
						failNext = false;
						throw new Error("network down");
					}
					return { changes: [], next_cursor: "MQ==", has_more: false, reset: false };
				},
			},
		});
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.waitFor(() => expect(statuses.some((s) => s.state === "offline")).toBe(true));
		expect(scheduler._debug().failures).toBe(1);

		// Inside the backoff window a manual sync is skipped.
		calls = 0;
		await scheduler.syncNow();
		expect(calls).toBe(0);

		// After the window (5 s * 2^1 = 10 s) it retries and reports synced.
		t += 11_000;
		await vi.advanceTimersByTimeAsync(11_000);
		await scheduler.syncNow();
		await vi.waitFor(() => expect(statuses.some((s) => s.state === "synced")).toBe(true));
		expect(scheduler._debug().failures).toBe(0);
		scheduler.stop();
	});

	it("never runs two syncs at once", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const { scheduler } = setup({
			api: {
				fetchChanges: async () => {
					concurrent += 1;
					maxConcurrent = Math.max(maxConcurrent, concurrent);
					await new Promise((r) => setTimeout(r, 50));
					concurrent -= 1;
					return { changes: [], next_cursor: "MQ==", has_more: false, reset: false };
				},
			},
		});
		scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		const first = scheduler.syncNow();
		const second = scheduler.syncNow();
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all([first, second]);
		expect(maxConcurrent).toBe(1);
		scheduler.stop();
	});
});
