import { useEffect, useRef, useState } from "react";
import { createSyncScheduler, type SyncState } from "@/lib/sync/scheduler";
import {
  productionApi,
  productionCache,
  productionLibraryCache,
} from "@/lib/sync/wiring";
import type { EngineApi, EngineCache, LibraryCache } from "@/lib/sync/engine";

const INITIAL: SyncState = {
  state: "syncing",
  drafts: 0,
  lastPulledAt: null,
  lastError: null,
};

let current: { refreshNow: () => Promise<void> } | null = null;

/**
 * Refresh the local cache from the server now. This is the only sync
 * action in the app: the server owns the data, and this pulls it down.
 * No-op before the scheduler starts.
 */
export function cacheNow(): Promise<void> {
  return current?.refreshNow() ?? Promise.resolve();
}

export function useSyncStatus(deps?: {
  cache?: EngineCache;
  api?: EngineApi;
  library?: { cache: LibraryCache };
}): SyncState {
  const [status, setStatus] = useState<SyncState>(INITIAL);
  const schedulerRef = useRef<ReturnType<typeof createSyncScheduler> | null>(
    null,
  );

  useEffect(() => {
    const scheduler = createSyncScheduler({
      cache: deps?.cache ?? productionCache(),
      api: deps?.api ?? productionApi(),
      library: { cache: deps?.library?.cache ?? productionLibraryCache() },
      onStatus: setStatus,
    });
    schedulerRef.current = scheduler;
    current = scheduler;
    scheduler.start();
    return () => {
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
