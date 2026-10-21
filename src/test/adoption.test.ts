import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

const client = vi.hoisted(() => ({ putRemoteTemplate: vi.fn() }));
vi.mock("@/lib/share/client", () => client);
const putRemoteTemplate = client.putRemoteTemplate;

import {
  confirmAdoption,
  declineAdoption,
  ensureAdoptionChecked,
  getAdoptionState,
  resetAdoptionForTests,
} from "@/lib/sync/wiring";

// First-sync adoption (question 18). The module holds its state, so
// each case resets it through the public decline path first.
function settings(store: Record<string, string | null>, dirty: unknown[] = []) {
  invoke.mockImplementation(
    async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_setting") {
        const v = store[args?.["key"] as string];
        return v === undefined ? null : v;
      }
      if (cmd === "set_setting" && args) {
        store[args["key"] as string] = args["value"] as string;
        return null;
      }
      if (cmd === "cache_list_dirty") return dirty;
      if (cmd === "cache_mark_pushed") return null;
      throw new Error(`unexpected ${cmd}`);
    },
  );
}

const DIRTY = [
  {
    id: 1,
    server_id: "s1",
    name: "Local",
    summary: "",
    page_w_mm: 210,
    page_h_mm: 297,
    readme: "",
    html: "<p>x</p>",
    css: "",
    base_revision: null,
  },
];

describe("adoption gate", () => {
  beforeEach(() => {
    invoke.mockReset();
    putRemoteTemplate.mockReset();
    resetAdoptionForTests();
  });

  it("holds unpushed rows on a migrated install until answered", async () => {
    settings({ install_migrated: "1" }, DIRTY);
    await ensureAdoptionChecked();
    expect(getAdoptionState()).toEqual({
      hold: true,
      rows: [{ id: 1, server_id: "s1", name: "Local" }],
    });

    putRemoteTemplate.mockResolvedValue({ id: "s1", revision: 1 });
    await confirmAdoption();
    expect(putRemoteTemplate).toHaveBeenCalledTimes(1);
    expect(putRemoteTemplate.mock.calls[0][0]).toMatchObject({
      id: "s1",
      body: "<p>x</p>",
    });
    expect(getAdoptionState()).toEqual({ hold: false, rows: [] });
  });

  it("stays quiet on fresh installs and after an answer", async () => {
    settings({}, DIRTY);
    await ensureAdoptionChecked();
    expect(getAdoptionState().hold).toBe(false);

    await declineAdoption();
    expect(getAdoptionState()).toEqual({ hold: false, rows: [] });
    expect(putRemoteTemplate).not.toHaveBeenCalled();
  });
});
