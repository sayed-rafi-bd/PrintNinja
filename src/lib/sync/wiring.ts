import { callApi, type ApiDeps } from "@/lib/api/client";
import { invoke } from "@/lib/invoke";
import { endSession, getServiceUrl, getSessionToken } from "@/lib/share/client";
import type { EngineApi, EngineCache, SyncChange } from "./engine";

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
		putTemplate: (id, body) =>
			callApi<{ revision: number }>(deps, { method: "PUT", path: `/v2/templates/${id}`, body }),
		deleteTemplate: (id) => callApi<void>(deps, { method: "DELETE", path: `/v2/templates/${id}` }),
		postUse: (id, count) =>
			callApi<void>(deps, { method: "POST", path: `/v2/templates/${id}/use`, body: { count } }),
	};
}
