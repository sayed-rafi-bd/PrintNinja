import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";
import { Layout } from "@/components/Layout";

const shellState = vi.hoisted(() => ({
  share: { state: "online", handle: "rafi" } as
    | { state: "online"; handle: string }
    | { state: "offline" }
    | { state: "unconfigured" }
    | { state: "signed_out" },
  sync: {
    state: "synced",
    pending: 0,
    conflicts: 0,
    lastPullAt: null,
    lastError: null,
  } as {
    state: "synced" | "syncing" | "pending" | "offline" | "conflict";
    pending: number;
    conflicts: number;
    lastPullAt: string | null;
    lastError: string | null;
  },
  syncNow: vi.fn(async () => {}),
}));

vi.mock("@/lib/shell/useShareStatus", () => ({
  useShareStatus: () => shellState.share,
}));

vi.mock("@/lib/sync/useSyncStatus", () => ({
  useSyncStatus: () => shellState.sync,
  notifyLocalEdit: vi.fn(),
  syncNow: (...args: unknown[]) =>
    (shellState.syncNow as (...a: unknown[]) => Promise<void>)(...args),
}));

vi.mock("@/lib/sync/useAdoption", () => ({
  useAdoption: () => ({
    pending: false,
    rows: [],
    busy: false,
    error: "",
    confirm: vi.fn(),
    decline: vi.fn(),
  }),
}));

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/history"]}>
      <Layout>
        <h1>Page</h1>
      </Layout>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  shellState.share = { state: "online", handle: "rafi" };
  shellState.sync = {
    state: "synced",
    pending: 0,
    conflicts: 0,
    lastPullAt: null,
    lastError: null,
  };
  shellState.syncNow.mockClear();
});

describe("topbar share + sync", () => {
  it("always shows the online badge, next to the pending sync button", () => {
    shellState.sync = {
      state: "pending",
      pending: 1,
      conflicts: 0,
      lastPullAt: null,
      lastError: null,
    };
    renderShell();
    // Connection signal stays online…
    expect(
      screen.getByTitle("Share service connected as rafi"),
    ).toBeInTheDocument();
    // …and the queue gets its own control.
    const sync = screen.getByTestId("sync-chip");
    expect(sync).toHaveTextContent("1 change(s) waiting to send");
    expect(sync.tagName).toBe("BUTTON");
  });

  it("runs a full sync when the sync button is clicked", async () => {
    renderShell();
    fireEvent.click(screen.getByTestId("sync-chip"));
    expect(shellState.syncNow).toHaveBeenCalledOnce();
  });

  it("surfaces the last push error on the sync button", () => {
    shellState.sync = {
      state: "offline",
      pending: 1,
      conflicts: 0,
      lastPullAt: null,
      lastError: "template is 600000 bytes, limit 524288",
    };
    renderShell();
    // Still online at the share level…
    expect(
      screen.getByTitle("Share service connected as rafi"),
    ).toBeInTheDocument();
    // …but the button says why the queue is stuck.
    expect(screen.getByTestId("sync-chip")).toHaveAttribute(
      "title",
      expect.stringContaining("template is 600000 bytes"),
    );
  });

  it("links to Templates on conflict", () => {
    shellState.sync = {
      state: "conflict",
      pending: 0,
      conflicts: 1,
      lastPullAt: null,
      lastError: null,
    };
    renderShell();
    const sync = screen.getByTestId("sync-chip");
    expect(sync.tagName).toBe("A");
    expect(sync).toHaveAttribute("href", "/templates");
  });

  it("shows only the offline badge when the share is down", () => {
    shellState.share = { state: "offline" };
    renderShell();
    expect(screen.getByTitle("Share service unreachable")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-chip")).not.toBeInTheDocument();
  });
});
