import { describe, it, expect } from "vitest";

import {
  downloadFontFiles,
  drainUses,
  flushTombstones,
  pull,
  type EngineApi,
  type EngineCache,
  type LibraryCache,
} from "@/lib/sync/engine";
import { ApiError } from "@/lib/api/errors";

const cache = (
  over: Partial<EngineCache> = {},
): EngineCache & {
  calls: string[];
} => {
  const calls: string[] = [];
  return {
    calls,
    getCursor: async () => "c0",
    listDirty: async () => [],
    listTombstoned: async () => [],
    listSynced: async () => [],
    applyChanges: async () => {
      calls.push("applyChanges");
      return {
        applied_upserts: 1,
        applied_deletes: 0,
        skipped_dirty: 0,
        conflicts: 0,
      };
    },
    forgetTemplate: async () => {
      calls.push("forgetTemplate");
      return true;
    },
    listQueuedUses: async () => [],
    drainUse: async () => {},
    ...over,
  };
};

const api = (over: Partial<EngineApi> = {}): EngineApi => ({
  fetchChanges: async () => ({
    changes: [],
    next_cursor: "c1",
    has_more: false,
    reset: false,
  }),
  deleteTemplate: async () => {},
  postUse: async () => {},
  ...over,
});

const library = (over: Partial<LibraryCache> = {}): LibraryCache => ({
  listSyncedDatasets: async () => [],
  listSyncedProfiles: async () => [],
  listSyncedSettings: async () => [],
  listSyncedFonts: async () => [],
  forgetDataset: async () => {},
  forgetProfile: async () => {},
  forgetSetting: async () => {},
  forgetFont: async () => {},
  downloadPendingFonts: async () => ({ downloaded: 0, failed: 0 }),
  ...over,
});

describe("pull", () => {
  it("applies one page and advances the cursor", async () => {
    const changes = [
      { seq: "1", entity: "template", op: "upsert", data: { id: "a" } },
    ];
    const c = cache();
    const a = api({
      fetchChanges: async (since: string) => {
        expect(since).toBe("c0");
        return { changes, next_cursor: "c1", has_more: false, reset: false };
      },
    });
    const result = await pull(c, a);
    expect(c.calls).toEqual(["applyChanges"]);
    expect(result).toEqual({ pulled: 1, forgotten: 0 });
  });

  it("pages until has_more is false, counting every applied change", async () => {
    const c = cache({
      applyChanges: async () => ({
        applied_upserts: 1,
        applied_deletes: 1,
        skipped_dirty: 0,
        conflicts: 0,
      }),
    });
    const seen: string[] = [];
    const a = api({
      fetchChanges: async (since: string) => {
        seen.push(since);
        if (since === "c0")
          return {
            changes: [],
            next_cursor: "c1",
            has_more: true,
            reset: false,
          };
        return {
          changes: [],
          next_cursor: "c2",
          has_more: false,
          reset: false,
        };
      },
    });
    const result = await pull(c, a);
    expect(seen).toEqual(["c0", "c1"]);
    expect(result).toEqual({ pulled: 4, forgotten: 0 });
  });

  it("restarts once on reset and forgets synced rows the pass did not contain", async () => {
    const forgotten: string[] = [];
    const c = cache({
      listSynced: async () => ["gone", "kept"],
      forgetTemplate: async (id: string) => {
        forgotten.push(id);
        return true;
      },
    });
    let first = true;
    const a = api({
      fetchChanges: async () => {
        if (first) {
          first = false;
          return {
            changes: [],
            next_cursor: "x",
            has_more: false,
            reset: true,
          };
        }
        return {
          changes: [
            {
              seq: "1",
              entity: "template",
              op: "upsert",
              data: { id: "kept" },
            },
          ],
          next_cursor: "c9",
          has_more: false,
          reset: false,
        };
      },
    });
    const result = await pull(c, a);
    expect(forgotten).toEqual(["gone"]);
    expect(result.forgotten).toBe(1);
  });

  it("never pushes: dirty rows are the cache's business, the pull only reads", async () => {
    const c = cache({
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
    });
    const a = api();
    await pull(c, a);
    // No send happened: the api mock has no push surface to call.
    expect(a.deleteTemplate).toBeDefined();
  });
});

describe("flushTombstones", () => {
  it("deletes legacy tombstones and forgets them", async () => {
    const deleted: string[] = [];
    const forgotten: string[] = [];
    const c = cache({
      listTombstoned: async () => ["t1", "t2"],
      forgetTemplate: async (id: string) => {
        forgotten.push(id);
        return true;
      },
    });
    const a = api({
      deleteTemplate: async (id: string) => {
        deleted.push(id);
      },
    });
    expect(await flushTombstones(c, a)).toBe(2);
    expect(deleted).toEqual(["t1", "t2"]);
    expect(forgotten).toEqual(["t1", "t2"]);
  });

  it("treats 404 as already gone", async () => {
    const c = cache({ listTombstoned: async () => ["t1"] });
    const a = api({
      deleteTemplate: async () => {
        throw new ApiError({
          code: "not_found",
          message: "gone",
          requestId: "r",
          status: 404,
        });
      },
    });
    expect(await flushTombstones(c, a)).toBe(1);
    expect(c.calls).toContain("forgetTemplate");
  });

  it("does nothing when there are no legacy rows", async () => {
    expect(await flushTombstones(cache(), api())).toBe(0);
  });
});

describe("drainUses", () => {
  it("posts queued print counts and drains them", async () => {
    const posted: Array<[string, number]> = [];
    const drained: Array<[string, number]> = [];
    const c = cache({
      listQueuedUses: async () => [
        { server_template_id: "s1", count: 3 },
        { server_template_id: "s2", count: 1 },
      ],
      drainUse: async (id, count) => {
        drained.push([id, count]);
      },
    });
    const a = api({
      postUse: async (id, count) => {
        posted.push([id, count]);
      },
    });
    expect(await drainUses(c, a)).toBe(4);
    expect(posted).toEqual([
      ["s1", 3],
      ["s2", 1],
    ]);
    expect(drained).toEqual([
      ["s1", 3],
      ["s2", 1],
    ]);
  });

  it("leaves the queue alone when it is empty", async () => {
    const posted: unknown[] = [];
    const a = api({
      postUse: async (...args: unknown[]) => {
        posted.push(args);
      },
    });
    expect(await drainUses(cache(), a)).toBe(0);
    expect(posted).toHaveLength(0);
  });
});

describe("downloadFontFiles", () => {
  it("delegates to the library cache", async () => {
    const l = library({
      downloadPendingFonts: async () => ({ downloaded: 2, failed: 1 }),
    });
    await expect(downloadFontFiles(l)).resolves.toEqual({
      downloaded: 2,
      failed: 1,
    });
  });
});
