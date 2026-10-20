import { callApi, type ApiDeps } from "@/lib/api/client";
import { invoke } from "@/lib/invoke";
import { endSession, getServiceUrl, getSessionToken } from "@/lib/share/client";
import { adoptLocalTemplates } from "@/lib/share/sync";
import type { DirtyRow, EngineApi, EngineCache, SyncChange } from "./engine";

function apiDeps(): ApiDeps {
	return {
		getBaseUrl: getServiceUrl,
		getToken: getSessionToken,
		onUnauthorized: () => endSession("expired"),
	};
}

interface ChangesResponse {
	changes: SyncChange[];
	next_cursor: string;
	has_more: boolean;
	reset: boolean;
}

/** The production cache side: thin wrappers over the Tauri cache commands. */
export function productionCache(): EngineCache {
	return {
		getCursor: async () => {
			const state = await invoke<{ cursor: string }>("cache_get_sync_state");
			return state.cursor ?? "";
		},
		listDirty: () => invoke("cache_list_dirty"),
		listTombstoned: () => invoke("cache_list_tombstoned"),
		listSynced: () => invoke("cache_list_synced"),
		applyChanges: (changes, newCursor) =>
			invoke("cache_apply_changes", { changes, new_cursor: newCursor }),
		markPushed: (serverId, revision) => invoke("cache_mark_pushed", { server_id: serverId, revision }) as Promise<void>,
		markConflicted: (serverId) => invoke("cache_mark_conflicted", { server_id: serverId }) as Promise<void>,
		forgetTemplate: (serverId) => invoke<boolean>("cache_forget_template", { server_id: serverId }),
		listQueuedUses: () => invoke("cache_list_queued_uses"),
		drainUse: async (serverId, count) => {
			await invoke("cache_queue_use", { server_id: serverId, delta: -count });
		},
		isAdoptionPending: async () => adoption.hold,
	};
}

/** The production network side: the typed v2 API through `callApi`. */
export function productionApi(deps: ApiDeps = apiDeps()): EngineApi {
	return {
		fetchChanges: (since) =>
			callApi<ChangesResponse>(deps, {
				method: "GET",
				path: `/v2/sync/changes?since=${encodeURIComponent(since)}&limit=100`,
			}),
		fetchTemplate: (id) => callApi<{ revision: number }>(deps, { method: "GET", path: `/v2/templates/${id}` }),
		putTemplate: (id, body) =>
			callApi<{ revision: number }>(deps, { method: "PUT", path: `/v2/templates/${id}`, body }),
		deleteTemplate: (id) => callApi<void>(deps, { method: "DELETE", path: `/v2/templates/${id}` }),
		postUse: (id, count) =>
			callApi<void>(deps, { method: "POST", path: `/v2/templates/${id}/use`, body: { count } }),
	};
}

export interface HeldRow {
	id: number;
	server_id: string | null;
	name: string;
}

/**
 * First-sync adoption (REFACTORING.md question 18): on a migrated
 * install, local-only rows wait for the person's one-time decision
 * instead of uploading silently. `hold` gates engine pushes of
 * never-pushed rows; the dialog confirms (push private now) or declines
 * (push on the normal schedule).
 */
const adoption = {
	checked: false,
	hold: false,
	rows: [] as DirtyRow[],
};

/** Test seam: the adoption module checks once per app start. */
export function resetAdoptionForTests(): void {
	adoption.checked = false;
	adoption.hold = false;
	adoption.rows = [];
	checkPromise = null;
}

let checkPromise: Promise<void> | null = null;

export function getAdoptionState(): { hold: boolean; rows: HeldRow[] } {
	return {
		hold: adoption.hold,
		rows: adoption.rows.map(({ id, server_id, name }) => ({ id, server_id, name })),
	};
}

/** Run once at startup: decide whether the adoption dialog must appear.
 * Late subscribers (StrictMode remounts) await the same in-flight check
 * instead of reading state before it lands. */
export async function ensureAdoptionChecked(): Promise<void> {
	if (!checkPromise) {
		checkPromise = (async () => {
			adoption.checked = true;
			try {
				const [adopted, migrated, dirty] = await Promise.all([
					invoke<string | null>("get_setting", { key: "sync_adopted" }),
					invoke<string | null>("get_setting", { key: "install_migrated" }),
					invoke<DirtyRow[]>("cache_list_dirty"),
				]);
				const unpushed = dirty.filter((r) => r.base_revision == null);
				if (adopted == null && migrated != null && unpushed.length > 0) {
					adoption.hold = true;
					adoption.rows = unpushed;
				}
			} catch {
				adoption.hold = false;
				adoption.rows = [];
			}
		})();
	}
	return checkPromise;
}

/** Push the held rows private and remember the answer. A failure keeps
 * the dialog pending so the person can retry once back online. */
export async function confirmAdoption(): Promise<void> {
	await adoptLocalTemplates(adoption.rows);
	adoption.hold = false;
	adoption.rows = [];
	await invoke("set_setting", { key: "sync_adopted", value: "yes" }).catch(() => {});
}

/** Dismiss without pushing; the rows upload on the normal schedule. */
export async function declineAdoption(): Promise<void> {
	adoption.hold = false;
	adoption.rows = [];
	await invoke("set_setting", { key: "sync_adopted", value: "no" }).catch(() => {});
}
