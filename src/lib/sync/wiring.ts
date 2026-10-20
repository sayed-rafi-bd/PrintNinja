import { callApi, type ApiDeps } from "@/lib/api/client";
import { agent } from "@/lib/agent/commands";
import { endSession, getServiceUrl, getSessionToken } from "@/lib/share/client";
import { adoptLocalTemplates } from "@/lib/share/sync";
import {
	deleteRemoteDataset,
	deleteRemoteFont,
	deleteRemoteProfile,
	deleteRemoteSetting,
	putRemoteDataset,
	putRemoteFont,
	putRemoteProfile,
	putRemoteSetting,
	uploadRemoteFontFile,
} from "@/lib/share/client";
import type {
	EngineApi,
	EngineCache,
	LibraryApi,
	LibraryCache,
	SyncChange,
} from "./engine";

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
			const state = await agent("cache_get_sync_state");
			return state.cursor ?? "";
		},
		listDirty: () => agent("cache_list_dirty"),
		listTombstoned: () => agent("cache_list_tombstoned"),
		listSynced: () => agent("cache_list_synced"),
		applyChanges: (changes, newCursor) =>
			agent("cache_apply_changes", { changes, new_cursor: newCursor }),
		markPushed: async (serverId, revision) => {
			await agent("cache_mark_pushed", { server_id: serverId, revision });
		},
		markConflicted: async (serverId) => {
			await agent("cache_mark_conflicted", { server_id: serverId });
		},
		forgetTemplate: (serverId) => agent("cache_forget_template", { server_id: serverId }),
		listQueuedUses: () => agent("cache_list_queued_uses"),
		drainUse: async (serverId, count) => {
			await agent("cache_queue_use", { server_id: serverId, delta: -count });
		},
		isAdoptionPending: async () => adoption.hold,
	};
}

/** The production library cache side: thin wrappers over the Tauri cache commands. */
export function productionLibraryCache(): LibraryCache {
	return {
		listDirtyDatasets: () => agent("cache_list_dirty_datasets"),
		listDirtyProfiles: () => agent("cache_list_dirty_profiles"),
		listDirtySettings: () => agent("cache_list_dirty_settings"),
		listDirtyFonts: () => agent("cache_list_dirty_fonts"),
		listTombstonedDatasets: () => agent("cache_list_tombstoned_datasets"),
		listTombstonedProfiles: () => agent("cache_list_tombstoned_profiles"),
		listTombstonedSettings: () => agent("cache_list_tombstoned_settings"),
		listTombstonedFonts: () => agent("cache_list_tombstoned_fonts"),
		listSyncedDatasets: () => agent("cache_list_synced_datasets"),
		listSyncedProfiles: () => agent("cache_list_synced_profiles"),
		listSyncedSettings: () => agent("cache_list_synced_settings"),
		listSyncedFonts: () => agent("cache_list_synced_fonts"),
		markDatasetPushed: async (serverId, revision) => {
			await agent("cache_mark_dataset_pushed", { server_id: serverId, revision });
		},
		markProfilePushed: async (serverId, revision) => {
			await agent("cache_mark_profile_pushed", { server_id: serverId, revision });
		},
		markSettingPushed: async (key) => {
			await agent("cache_mark_setting_pushed", { key });
		},
		markFontPushed: async (serverId, revision) => {
			await agent("cache_mark_font_pushed", { server_id: serverId, revision });
		},
		forgetDataset: (serverId) => agent("cache_forget_dataset", { server_id: serverId }),
		forgetProfile: (serverId) => agent("cache_forget_profile", { server_id: serverId }),
		forgetSetting: (key) => agent("cache_forget_setting", { key }),
		forgetFont: (serverId) => agent("cache_forget_font", { server_id: serverId }),
		readFontFile: (serverId) => agent("cache_read_font_file", { server_id: serverId }),
		downloadPendingFonts: () => agent("cache_download_pending_fonts"),
	};
}

/** The production library network side: the typed v2 API through callApi. */
export function productionLibraryApi(deps: ApiDeps = apiDeps()): LibraryApi {
	return {
		putDataset: (id, body) => putRemoteDataset({ id, ...body }),
		deleteDataset: (id) => deleteRemoteDataset(id),
		putProfile: (id, body) => putRemoteProfile({ id, ...body }),
		deleteProfile: (id) => deleteRemoteProfile(id),
		putSetting: (key, value) => putRemoteSetting(key, value),
		deleteSetting: (key) => deleteRemoteSetting(key),
		putFont: (id, body) => putRemoteFont({ id, ...body }),
		putFontFile: (id, bytes) => uploadRemoteFontFile(id, bytes),
		deleteFont: (id) => deleteRemoteFont(id),
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
					agent("get_setting", { key: "sync_adopted" }),
					agent("get_setting", { key: "install_migrated" }),
					agent("cache_list_dirty"),
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
	await agent("set_setting", { key: "sync_adopted", value: "yes" }).catch(() => {});
}

/** Dismiss without pushing; the rows upload on the normal schedule. */
export async function declineAdoption(): Promise<void> {
	adoption.hold = false;
	adoption.rows = [];
	await agent("set_setting", { key: "sync_adopted", value: "no" }).catch(() => {});
}
