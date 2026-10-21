import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
const share = vi.hoisted(() => ({
  getServiceUrl: vi.fn(async () => null as string | null),
  getSessionToken: vi.fn(async () => null as string | null),
  hasUnpublishedChanges: (t: {
    remote_id: string | null;
    published_at: string | null;
    updated_at: string;
  }) => !!t.remote_id && !!t.published_at && t.updated_at > t.published_at,
  fetchRemoteTemplate: vi.fn(async (_id: string) => ({ id: _id })),
  saveRemoteTemplate: vi.fn(async () => {}),
  unsaveRemoteTemplate: vi.fn(async () => {}),
  RemoteTemplateNotFoundError: class extends Error {},
  ServerUnreachableError: class extends Error {},
}));
vi.mock("@/lib/share/client", () => share);
const sync = vi.hoisted(() => ({
  saveToServer: vi.fn(async () => ({
    remoteId: "new-uuid",
    updatedAt: "2026-03-01T00:00:00Z",
    published: false,
  })),
  refreshFromServer: vi.fn(async (t: { name: string }) => ({
    template: {
      id: "r2",
      body: "<p>new</p>",
      css: ".a{}",
      readme: "",
      published_at: "2026-03-01 00:00:00",
      updated_at: "2026-03-01 00:00:00",
    },
    name: t.name,
    page_w_mm: 80,
    page_h_mm: 200,
  })),
  downloadToLocal: vi.fn(async () => ({ id: 9, created: true })),
  listAvailableRemoteTemplates: vi.fn(async () => ({ mine: [], saved: [] })),
}));
vi.mock("@/lib/share/sync", () => sync);

import { TemplatesPage } from "@/pages/Templates";
import { usePrintStore } from "@/lib/store/printStore";

const base = {
  readme: "",
  summary: "",
  remote_id: null,
  published_at: null,
  origin: "own",
  origin_owner: null,
  withdrawn: false,
  updated_at: "2026-02-01T00:00:00Z",
  page_w_mm: 100,
  page_h_mm: 150,
};
const LIST = [
  { ...base, id: 1, name: "Shipping label" },
  {
    ...base,
    id: 2,
    name: "Receipt",
    remote_id: "r2",
    published_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    ...base,
    id: 3,
    name: "Pallet tag",
    remote_id: "r3",
    published_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
  },
  {
    ...base,
    id: 4,
    name: "Saved A",
    origin: "saved",
    origin_owner: "ana",
    remote_id: "x1",
  },
  {
    ...base,
    id: 5,
    name: "Saved B",
    origin: "saved",
    origin_owner: "bo",
    remote_id: "x2",
    withdrawn: true,
  },
];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/templates"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TemplatesPage />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  invoke.mockReset();
  share.getServiceUrl.mockResolvedValue(null);
  share.fetchRemoteTemplate.mockResolvedValue({ id: "x1" } as any);
  share.saveRemoteTemplate.mockResolvedValue(undefined);
  share.unsaveRemoteTemplate.mockResolvedValue(undefined);
  sync.saveToServer.mockResolvedValue({
    remoteId: "new-uuid",
    updatedAt: "2026-03-01T00:00:00Z",
    published: false,
  });
  sync.refreshFromServer.mockResolvedValue({
    template: {
      id: "r2",
      body: "<p>new</p>",
      css: ".a{}",
      readme: "",
      published_at: "2026-03-01 00:00:00",
      updated_at: "2026-03-01 00:00:00",
    },
    name: "Receipt",
    page_w_mm: 80,
    page_h_mm: 200,
  } as any);
  sync.downloadToLocal.mockResolvedValue({ id: 9, created: true });
  sync.listAvailableRemoteTemplates.mockResolvedValue({ mine: [], saved: [] });
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_templates") return LIST;
    if (cmd === "cache_list_conflicted") return [];
    return null;
  });
});

describe("Templates page", () => {
  it("opens on Mine with counts and one status per template", async () => {
    renderPage();
    expect(await screen.findByText("Shipping label")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mine (3)" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Saved (2)" })).toBeInTheDocument();
    expect(screen.getByText("Not on the server")).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByText("Changes not saved")).toBeInTheDocument();
  });

  it("Print selects the template and goes to the Print page", async () => {
    renderPage();
    await screen.findByText("Shipping label");
    const row = screen.getByText("Shipping label").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Print/ }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/print"),
    );
    expect(usePrintStore.getState().templateId).toBe("1");
  });

  it("Edit opens the template in Designer without a page reload", async () => {
    renderPage();
    await screen.findByText("Receipt");
    const row = screen.getByText("Receipt").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Edit/ }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/template/2"),
    );
  });

  it("Save pushes the local copy to the server", async () => {
    renderPage();
    await screen.findByText("Shipping label");
    fireEvent.click(
      screen.getByRole("button", { name: "Save Shipping label to the server" }),
    );
    await waitFor(() =>
      expect(sync.saveToServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
      ),
    );
  });

  it("Refresh asks first, then pulls the server copy over the local one", async () => {
    renderPage();
    await screen.findByText("Receipt");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh Receipt from the server" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Refresh “Receipt” from the server?"),
    ).toBeInTheDocument();
    expect(sync.refreshFromServer).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Refresh template" }),
    );
    await waitFor(() =>
      expect(sync.refreshFromServer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2 }),
      ),
    );
  });

  it("keeps the local copy when Refresh fails", async () => {
    sync.refreshFromServer.mockRejectedValueOnce(
      new Error("Cannot reach the server"),
    );
    renderPage();
    await screen.findByText("Receipt");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh Receipt from the server" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Refresh template" }),
    );
    await waitFor(() => expect(sync.refreshFromServer).toHaveBeenCalled());
    // Nothing local is written on the way out, so the copy still prints.
    const row = screen.getByText("Receipt").closest("tr")!;
    expect(
      within(row).getByRole("button", { name: /Print/ }),
    ).toBeInTheDocument();
  });

  it("keeps saved copies read-only: no Edit, no Save, but Refresh and Print", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Saved/ }));
    const row = (await screen.findByText("Saved A")).closest("tr")!;
    expect(
      within(row).queryByRole("button", { name: /Edit/ }),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: /^Save/ }),
    ).not.toBeInTheDocument();
    expect(
      within(row).getByRole("button", {
        name: "Refresh Saved A from the server",
      }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: /Print/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Withdrawn by author")).toBeInTheDocument();
  });

  it("marks a saved copy withdrawn when the server says it is gone", async () => {
    share.fetchRemoteTemplate.mockImplementation(async (id: string) => {
      if (id === "x1") throw new share.RemoteTemplateNotFoundError("x1");
      return { id } as any;
    });
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Saved/ }));
    const table = await screen.findByRole("table", { name: "Saved templates" });
    await waitFor(() => {
      const row = within(table).getByText("Saved A").closest("tr")!;
      expect(within(row).getByText("Withdrawn by author")).toBeInTheDocument();
    });
  });

  it("queues a use count when printing a saved copy, without touching the network", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Saved/ }));
    const row = (await screen.findByText("Saved A")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Print/ }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/print"),
    );
    expect(invoke).toHaveBeenCalledWith("cache_queue_use", {
      server_id: "x1",
      delta: 1,
    });
  });

  it("does not call a saved copy withdrawn when the server cannot be reached", async () => {
    share.fetchRemoteTemplate.mockRejectedValue(
      new share.ServerUnreachableError("http://srv"),
    );
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Saved/ }));
    const table = await screen.findByRole("table", { name: "Saved templates" });
    await waitFor(() =>
      expect(share.fetchRemoteTemplate).toHaveBeenCalledWith("x1"),
    );
    const row = within(table).getByText("Saved A").closest("tr")!;
    expect(
      within(row).queryByText("Withdrawn by author"),
    ).not.toBeInTheDocument();
  });

  it("asks before removing a saved template, naming it", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Saved/ }));
    const row = (await screen.findByText("Saved A")).closest("tr")!;
    expect(
      within(screen.getByRole("table", { name: "Saved templates" })).getByText(
        "Withdrawn by author",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Remove “Saved A” from Saved?"),
    ).toBeInTheDocument();
    expect(
      invoke.mock.calls.some((c) => c[0] === "cache_forget_template"),
    ).toBe(false);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove template" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("cache_forget_template", {
        server_id: "x1",
      }),
    );
  });

  it("keeps the saved copy when unsaving cannot reach the server", async () => {
    share.unsaveRemoteTemplate.mockRejectedValueOnce(new Error("offline"));
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Saved/ }));
    const row = (await screen.findByText("Saved A")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove template" }),
    );
    // The row stays listed and nothing is forgotten: the next pull (which
    // still lists it as saved) would resurrect a local-only delete.
    await waitFor(() =>
      expect(screen.getByText("Saved A")).toBeInTheDocument(),
    );
    expect(
      invoke.mock.calls.some((c) => c[0] === "cache_forget_template"),
    ).toBe(false);
  });

  it("Get from server lists the account's templates and adds the chosen one", async () => {
    sync.listAvailableRemoteTemplates.mockResolvedValue({
      mine: [
        {
          id: "m1",
          owner_id: "u1",
          owner_handle: "ana",
          name: "Invoice",
          summary: "A4",
          page_w_mm: 210,
          page_h_mm: 297,
          language: "html",
          use_count: 0,
          published_at: "2026-03-01 00:00:00",
          updated_at: "2026-03-01 00:00:00",
        },
      ],
      saved: [
        {
          id: "s1",
          owner_id: "u2",
          owner_handle: "bo",
          name: "Community label",
          summary: "",
          page_w_mm: 80,
          page_h_mm: 200,
          language: "html",
          use_count: 2,
          published_at: "2026-03-01 00:00:00",
          updated_at: "2026-03-01 00:00:00",
        },
      ],
    } as any);
    renderPage();
    await screen.findByText("Shipping label");
    fireEvent.click(screen.getByRole("button", { name: /Get from server/ }));
    expect(await screen.findByText("Invoice")).toBeInTheDocument();
    expect(screen.getByText("Community label")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select row m1" }));
    fireEvent.click(screen.getByRole("button", { name: /Add 1 to this PC/ }));

    await waitFor(() =>
      expect(sync.downloadToLocal).toHaveBeenCalledWith("m1", "own", "ana"),
    );
  });

  it("says the server cannot be reached in Get from server", async () => {
    sync.listAvailableRemoteTemplates.mockRejectedValueOnce(
      new Error("Cannot reach the server at http://srv"),
    );
    renderPage();
    await screen.findByText("Shipping label");
    fireEvent.click(screen.getByRole("button", { name: /Get from server/ }));
    expect(
      await screen.findByText("Can’t reach the server"),
    ).toBeInTheDocument();
  });

  it("explains when no share service is configured", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Community" }));
    expect(
      await screen.findByText("Share service not set up"),
    ).toBeInTheDocument();
  });
});
describe("conflict banner and dialog", () => {
  const CONFLICT = [{ id: 2, server_id: "r2", name: "Receipt" }];
  const REMOTE = {
    id: "r2",
    owner_id: "u9",
    owner_handle: "bo",
    name: "Receipt",
    summary: "",
    page_w_mm: 100,
    page_h_mm: 150,
    language: "html",
    body: "<p>server</p>",
    css: ".s{}",
    readme: "",
    use_count: 0,
    revision: 5,
    version_count: 3,
    published_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
  };

  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_templates") return LIST;
      if (cmd === "cache_list_conflicted") return CONFLICT;
      if (cmd === "list_versions")
        return [{ html: "<p>local</p>", css: ".l{}" }];
      return null;
    });
    share.fetchRemoteTemplate.mockResolvedValue(REMOTE as never);
  });

  it("shows a banner and opens the three-way dialog", async () => {
    renderPage();
    expect(await screen.findByTestId("conflict-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByTestId("conflict-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-keep-mine")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-take-server")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-keep-both")).toBeInTheDocument();
  });

  it("Keep mine rebases onto the server revision and reloads", async () => {
    share.fetchRemoteTemplate.mockResolvedValue(REMOTE as never);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_templates") return LIST;
      if (cmd === "cache_list_conflicted")
        return invoke.mock.calls.some((c) => c[0] === "cache_resolve_conflict")
          ? []
          : CONFLICT;
      return null;
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByTestId("conflict-keep-mine"));
    await waitFor(() =>
      expect(share.fetchRemoteTemplate).toHaveBeenCalledWith("r2"),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("cache_resolve_conflict", {
        server_id: "r2",
        resolution: "mine",
        rebase_to: 5,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("conflict-banner")).not.toBeInTheDocument(),
    );
  });

  it("Take server applies the server copy", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByTestId("conflict-take-server"));
    await waitFor(() =>
      expect(share.fetchRemoteTemplate).toHaveBeenCalledWith("r2"),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "cache_resolve_conflict",
        expect.objectContaining({
          server_id: "r2",
          resolution: "theirs",
          server_copy: expect.objectContaining({
            id: "r2",
            body: "<p>server</p>",
            revision: 5,
          }),
        }),
      ),
    );
  });

  it("Keep both copies the local content to a new template, then takes the server", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_templates") return LIST;
      if (cmd === "cache_list_conflicted") return CONFLICT;
      if (cmd === "get_template")
        return {
          name: "Receipt",
          page_w_mm: 100,
          page_h_mm: 150,
          orientation: "portrait",
          readme: "",
          summary: "",
        };
      if (cmd === "list_versions")
        return [{ html: "<p>local</p>", css: ".l{}" }];
      return null;
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByTestId("conflict-keep-both"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "create_template",
        expect.objectContaining({
          req: expect.objectContaining({ name: "Receipt (copy)" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "cache_resolve_conflict",
        expect.objectContaining({ server_id: "r2", resolution: "theirs" }),
      ),
    );
  });
});
