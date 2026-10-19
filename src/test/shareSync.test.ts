import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const client = vi.hoisted(() => ({
  publishTemplate: vi.fn(),
  fetchRemoteTemplate: vi.fn(),
  fetchMyRemoteTemplates: vi.fn(),
  fetchSavedRemoteTemplates: vi.fn(),
}));
vi.mock("@/lib/share/client", () => client);

import {
  downloadToLocal,
  isReadOnly,
  listAvailableRemoteTemplates,
  refreshFromServer,
  saveToServer,
  type SyncTemplate,
} from "@/lib/share/sync";

const REMOTE = {
  id: "11111111-1111-4111-8111-111111111111",
  owner_id: "u1",
  owner_handle: "ana",
  name: "Invoice",
  summary: "A4 invoice",
  page_w_mm: 210.4,
  page_h_mm: 297.2,
  language: "html",
  body: "<p>remote</p>",
  css: ".remote {}",
  readme: "# Invoice",
  use_count: 0,
  published_at: "2026-03-01 00:00:00",
  updated_at: "2026-03-02 00:00:00",
};

const local = (over: Partial<SyncTemplate> = {}): SyncTemplate => ({
  id: 7,
  name: "Invoice",
  summary: "A4 invoice",
  page_w_mm: 210,
  page_h_mm: 297,
  readme: "# Invoice",
  remote_id: null,
  published_at: null,
  origin: "own",
  origin_owner: null,
  ...over,
});

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const argOf = (cmd: string, index = 1) => invoke.mock.calls.find((c) => c[0] === cmd)?.[index];

beforeEach(() => {
  invoke.mockReset();
  client.publishTemplate.mockReset();
  client.fetchRemoteTemplate.mockReset();
  client.fetchMyRemoteTemplates.mockReset();
  client.fetchSavedRemoteTemplates.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_versions") return [{ id: 3, html: "<p>local</p>", css: ".local {}" }];
    if (cmd === "list_templates") return [];
    return null;
  });
});

describe("saved copies", () => {
  it("are read-only, own templates are not", () => {
    expect(isReadOnly({ origin: "saved" })).toBe(true);
    expect(isReadOnly({ origin: "own" })).toBe(false);
  });
});

describe("saveToServer", () => {
  it("sends the current version's HTML and CSS and stores the returned id", async () => {
    client.publishTemplate.mockResolvedValue({ ...REMOTE, published_at: "" });
    const result = await saveToServer(local());

    const payload = client.publishTemplate.mock.calls[0][0];
    expect(payload.body).toBe("<p>local</p>");
    expect(payload.css).toBe(".local {}"); // CSS must not be left behind
    expect(payload.readme).toBe("# Invoice");
    expect(result.remoteId).toBe(REMOTE.id);
    expect(invoke).toHaveBeenCalledWith("set_publish_info", {
      req: { id: 7, remote_id: REMOTE.id, published_at: null },
    });
  });

  it("stores a first save as a private copy", async () => {
    client.publishTemplate.mockResolvedValue({ ...REMOTE, published_at: "" });
    await saveToServer(local());
    expect(client.publishTemplate.mock.calls[0][0].publish).toBe(false);
  });

  it("leaves the visibility of a published template alone", async () => {
    client.publishTemplate.mockResolvedValue(REMOTE);
    await saveToServer(local({ remote_id: REMOTE.id, published_at: "2026-03-01T00:00:00Z" }));
    expect(client.publishTemplate.mock.calls[0][0].publish).toBeUndefined();
  });

  it("publishes when asked to", async () => {
    client.publishTemplate.mockResolvedValue(REMOTE);
    const result = await saveToServer(local(), { publish: true });
    expect(client.publishTemplate.mock.calls[0][0].publish).toBe(true);
    expect(result.published).toBe(true);
    expect(invoke).toHaveBeenCalledWith("set_publish_info", {
      req: { id: 7, remote_id: REMOTE.id, published_at: REMOTE.updated_at },
    });
  });
});

describe("refreshFromServer", () => {
  it("overwrites the local copy with the server one", async () => {
    client.fetchRemoteTemplate.mockResolvedValue(REMOTE);
    const result = await refreshFromServer(local({ remote_id: REMOTE.id }));

    expect(calls("create_version")[0][1]).toMatchObject({
      req: { template_id: 7, html: REMOTE.body, css: REMOTE.css, created_by: "sync" },
    });
    expect(calls("update_readme")[0][1]).toEqual({ req: { id: 7, readme: REMOTE.readme } });
    expect(calls("update_template_meta")[0][1]).toEqual({
      req: { id: 7, name: "Invoice", page_w_mm: 210, page_h_mm: 297, summary: "A4 invoice" },
    });
    expect(result.page_w_mm).toBe(210);
    expect(invoke).toHaveBeenCalledWith("set_publish_info", {
      req: { id: 7, remote_id: REMOTE.id, published_at: REMOTE.updated_at },
    });
  });

  it("leaves a template that is private on the server private here too", async () => {
    client.fetchRemoteTemplate.mockResolvedValue({ ...REMOTE, published_at: "" });
    await refreshFromServer(local({ remote_id: REMOTE.id, published_at: null }));
    expect(calls("set_publish_info")[0][1]).toEqual({
      req: { id: 7, remote_id: REMOTE.id, published_at: null },
    });
  });

  it("writes nothing when the server copy cannot be fetched", async () => {
    client.fetchRemoteTemplate.mockRejectedValue(new Error("Template not found"));
    await expect(refreshFromServer(local({ remote_id: REMOTE.id }))).rejects.toThrow("Template not found");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a template that was never saved", async () => {
    await expect(refreshFromServer(local())).rejects.toThrow(/not on the server/);
    expect(client.fetchRemoteTemplate).not.toHaveBeenCalled();
  });
});

describe("downloadToLocal", () => {
  it("adds the template with its CSS, README and server link", async () => {
    client.fetchRemoteTemplate.mockResolvedValue(REMOTE);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_versions") return [];
      if (cmd === "list_templates") return [];
      if (cmd === "create_template") return { id: 12 };
      return null;
    });

    const result = await downloadToLocal(REMOTE.id, "saved", "ana");
    expect(result).toEqual({ id: 12, created: true });
    expect(calls("create_template")[0][1]).toMatchObject({
      req: { name: "Invoice", html: REMOTE.body, css: REMOTE.css, readme: REMOTE.readme, summary: REMOTE.summary, orientation: "portrait" },
    });
    expect(calls("update_template_origin")[0][1]).toEqual({
      req: { id: 12, origin: "saved", origin_owner: "ana" },
    });
  });

  it("derives landscape from a page that is wider than it is tall", async () => {
    client.fetchRemoteTemplate.mockResolvedValue({ ...REMOTE, page_w_mm: 297, page_h_mm: 210 });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_templates") return [];
      if (cmd === "create_template") return { id: 13 };
      return null;
    });
    await downloadToLocal(REMOTE.id);
    expect(argOf("create_template") as any).toMatchObject({ req: { orientation: "landscape" } });
  });

  it("does not add the same template twice", async () => {
    client.fetchRemoteTemplate.mockResolvedValue(REMOTE);
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "list_templates" ? [{ id: 4, remote_id: REMOTE.id }] : null,
    );
    const result = await downloadToLocal(REMOTE.id);
    expect(result).toEqual({ id: 4, created: false });
    expect(calls("create_template")).toHaveLength(0);
  });
});

describe("listAvailableRemoteTemplates", () => {
  it("returns the account's own templates and its saved ones", async () => {
    client.fetchMyRemoteTemplates.mockResolvedValue([{ id: "m1" }]);
    client.fetchSavedRemoteTemplates.mockResolvedValue([{ id: "s1" }]);
    await expect(listAvailableRemoteTemplates()).resolves.toEqual({
      mine: [{ id: "m1" }],
      saved: [{ id: "s1" }],
    });
  });
});