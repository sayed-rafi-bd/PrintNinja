import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

const client = vi.hoisted(() => {
  class NotFound extends Error {
    constructor(id: string) {
      super(`Template ${id} not found`);
      this.name = "RemoteTemplateNotFoundError";
    }
  }
  return {
    putRemoteTemplate: vi.fn(),
    publishRemoteTemplate: vi.fn(),
    unpublishRemoteTemplate: vi.fn(),
    unpublishTemplate: vi.fn(),
    fetchRemoteTemplate: vi.fn(),
    RemoteTemplateNotFoundError: NotFound,
  };
});
vi.mock("@/lib/share/client", () => client);

import { ApiError } from "@/lib/api/errors";

import {
  createTemplateOnServer,
  deleteTemplateEverywhere,
  overwriteWithMine,
  saveTemplateToServer,
  takeServerCopy,
  TemplateConflictError,
} from "@/lib/share/save";
import type { TemplateRow } from "@/lib/agent/types";

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
  revision: 1,
  version_count: 1,
  published_at: null as string | null,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-02T00:00:00Z",
};

const local = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: 7,
  name: "Invoice",
  summary: "A4 invoice",
  page_w_mm: 210,
  page_h_mm: 297,
  html: "<p>local</p>",
  css: ".local {}",
  compiled_css: "",
  compiled_key: "",
  orientation: "portrait",
  created_at: "2026-03-01T00:00:00Z",
  readme: "# Invoice",
  withdrawn: false,
  remote_id: null,
  server_id: "11111111-1111-4111-8111-111111111111",
  base_revision: 4,
  sync_state: "dirty",
  published_at: null,
  origin: "own",
  origin_owner: null,
  updated_at: "2026-03-01T00:00:00Z",
  ...over,
});

const CONTENT = {
  name: "Invoice",
  summary: "A4 invoice",
  page_w_mm: 210,
  page_h_mm: 297,
  html: "<p>local</p>",
  css: ".local {}",
  readme: "# Invoice",
};

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
  invoke.mockReset();
  client.putRemoteTemplate.mockReset();
  client.publishRemoteTemplate.mockReset();
  client.unpublishRemoteTemplate.mockReset();
  client.unpublishTemplate.mockReset();
  client.fetchRemoteTemplate.mockReset();
  invoke.mockImplementation(async () => null);
});

describe("saveTemplateToServer", () => {
  it("creates private with the editor content and caches the accepted copy", async () => {
    client.putRemoteTemplate.mockResolvedValue({
      ...REMOTE,
      published_at: null,
    });
    const result = await saveTemplateToServer(
      local({ server_id: null, base_revision: null }),
      CONTENT,
    );

    const payload = client.putRemoteTemplate.mock.calls[0][0];
    expect(typeof payload.id).toBe("string"); // fresh identity for a never-saved row
    expect(payload.body).toBe("<p>local</p>");
    expect(payload.css).toBe(".local {}"); // CSS must not be left behind
    expect(payload.readme).toBe("# Invoice");
    expect(payload.if_revision).toBeUndefined(); // creates need none
    expect(client.publishRemoteTemplate).not.toHaveBeenCalled();
    expect(client.unpublishRemoteTemplate).not.toHaveBeenCalled();
    expect(result.remoteId).toBe(REMOTE.id);
    expect(result.published).toBe(false);
    expect(invoke).toHaveBeenCalledWith("cache_mark_pushed", {
      server_id: REMOTE.id,
      revision: REMOTE.revision,
    });
    expect(invoke).toHaveBeenCalledWith("set_publish_info", {
      req: { id: 7, remote_id: REMOTE.id, published_at: null },
    });
  });

  it("guards the update with the row's own revision and leaves visibility alone when unasked", async () => {
    client.putRemoteTemplate.mockResolvedValue({
      ...REMOTE,
      published_at: null,
      revision: 5,
    });
    const result = await saveTemplateToServer(
      local({ remote_id: null }),
      CONTENT,
    );

    // No fetch first: the row already knows the revision it was synced at.
    expect(client.fetchRemoteTemplate).not.toHaveBeenCalled();
    expect(client.putRemoteTemplate.mock.calls[0][0]).toMatchObject({
      if_revision: 4,
    });
    expect(client.publishRemoteTemplate).not.toHaveBeenCalled();
    expect(client.unpublishRemoteTemplate).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("cache_mark_pushed", {
      server_id: REMOTE.id,
      revision: 5,
    });
    expect(result.published).toBe(false);
    expect(result.remoteId).toBe(REMOTE.id);
  });

  it("retries a raced create as an update instead of failing", async () => {
    client.fetchRemoteTemplate.mockResolvedValue({ ...REMOTE, revision: 1 });
    client.putRemoteTemplate
      .mockRejectedValueOnce(
        new ApiError({
          code: "revision_required",
          message: "Update needs if_revision",
          requestId: "r",
          status: 428,
        }),
      )
      .mockResolvedValue({ ...REMOTE, published_at: null, revision: 2 });
    const result = await saveTemplateToServer(
      local({ server_id: null, base_revision: null }),
      { ...CONTENT },
    );
    expect(client.putRemoteTemplate.mock.calls[0][0]).not.toHaveProperty(
      "if_revision",
    );
    expect(client.putRemoteTemplate.mock.calls[1][0]).toMatchObject({
      if_revision: 1,
    });
    expect(result.published).toBe(false);
  });

  it("creates when the guard names a server copy that never existed", async () => {
    // A seeded row can carry a fictional base for an id the server
    // never saw: 428, then 404 on the fetch, then a guard-less create.
    client.putRemoteTemplate
      .mockRejectedValueOnce(
        new ApiError({
          code: "revision_required",
          message: "Update needs if_revision",
          requestId: "r",
          status: 428,
        }),
      )
      .mockResolvedValue({ ...REMOTE, published_at: null, revision: 1 });
    client.fetchRemoteTemplate.mockRejectedValue(
      new client.RemoteTemplateNotFoundError("ghost"),
    );
    const result = await saveTemplateToServer(
      local({ server_id: REMOTE.id, base_revision: 7 }),
      CONTENT,
    );
    expect(client.putRemoteTemplate.mock.calls[0][0]).toMatchObject({
      if_revision: 7,
    });
    expect(client.putRemoteTemplate.mock.calls[1][0]).not.toHaveProperty(
      "if_revision",
    );
    expect(result.revision).toBe(1);
  });

  it("reports a concurrent edit as a conflict instead of overwriting it", async () => {
    client.putRemoteTemplate.mockRejectedValue(
      new ApiError({
        code: "revision_conflict",
        message: "Stale revision",
        requestId: "r1",
        status: 409,
      }),
    );
    const err = await saveTemplateToServer(
      local({ remote_id: REMOTE.id }),
      CONTENT,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TemplateConflictError);
    expect((err as TemplateConflictError).serverId).toBe(REMOTE.id);
    expect(calls("set_publish_info")).toHaveLength(0);
    expect(calls("cache_mark_pushed")).toHaveLength(0);
  });
});

describe("takeServerCopy", () => {
  const PUBLISHED = { ...REMOTE, published_at: "2026-03-01T00:00:00Z" };

  it("overwrites the local copy with the server one and marks it synced", async () => {
    client.fetchRemoteTemplate.mockResolvedValue(PUBLISHED);
    const result = await takeServerCopy(local({ remote_id: REMOTE.id }));

    expect(calls("update_template_meta")[0][1]).toMatchObject({
      req: expect.objectContaining({
        id: 7,
        name: "Invoice",
        html: REMOTE.body,
        css: REMOTE.css,
      }),
    });
    expect(calls("update_readme")[0][1]).toEqual({
      req: { id: 7, readme: REMOTE.readme },
    });
    expect(calls("update_template_meta")[0][1]).toMatchObject({
      req: expect.objectContaining({
        id: 7,
        name: "Invoice",
        page_w_mm: 210,
        page_h_mm: 297,
        html: REMOTE.body,
        css: REMOTE.css,
      }),
    });
    expect(calls("cache_mark_pushed")[0][1]).toEqual({
      server_id: REMOTE.id,
      revision: REMOTE.revision,
    });
    expect(result.page_w_mm).toBe(210);
    expect(invoke).toHaveBeenCalledWith("set_publish_info", {
      req: { id: 7, remote_id: REMOTE.id, published_at: REMOTE.updated_at },
    });
  });

  it("leaves a template that is private on the server private here too", async () => {
    client.fetchRemoteTemplate.mockResolvedValue({
      ...REMOTE,
      published_at: "",
    });
    await takeServerCopy(local({ remote_id: REMOTE.id, published_at: null }));
    expect(calls("set_publish_info")[0][1]).toEqual({
      req: { id: 7, remote_id: REMOTE.id, published_at: null },
    });
  });

  it("writes nothing when the server copy cannot be fetched", async () => {
    client.fetchRemoteTemplate.mockRejectedValue(
      new Error("Template not found"),
    );
    await expect(
      takeServerCopy(local({ remote_id: REMOTE.id })),
    ).rejects.toThrow("Template not found");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a template that was never saved", async () => {
    await expect(takeServerCopy(local({ server_id: null }))).rejects.toThrow(
      /not on the server/,
    );
    expect(client.fetchRemoteTemplate).not.toHaveBeenCalled();
  });
});

describe("overwriteWithMine", () => {
  it("rebases onto the server revision so the overwrite is explicit", async () => {
    client.fetchRemoteTemplate.mockResolvedValue({ ...REMOTE, revision: 9 });
    client.putRemoteTemplate.mockResolvedValue({
      ...REMOTE,
      revision: 10,
    });
    const result = await overwriteWithMine(
      local({ remote_id: REMOTE.id }),
      CONTENT,
    );
    expect(client.putRemoteTemplate.mock.calls[0][0]).toMatchObject({
      if_revision: 9,
    });
    expect(result.revision).toBe(10);
  });

  it("refuses a template that was never saved", async () => {
    await expect(
      overwriteWithMine(local({ server_id: null, remote_id: null }), CONTENT),
    ).rejects.toThrow(/not on the server/);
  });
});

describe("createTemplateOnServer", () => {
  it("PUTs the starter copy, then caches the row synced at that revision", async () => {
    client.putRemoteTemplate.mockResolvedValue({ ...REMOTE, revision: 1 });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "create_template") return { id: 12 };
      return null;
    });
    const created = await createTemplateOnServer({
      name: "Label",
      page_w_mm: 80,
      page_h_mm: 200,
      orientation: "portrait",
      html: "<p>x</p>",
      css: "",
    });
    expect(client.putRemoteTemplate.mock.calls[0][0]).toMatchObject({
      name: "Label",
      body: "<p>x</p>",
    });
    expect(typeof client.putRemoteTemplate.mock.calls[0][0].id).toBe("string");
    expect(calls("create_template")[0][1]).toMatchObject({
      req: {
        name: "Invoice",
        server_id: REMOTE.id,
        sync_state: "synced",
        server_revision: 1,
        base_revision: 1,
      },
    });
    expect(created).toEqual({ id: 12 });
  });
});

describe("deleteTemplateEverywhere", () => {
  it("deletes the server copy first, then forgets the local row", async () => {
    await deleteTemplateEverywhere(
      local({ server_id: REMOTE.id, remote_id: REMOTE.id }),
    );
    expect(client.unpublishTemplate).toHaveBeenCalledWith(REMOTE.id);
    expect(invoke).toHaveBeenCalledWith("cache_forget_template", {
      server_id: REMOTE.id,
    });
  });

  it("removes a never-saved row locally without touching the server", async () => {
    await deleteTemplateEverywhere(local({ server_id: null, remote_id: null }));
    expect(client.unpublishTemplate).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("delete_template", { id: 7 });
  });
});
