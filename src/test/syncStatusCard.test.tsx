import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@/lib/i18n";
import { SyncStatusCard } from "@/components/SyncStatusCard";

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

describe("SyncStatusCard", () => {
  it("shows connection, queue, last sync and a working Sync now", () => {
    shellState.sync = {
      state: "pending",
      pending: 2,
      conflicts: 0,
      lastPullAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
    };
    render(<SyncStatusCard />);
    expect(screen.getByText("Sync status")).toBeInTheDocument();
    expect(screen.getByText("rafi")).toBeInTheDocument();
    expect(screen.getByText("2 change(s) waiting to send")).toBeInTheDocument();
    expect(
      screen.getByText("Last synced", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last synced 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    expect(shellState.syncNow).toHaveBeenCalledOnce();
  });

  it("renders the last error as plain text, no hover needed", () => {
    shellState.sync = {
      state: "offline",
      pending: 1,
      conflicts: 0,
      lastPullAt: null,
      lastError: "template is 600000 bytes, limit 524288",
    };
    render(<SyncStatusCard />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("template is 600000 bytes");
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("disables Sync now when signed out", () => {
    shellState.share = { state: "signed_out" };
    render(<SyncStatusCard />);
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeDisabled();
    expect(
      screen.getByText("Sign in to the share service to sync."),
    ).toBeInTheDocument();
  });
});
