import { ApiError } from "@/lib/api/errors";

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
}

function freshServerId(): string {
	return crypto.randomUUID();
}

/**
 * Pull one full delta stream and apply it page by page. When the server
 * answers `reset: true`, the pass restarts from the empty cursor and
 * every synced row the pass did not contain is forgotten (tombstones for
 * 90 days are gone, so absence means deleted).
 */
export async function pull(cache: EngineCache, api: EngineApi): Promise<{ pulled: number; forgotten: number }> {
	let cursor = await cache.getCursor();
	let pulled = 0;
	let forgotten = 0;

	// A reset restarts the pass from scratch; at most one restart per pull
	// (the second pass is authoritative by construction).
	for (let attempt = 0; attempt < 2; attempt++) {
		const seen = new Set<string>();
		let resetting = false;
		for (;;) {
			const page = await api.fetchChanges(cursor);
			if (page.reset && !resetting) {
				resetting = true;
				cursor = "";
				seen.clear();
				continue;
			}
			for (const change of page.changes) {
				if (change.op === "upsert" && typeof (change.data as { id?: unknown } | undefined)?.id === "string") {
					seen.add((change.data as { id: string }).id);
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
		return { pulled, forgotten };
	}
	return { pulled, forgotten };
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
	for (const row of rows) {
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

/** One full sync: pull, confirm deletes, push edits, drain use counts. */
export async function syncOnce(cache: EngineCache, api: EngineApi): Promise<SyncSummary> {
	const { pulled, forgotten } = await pull(cache, api);
	const tombstones = await pushTombstones(cache, api);
	const { pushed, conflicts } = await pushDirty(cache, api);
	const usesSent = await drainUses(cache, api);
	return { pulled: pulled + tombstones, pushed, conflicts, usesSent, forgotten };
}
