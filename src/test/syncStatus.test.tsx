import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { cacheNow, useSyncStatus } from "@/lib/sync/useSyncStatus";
import type { EngineApi, EngineCache, LibraryCache } from "@/lib/sync/engine";

function fakes(
  over: { cache?: Partial<EngineCache>; api?: Partial<EngineApi> } = {},
) {
  const cache: EngineCache = {
    getCursor: async () => "",
    listDirty: async () => [],
    listTombstoned: async () => [],
    listSynced: async () => [],
    applyChanges: async () => ({
      applied_upserts: 0,
      applied_deletes: 0,
      skipped_dirty: 0,
      conflicts: 0,
    }),
    forgetTemplate: async () => true,
    listQueuedUses: async () => [],
    drainUse: async () => {},
    ...over.cache,
  };
  const api: EngineApi = {
    fetchChanges: async () => ({
      changes: [],
      next_cursor: "MQ==",
      has_more: false,
      reset: false,
    }),
    deleteTemplate: async () => {},
    postUse: async () => {},
    ...over.api,
  };
  const library: LibraryCache = {
    listSyncedDatasets: async () => [],
    listSyncedProfiles: async () => [],
    listSyncedSettings: async () => [],
    listSyncedFonts: async () => [],
    forgetDataset: async () => true,
    forgetProfile: async () => true,
    forgetSetting: async () => true,
    forgetFont: async () => true,
    downloadPendingFonts: async () => ({ downloaded: 0, failed: 0 }),
  };
  return { cache, api, library: { cache: library } };
}

function Probe(props: {
  cache?: EngineCache;
  api?: EngineApi;
  library?: { cache: LibraryCache };
}) {
  const faked = fakes();
  const status = useSyncStatus({
    cache: props.cache ?? faked.cache,
    api: props.api ?? faked.api,
    library: props.library ?? faked.library,
  });
  return <p data-testid="sync">{`${status.state}:${status.drafts}`}</p>;
}

describe("useSyncStatus", () => {
  it("starts syncing and settles synced on a clean account", async () => {
    const { cache, api } = fakes();
    render(<Probe cache={cache} api={api} />);
    expect(screen.getByTestId("sync")).toHaveTextContent("syncing");
    await waitFor(() =>
      expect(screen.getByTestId("sync")).toHaveTextContent(/^synced:0$/),
    );
  });

  it("reports offline when the first pull fails", async () => {
    const { cache, api } = fakes({
      api: {
        fetchChanges: async () => {
          throw new Error("down");
        },
      },
    });
    render(<Probe cache={cache} api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("sync")).toHaveTextContent(/^offline/),
    );
  });

  it("counts local drafts without sending them", async () => {
    const { cache, api } = fakes({
      cache: {
        listDirty: async () => [
          {
            id: 1,
            server_id: "s1",
            name: "Draft",
            summary: "",
            page_w_mm: 80,
            page_h_mm: 200,
            readme: "",
            html: "<p>x</p>",
            css: "",
            base_revision: null,
          },
        ],
      },
    });
    render(<Probe cache={cache} api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("sync")).toHaveTextContent(/^synced:1$/),
    );
  });

  it("cacheNow without a mounted scheduler is a safe no-op", async () => {
    await expect(cacheNow()).resolves.toBeUndefined();
  });
});
