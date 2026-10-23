import {
  downloadFontFiles,
  drainUses,
  flushTombstones,
  pull,
  type EngineApi,
  type EngineCache,
  type LibraryCache,
} from "./engine";

export type SyncStatusName = "synced" | "syncing" | "offline";

export interface SyncState {
  state: SyncStatusName;
  /** Local rows with edits not yet saved to the server (legacy drafts). */
  drafts: number;
  lastPulledAt: string | null;
  lastError: string | null;
}

export interface SchedulerDeps {
  cache: EngineCache;
  api: EngineApi;
  library?: { cache: LibraryCache };
  now?: () => number;
  onStatus?: (status: SyncState) => void;
}

const FOCUS_MIN_INTERVAL_MS = 60_000;
const PERIODIC_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Cache-refresh triggers for the server-authoritative model. The server
 * owns the data; this keeps the local cache fresh: startup (the caller
 * runs `refreshNow` after the sign-in gate), window focus at most once a
 * minute, every 5 minutes, and on the browser `online` event.
 *
 * It never pushes edits — saving is a manual, synchronous action, so
 * there is no background queue for work to hide in. The only thing it
 * sends is the queued print-usage count (a print must never fail on a
 * network blip) and failed font downloads. Never at print time — the
 * print pipeline never calls this module.
 *
 * Failures back off exponentially (5 s doubling to 5 min) and report
 * `offline`; success resets the backoff. Concurrent runs never overlap:
 * a trigger while refreshing sets a flag for one re-run afterwards.
 */
export function createSyncScheduler(deps: SchedulerDeps) {
  const now = deps.now ?? (() => Date.now());
  let started = false;
  let running = false;
  let rerun = false;
  let failures = 0;
  let backoffUntil = 0;
  let lastPulledAt: string | null = null;
  let lastError: string | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let lastFocusRun = 0;
  let disposed = false;

  const emit = async (state: SyncStatusName) => {
    if (!deps.onStatus) return;
    let drafts = 0;
    try {
      drafts = (await deps.cache.listDirty()).length;
    } catch {
      drafts = 0;
    }
    deps.onStatus({ state, drafts, lastPulledAt, lastError });
  };

  const backoffMs = () =>
    Math.min(BASE_BACKOFF_MS * 2 ** failures, MAX_BACKOFF_MS);

  async function refreshNow(): Promise<void> {
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
      await pull(deps.cache, deps.api, deps.library?.cache);
      // Legacy tombstones left behind by the old local-first model: a row
      // the user deleted before deletes went straight to the server. This
      // drains them once and then finds nothing. A 404 means the server
      // copy is already gone — same end state.
      await flushTombstones(deps.cache, deps.api);
      // Usage counts and font files are the only things still sent: a
      // print records offline and reports on the next refresh, and a
      // font fetched with the pull retries here without another pull.
      const usesSent = await drainUses(deps.cache, deps.api);
      let fontsDownloaded = 0;
      let fontsFailed = 0;
      if (deps.library) {
        ({ downloaded: fontsDownloaded, failed: fontsFailed } =
          await downloadFontFiles(deps.library.cache));
      }
      lastPulledAt = new Date(now()).toISOString();
      lastError = null;
      failures = 0;
      backoffUntil = 0;
      await emit("synced");
      // Lists read the cache on mount; a completed pull must refresh
      // them (B shows A's template with no manual step).
      if (typeof window !== "undefined" && !disposed) {
        window.dispatchEvent(
          new CustomEvent("sync:pulled", {
            detail: {
              pulled: 0,
              usesSent,
              fontsDownloaded,
              fontsFailed,
            },
          }),
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
        void refreshNow();
      }
    }
  }

  function onFocus(): void {
    if (now() - lastFocusRun < FOCUS_MIN_INTERVAL_MS) return;
    lastFocusRun = now();
    void refreshNow();
  }

  function onOnline(): void {
    void refreshNow();
  }

  function start(): void {
    if (started) return;
    started = true;
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onOnline);
    }
    periodicTimer = setInterval(() => {
      void refreshNow();
    }, PERIODIC_MS);
    // Startup trigger: the caller starts the scheduler after the gate.
    void refreshNow();
  }

  function stop(): void {
    disposed = true;
    started = false;
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
    /** Refresh the cache now (startup, focus, timer, online, manual). */
    refreshNow,
    /** Test seam: backoff state. */
    _debug: () => ({ failures, backoffUntil, running }),
  };
}

export type SyncScheduler = ReturnType<typeof createSyncScheduler>;
