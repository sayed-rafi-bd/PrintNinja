import { useEffect, useRef, useState } from "react";
import { createSyncScheduler, type SyncStatus } from "@/lib/sync/scheduler";
import { ensureAdoptionChecked, productionApi, productionCache } from "@/lib/sync/wiring";
import type { EngineApi, EngineCache } from "@/lib/sync/engine";

const INITIAL: SyncStatus = { state: "syncing", pending: 0, conflicts: 0, lastPullAt: null, lastError: null };

let current: { schedulePushSoon: () => void; syncNow: () => Promise<void> } | null = null;

/** Tell the running scheduler a local edit needs pushing (3 s debounce). No-op before start. */
export function notifyLocalEdit(): void {
	current?.schedulePushSoon();
}

/** A full sync now (pull + push + uses). No-op before start. */
export function syncNow(): Promise<void> {
	return current?.syncNow() ?? Promise.resolve();
}

export function useSyncStatus(deps?: { cache?: EngineCache; api?: EngineApi }): SyncStatus {
	const [status, setStatus] = useState<SyncStatus>(INITIAL);
	const schedulerRef = useRef<ReturnType<typeof createSyncScheduler> | null>(null);

	useEffect(() => {
		const scheduler = createSyncScheduler({
			cache: deps?.cache ?? productionCache(),
			api: deps?.api ?? productionApi(),
			onStatus: setStatus,
		});
		schedulerRef.current = scheduler;
		current = scheduler;
		// The adoption check is local IPC; awaiting it first closes the
		// race where the first push uploads rows the dialog should hold.
		// A failure leaves the hold off (push everything) rather than
		// blocking sync.
		let cancelled = false;
		void ensureAdoptionChecked()
			.catch(() => {})
			.then(() => {
				if (!cancelled) scheduler.start();
			});
		return () => {
			cancelled = true;
			scheduler.stop();
			if (current === scheduler) {
				current = null;
			}
			schedulerRef.current = null;
		};
		// The scheduler owns its deps for its lifetime; a new cache/api
		// object means a remount in tests.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return status;
}
