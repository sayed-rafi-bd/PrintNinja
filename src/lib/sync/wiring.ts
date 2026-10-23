import { callApi, type ApiDeps } from "@/lib/api/client";
import { agent } from "@/lib/agent/commands";
import { endSession, getServiceUrl, getSessionToken } from "@/lib/share/client";
import type {
  EngineApi,
  EngineCache,
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
    forgetTemplate: (serverId) =>
      agent("cache_forget_template", { server_id: serverId }),
    listQueuedUses: () => agent("cache_list_queued_uses"),
    drainUse: async (serverId, count) => {
      await agent("cache_queue_use", { server_id: serverId, delta: -count });
    },
  };
}

/** The production library cache side: only the read paths the refresh needs. */
export function productionLibraryCache(): LibraryCache {
  return {
    listSyncedDatasets: () => agent("cache_list_synced_datasets"),
    listSyncedProfiles: () => agent("cache_list_synced_profiles"),
    listSyncedSettings: () => agent("cache_list_synced_settings"),
    listSyncedFonts: () => agent("cache_list_synced_fonts"),
    forgetDataset: (serverId) =>
      agent("cache_forget_dataset", { server_id: serverId }),
    forgetProfile: (serverId) =>
      agent("cache_forget_profile", { server_id: serverId }),
    forgetSetting: (key) => agent("cache_forget_setting", { key }),
    forgetFont: (serverId) =>
      agent("cache_forget_font", { server_id: serverId }),
    downloadPendingFonts: () => agent("cache_download_pending_fonts"),
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
    deleteTemplate: (id) =>
      callApi<void>(deps, { method: "DELETE", path: `/v2/templates/${id}` }),
    postUse: (id, count) =>
      callApi<void>(deps, {
        method: "POST",
        path: `/v2/templates/${id}/use`,
        body: { count },
      }),
  };
}
