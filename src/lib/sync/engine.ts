import { ApiError } from "@/lib/api/errors";

/**
 * The server-authoritative cache engine.
 *
 * The server owns templates, datasets, profiles, settings and fonts; the
 * local SQLite database is a read cache that this module keeps fresh.
 * There is no edit-push path here on purpose: saving is a manual,
 * synchronous action, so a change can never sit invisibly in a queue
 * waiting to be sent. The only thing that still travels without a button
 * press is the queued print-usage count (a print must never fail on a
 * network blip) and font files fetched by the pull.
 */

/** One dirty cache row, as `cache_list_dirty` returns it. Under the
 * server-authoritative model a dirty row is a *draft*: local edits not
 * yet saved to the server (legacy rows, or a save that failed). The
 * scheduler only counts these for display; it never pushes them. */
export interface DirtyRow {
  id: number;
  server_id: string | null;
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  readme: string;
  html: string;
  css: string;
  base_revision: number | null;
}

export interface QueuedUse {
  server_template_id: string;
  count: number;
}

export interface SyncChange {
  seq: string;
  entity: string;
  op: string;
  data?: Record<string, unknown>;
  id?: string;
}

export interface ChangesPage {
  changes: SyncChange[];
  next_cursor: string;
  has_more: boolean;
  reset: boolean;
}

/** Cache side of the engine. Production wires these to Tauri `invoke`. */
export interface EngineCache {
  getCursor(): Promise<string>;
  /** Local rows with edits not yet saved to the server (drafts). */
  listDirty(): Promise<DirtyRow[]>;
  listTombstoned(): Promise<string[]>;
  listSynced(): Promise<string[]>;
  applyChanges(
    changes: SyncChange[],
    newCursor: string,
  ): Promise<{
    applied_upserts: number;
    applied_deletes: number;
    skipped_dirty: number;
  }>;
  forgetTemplate(serverId: string): Promise<boolean>;
  listQueuedUses(): Promise<QueuedUse[]>;
  drainUse(serverId: string, count: number): Promise<void>;
}

/** Network side of the engine. Production wires these to `callApi`. */
export interface EngineApi {
  fetchChanges(since: string): Promise<ChangesPage>;
  deleteTemplate(id: string): Promise<void>;
  postUse(id: string, count: number): Promise<void>;
}

/** Server key of a library upsert: the id, or the setting key. */
function libraryKeyFor(
  entity: string,
  data: Record<string, unknown>,
): string | null {
  if (entity === "dataset" || entity === "profile" || entity === "font") {
    return typeof data.id === "string" ? data.id : null;
  }
  if (entity === "setting") {
    return typeof data.key === "string" ? data.key : null;
  }
  return null;
}

/** Cache side of the library entities (datasets, profiles, settings,
 * fonts). Only the read paths are needed to keep the cache fresh. */
export interface LibraryCache {
  listSyncedDatasets(): Promise<string[]>;
  listSyncedProfiles(): Promise<string[]>;
  listSyncedSettings(): Promise<string[]>;
  listSyncedFonts(): Promise<string[]>;
  forgetDataset(serverId: string): Promise<unknown>;
  forgetProfile(serverId: string): Promise<unknown>;
  forgetSetting(key: string): Promise<unknown>;
  forgetFont(serverId: string): Promise<unknown>;
  /** Fetch pending font files; failures stay pending for the next run. */
  downloadPendingFonts(): Promise<{ downloaded: number; failed: number }>;
}

type LibraryEntity = "dataset" | "profile" | "setting" | "font";

/**
 * Pull one full delta stream and apply it page by page. When the server
 * answers `reset: true`, the pass restarts from the empty cursor and
 * every synced row the pass did not contain is forgotten (tombstones for
 * 90 days are gone, so absence means deleted). With a library cache, the
 * reset pass covers datasets, profiles, settings and fonts the same way.
 *
 * Rows the cache marks dirty (a draft) are left alone by `applyChanges`,
 * so a refresh can never clobber edits that are not on the server yet.
 */
export async function pull(
  cache: EngineCache,
  api: EngineApi,
  library?: LibraryCache,
): Promise<{ pulled: number; forgotten: number }> {
  let cursor = await cache.getCursor();
  let pulled = 0;
  let forgotten = 0;

  // A reset restarts the pass from scratch; at most one restart per pull
  // (the second pass is authoritative by construction).
  for (let attempt = 0; attempt < 2; attempt++) {
    const seen = new Set<string>();
    const seenLibrary: Record<LibraryEntity, Set<string>> = {
      dataset: new Set(),
      profile: new Set(),
      setting: new Set(),
      font: new Set(),
    };
    let resetting = false;
    for (;;) {
      const page = await api.fetchChanges(cursor);
      if (page.reset && !resetting) {
        resetting = true;
        cursor = "";
        seen.clear();
        for (const set of Object.values(seenLibrary)) set.clear();
        continue;
      }
      for (const change of page.changes) {
        if (
          change.op === "upsert" &&
          typeof (change.data as { id?: unknown } | undefined)?.id === "string"
        ) {
          seen.add((change.data as { id: string }).id);
        }
        if (
          library &&
          change.op === "upsert" &&
          change.data &&
          typeof change.data === "object"
        ) {
          const key = libraryKeyFor(
            change.entity,
            change.data as Record<string, unknown>,
          );
          if (key) seenLibrary[change.entity as LibraryEntity]?.add(key);
        }
      }
      const report = await cache.applyChanges(page.changes, page.next_cursor);
      pulled += report.applied_upserts + report.applied_deletes;
      cursor = page.next_cursor;
      if (!page.has_more) {
        break;
      }
    }
    if (!resetting) {
      return { pulled, forgotten };
    }
    // Reset pass finished: drop synced rows the server no longer knows.
    const synced = await cache.listSynced();
    for (const id of synced) {
      if (!seen.has(id)) {
        await cache.forgetTemplate(id);
        forgotten += 1;
      }
    }
    if (library) {
      forgotten += await forgetMissingLibrary(library, seenLibrary);
    }
    return { pulled, forgotten };
  }
  return { pulled, forgotten };
}

/** Forget synced library rows the reset pass did not contain. */
async function forgetMissingLibrary(
  library: LibraryCache,
  seen: Record<LibraryEntity, Set<string>>,
): Promise<number> {
  let forgotten = 0;
  const lists: Record<LibraryEntity, () => Promise<string[]>> = {
    dataset: () => library.listSyncedDatasets(),
    profile: () => library.listSyncedProfiles(),
    setting: () => library.listSyncedSettings(),
    font: () => library.listSyncedFonts(),
  };
  const forgets: Record<LibraryEntity, (key: string) => Promise<unknown>> = {
    dataset: (id) => library.forgetDataset(id),
    profile: (id) => library.forgetProfile(id),
    setting: (key) => library.forgetSetting(key),
    font: (id) => library.forgetFont(id),
  };
  for (const entity of ["dataset", "profile", "setting", "font"] as const) {
    const synced = await lists[entity]();
    for (const key of synced) {
      if (!seen[entity].has(key)) {
        await forgets[entity](key);
        forgotten += 1;
      }
    }
  }
  return forgotten;
}

/**
 * Push tombstones left behind by the old local-first model: a row the
 * user deleted before this branch existed. Deletes now go straight to
 * the server, so this only drains legacy rows and then stops finding
 * anything. A 404 means the server copy is already gone — same end
 * state.
 */
export async function flushTombstones(
  cache: EngineCache,
  api: EngineApi,
): Promise<number> {
  const ids = await cache.listTombstoned();
  let done = 0;
  for (const id of ids) {
    try {
      await api.deleteTemplate(id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        throw err;
      }
    }
    await cache.forgetTemplate(id);
    done += 1;
  }
  return done;
}

/** Drain queued print counts. A failed POST stays queued for the next run. */
export async function drainUses(
  cache: EngineCache,
  api: EngineApi,
): Promise<number> {
  const queued = await cache.listQueuedUses();
  let sent = 0;
  for (const use of queued) {
    await api.postUse(use.server_template_id, use.count);
    await cache.drainUse(use.server_template_id, use.count);
    sent += use.count;
  }
  return sent;
}

/** Fetch pending font files after the pull applied their metadata. */
export async function downloadFontFiles(
  cache: LibraryCache,
): Promise<{ downloaded: number; failed: number }> {
  return cache.downloadPendingFonts();
}
