import { ApiError, storedRevision } from "@/lib/api/errors";

/** One dirty cache row, as `cache_list_dirty` returns it. */
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
	listDirty(): Promise<DirtyRow[]>;
	listTombstoned(): Promise<string[]>;
	listSynced(): Promise<string[]>;
	applyChanges(changes: SyncChange[], newCursor: string): Promise<{ applied_upserts: number; applied_deletes: number; skipped_dirty: number }>;
	markPushed(serverId: string, revision: number): Promise<void>;
	markConflicted(serverId: string): Promise<void>;
	forgetTemplate(serverId: string): Promise<boolean>;
	listQueuedUses(): Promise<QueuedUse[]>;
	drainUse(serverId: string, count: number): Promise<void>;
	/**
	 * True while the first-sync adoption dialog is unanswered: rows that
	 * were never pushed (no base revision) wait for the person's decision
	 * instead of uploading silently. Absent means push everything.
	 */
	isAdoptionPending?: () => Promise<boolean>;
}

/** Network side of the engine. Production wires these to `callApi`. */
export interface EngineApi {
	fetchChanges(since: string): Promise<ChangesPage>;
	fetchTemplate(id: string): Promise<{ revision: number }>;
	putTemplate(
		id: string,
		body: {
			name: string;
			summary: string;
			page_w_mm: number;
			page_h_mm: number;
			language: "html";
			body: string;
			css: string;
			readme: string;
			if_revision?: number;
		},
	): Promise<{ revision: number }>;
	deleteTemplate(id: string): Promise<void>;
	postUse(id: string, count: number): Promise<void>;
}

export interface SyncSummary {
	pulled: number;
	pushed: number;
	conflicts: string[];
	usesSent: number;
	forgotten: number;
	/** Font files fetched after the pull. */
	fontsDownloaded: number;
	fontsFailed: number;
}

function freshServerId(): string {
	return crypto.randomUUID();
}

/**
 * Pull one full delta stream and apply it page by page. When the server
 * answers `reset: true`, the pass restarts from the empty cursor and
 * every synced row the pass did not contain is forgotten (tombstones for
 * 90 days are gone, so absence means deleted). With a library cache, the
 * reset pass covers datasets, profiles, settings and fonts the same way.
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
				if (change.op === "upsert" && typeof (change.data as { id?: unknown } | undefined)?.id === "string") {
					seen.add((change.data as { id: string }).id);
				}
				if (library && change.op === "upsert" && change.data && typeof change.data === "object") {
					const key = libraryKeyFor(change.entity, change.data as Record<string, unknown>);
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

/** Server key of a library upsert: the id, or the setting key. */
function libraryKeyFor(entity: string, data: Record<string, unknown>): string | null {
	if (entity === "dataset" || entity === "profile" || entity === "font") {
		return typeof data.id === "string" ? data.id : null;
	}
	if (entity === "setting") {
		return typeof data.key === "string" ? data.key : null;
	}
	return null;
}

const LIBRARY_ENTITIES: LibraryEntity[] = ["dataset", "profile", "setting", "font"];

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
	for (const entity of LIBRARY_ENTITIES) {
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
 * Push every dirty row. Creates omit `if_revision`; updates send the
 * base revision. A 409 marks the row conflicted for the dialog; any
 * other failure stops the push so the next trigger retries in order.
 */
export async function pushDirty(cache: EngineCache, api: EngineApi): Promise<{ pushed: number; conflicts: string[] }> {
	const rows = await cache.listDirty();
	let pushed = 0;
	const conflicts: string[] = [];
	const holdUnadopted = (await cache.isAdoptionPending?.()) ?? false;
	for (const row of rows) {
		// Local-only rows wait for the adoption dialog while it is
		// unanswered. Anything with a base revision was confirmed before
		// (or adopted already) and pushes normally.
		if (holdUnadopted && row.base_revision == null) {
			continue;
		}
		const serverId = row.server_id ?? freshServerId();
		const body = {
			name: row.name,
			summary: row.summary,
			page_w_mm: row.page_w_mm,
			page_h_mm: row.page_h_mm,
			language: "html" as const,
			body: row.html,
			css: row.css,
			readme: row.readme,
		};
		try {
			const res = await api.putTemplate(serverId, {
				...body,
				...(row.server_id && row.base_revision != null ? { if_revision: row.base_revision } : {}),
			});
			await cache.markPushed(serverId, res.revision);
			pushed += 1;
		} catch (err) {
			if (err instanceof ApiError && err.code === "revision_conflict") {
				await cache.markConflicted(serverId);
				conflicts.push(serverId);
				continue;
			}
			if (err instanceof ApiError && err.code === "revision_required") {
				// The server already has this id: a create whose response
				// was lost (reload, crash), or an adopted row. Retry as an
				// update against the stored revision.
				const current = await api.fetchTemplate(serverId);
				const res = await api.putTemplate(serverId, { ...body, if_revision: current.revision });
				await cache.markPushed(serverId, res.revision);
				pushed += 1;
				continue;
			}
			throw err;
		}
	}
	return { pushed, conflicts };
}

/** Push tombstones: DELETE each, forget the local copy on 204 or 404. */
export async function pushTombstones(cache: EngineCache, api: EngineApi): Promise<number> {
	const ids = await cache.listTombstoned();
	let done = 0;
	for (const id of ids) {
		try {
			await api.deleteTemplate(id);
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				// Already gone server-side: same end state.
			} else {
				throw err;
			}
		}
		await cache.forgetTemplate(id);
		done += 1;
	}
	return done;
}

/** Drain queued print counts. A failed POST stays queued for the next run. */
export async function drainUses(cache: EngineCache, api: EngineApi): Promise<number> {
	const queued = await cache.listQueuedUses();
	let sent = 0;
	for (const use of queued) {
		await api.postUse(use.server_template_id, use.count);
		await cache.drainUse(use.server_template_id, use.count);
		sent += use.count;
	}
	return sent;
}

// ── Library entities (Phase 4) ──────────────────────────────────────
// Datasets, profiles, settings and fonts sync through the same delta
// stream but have their own cache rows, so the engine drives them with
// a second cache/api pair. Revisions work like templates (428 retries
// as an update); conflicts resolve mine-wins by rebasing onto the
// server revision — only templates get the dialog. Settings carry no
// revisions at all: last writer wins.

/** Account-level entities by their server key. */
export type LibraryEntity = "dataset" | "profile" | "setting" | "font";

export interface DirtyDataset {
	server_id: string;
	name: string;
	data_json: string;
	base_revision: number | null;
}

export interface DirtyProfile {
	server_id: string;
	template_id: string;
	printer_name: string;
	settings_json: string;
	base_revision: number | null;
}

export interface DirtySetting {
	key: string;
	value: string;
	tombstone: boolean;
}

export interface DirtyFont {
	server_id: string;
	name: string;
	base_revision: number | null;
}

/** Cache side of the library engine. Production wires these to Tauri `invoke`. */
export interface LibraryCache {
	listDirtyDatasets(): Promise<DirtyDataset[]>;
	listDirtyProfiles(): Promise<DirtyProfile[]>;
	listDirtySettings(): Promise<DirtySetting[]>;
	listDirtyFonts(): Promise<DirtyFont[]>;
	listTombstonedDatasets(): Promise<string[]>;
	listTombstonedProfiles(): Promise<string[]>;
	listTombstonedSettings(): Promise<string[]>;
	listTombstonedFonts(): Promise<string[]>;
	listSyncedDatasets(): Promise<string[]>;
	listSyncedProfiles(): Promise<string[]>;
	listSyncedSettings(): Promise<string[]>;
	listSyncedFonts(): Promise<string[]>;
	markDatasetPushed(serverId: string, revision: number): Promise<void>;
	markProfilePushed(serverId: string, revision: number): Promise<void>;
	markSettingPushed(key: string): Promise<void>;
	markFontPushed(serverId: string, revision: number): Promise<void>;
	forgetDataset(serverId: string): Promise<unknown>;
	forgetProfile(serverId: string): Promise<unknown>;
	forgetSetting(key: string): Promise<unknown>;
	forgetFont(serverId: string): Promise<unknown>;
	/** Stored file bytes for the engine's file push. */
	readFontFile(serverId: string): Promise<number[]>;
	/** Fetch pending font files; failures stay pending for the next run. */
	downloadPendingFonts(): Promise<{ downloaded: number; failed: number }>;
}

/** Network side of the library engine. Production wires these to `callApi`. */
export interface LibraryApi {
	putDataset(
		id: string,
		body: { name: string; data_json: string; if_revision?: number },
	): Promise<{ revision: number }>;
	deleteDataset(id: string): Promise<void>;
	putProfile(
		id: string,
		body: { template_id: string; printer_name: string; settings_json: string; if_revision?: number },
	): Promise<{ revision: number }>;
	deleteProfile(id: string): Promise<void>;
	putSetting(key: string, value: string): Promise<unknown>;
	deleteSetting(key: string): Promise<void>;
	putFont(id: string, body: { name: string; if_revision?: number }): Promise<{ revision: number }>;
	putFontFile(id: string, bytes: Uint8Array): Promise<{ revision: number }>;
	deleteFont(id: string): Promise<void>;
}

function isNotFound(err: unknown): boolean {
	return err instanceof ApiError && err.status === 404;
}

function isRevisionRequired(err: unknown): boolean {
	return err instanceof ApiError && err.code === "revision_required";
}

function isRevisionConflict(err: unknown): boolean {
	return err instanceof ApiError && err.code === "revision_conflict";
}

/**
 * Push one versioned row (datasets, profiles, font metadata). Creates
 * omit `if_revision`; updates send the base revision. A 428 retries as
 * a first-revision update — only a lost create can own the id, so the
 * server holds revision 1. A 409 rebases mine-wins onto the stored
 * revision from the error details and retries once; a second 409 means
 * someone else won a live race, so the error stops the push to retry in
 * order. No fetch round-trip: the details carry the revision.
 */
async function pushVersioned(
	put: (ifRevision: number | undefined) => Promise<{ revision: number }>,
	baseRevision: number | null,
): Promise<number> {
	try {
		return (await put(baseRevision ?? undefined)).revision;
	} catch (err) {
		if (isRevisionConflict(err)) {
			const stored = storedRevision(err);
			if (stored === null) {
				throw err;
			}
			return (await put(stored)).revision;
		}
		if (!isRevisionRequired(err)) {
			throw err;
		}
		try {
			return (await put(baseRevision ?? 1)).revision;
		} catch (retryErr) {
			if (!isRevisionConflict(retryErr)) {
				throw retryErr;
			}
			const stored = storedRevision(retryErr);
			if (stored === null) {
				throw retryErr;
			}
			return (await put(stored)).revision;
		}
	}
}

/** Push one tombstone: DELETE it, forget the local copy on 204 or 404. */
async function pushTombstone(
	tombstoned: string[],
	del: (id: string) => Promise<void>,
	forget: (id: string) => Promise<unknown>,
): Promise<number> {
	let done = 0;
	for (const id of tombstoned) {
		try {
			await del(id);
		} catch (err) {
			if (isNotFound(err)) {
				// Already gone server-side: same end state.
			} else {
				throw err;
			}
		}
		await forget(id);
		done += 1;
	}
	return done;
}

/** Push tombstones for every library entity, in a fixed order. */
export async function pushLibraryTombstones(
	cache: LibraryCache,
	api: LibraryApi,
): Promise<number> {
	const [datasets, profiles, settings, fonts] = await Promise.all([
		cache.listTombstonedDatasets(),
		cache.listTombstonedProfiles(),
		cache.listTombstonedSettings(),
		cache.listTombstonedFonts(),
	]);
	return (
		(await pushTombstone(datasets, (id) => api.deleteDataset(id), (id) => cache.forgetDataset(id))) +
		(await pushTombstone(profiles, (id) => api.deleteProfile(id), (id) => cache.forgetProfile(id))) +
		(await pushTombstone(settings, (key) => api.deleteSetting(key), (key) => cache.forgetSetting(key))) +
		(await pushTombstone(fonts, (id) => api.deleteFont(id), (id) => cache.forgetFont(id)))
	);
}

/**
 * Push every dirty library row. Datasets, profiles and fonts follow the
 * versioned contract; settings have no revisions (PUT the value, or
 * DELETE it when the local row is a reset tombstone). Font bytes ride
 * right after the metadata; the row is marked with the file's revision.
 */
export async function pushLibraryDirty(cache: LibraryCache, api: LibraryApi): Promise<number> {
	let pushed = 0;
	const [datasets, profiles, settings, fonts] = await Promise.all([
		cache.listDirtyDatasets(),
		cache.listDirtyProfiles(),
		cache.listDirtySettings(),
		cache.listDirtyFonts(),
	]);
	for (const row of datasets) {
		const revision = await pushVersioned(
			(ifRevision) =>
				api.putDataset(row.server_id, {
					name: row.name,
					data_json: row.data_json,
					...(ifRevision === undefined ? {} : { if_revision: ifRevision }),
				}),
			row.base_revision,
		);
		await cache.markDatasetPushed(row.server_id, revision);
		pushed += 1;
	}
	for (const row of profiles) {
		const revision = await pushVersioned(
			(ifRevision) =>
				api.putProfile(row.server_id, {
					template_id: row.template_id,
					printer_name: row.printer_name,
					settings_json: row.settings_json,
					...(ifRevision === undefined ? {} : { if_revision: ifRevision }),
				}),
			row.base_revision,
		);
		await cache.markProfilePushed(row.server_id, revision);
		pushed += 1;
	}
	for (const row of settings) {
		if (row.tombstone) {
			try {
				await api.deleteSetting(row.key);
			} catch (err) {
				if (!isNotFound(err)) throw err;
			}
		} else {
			await api.putSetting(row.key, row.value);
		}
		await cache.markSettingPushed(row.key);
		pushed += 1;
	}
	for (const row of fonts) {
		const revision = await pushVersioned(
			(ifRevision) =>
				api.putFont(row.server_id, {
					name: row.name,
					...(ifRevision === undefined ? {} : { if_revision: ifRevision }),
				}),
			row.base_revision,
		);
		const bytes = new Uint8Array(await cache.readFontFile(row.server_id));
		const file = await api.putFontFile(row.server_id, bytes);
		await cache.markFontPushed(row.server_id, file.revision);
		pushed += 1;
	}
	return pushed;
}

/** Fetch pending font files after the pull applied their metadata. */
export async function downloadFontFiles(
	cache: LibraryCache,
): Promise<{ downloaded: number; failed: number }> {
	return cache.downloadPendingFonts();
}

/** One full sync: pull, confirm deletes, push edits, drain use counts.
 * With a library pair, datasets/profiles/settings/fonts push and
 * download in the same run, and their tombstones confirm too. */
export async function syncOnce(
	cache: EngineCache,
	api: EngineApi,
	library?: { cache: LibraryCache; api: LibraryApi },
): Promise<SyncSummary> {
	const { pulled, forgotten } = await pull(cache, api, library?.cache);
	const tombstones = await pushTombstones(cache, api);
	const { pushed, conflicts } = await pushDirty(cache, api);
	const usesSent = await drainUses(cache, api);
	let libraryPushed = 0;
	let libraryTombstones = 0;
	let fontsDownloaded = 0;
	let fontsFailed = 0;
	if (library) {
		libraryTombstones = await pushLibraryTombstones(library.cache, library.api);
		libraryPushed = await pushLibraryDirty(library.cache, library.api);
		({ downloaded: fontsDownloaded, failed: fontsFailed } = await downloadFontFiles(library.cache));
	}
	return {
		pulled: pulled + tombstones + libraryTombstones,
		pushed: pushed + libraryPushed,
		conflicts,
		usesSent,
		forgotten,
		fontsDownloaded,
		fontsFailed,
	};
}
