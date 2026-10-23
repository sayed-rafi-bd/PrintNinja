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
    drafts: 0,
    lastPulledAt: null,
    lastError: null,
  } as {
    state: "synced" | "syncing" | "offline";
    drafts: number;
    lastPulledAt: string | null;
    lastError: string | null;
  },
  cacheNow: vi.fn(async () => {}),
}));

vi.mock("@/lib/shell/useShareStatus", () => ({
  useShareStatus: () => shellState.share,
}));

vi.mock("@/lib/sync/useSyncStatus", () => ({
  useSyncStatus: () => shellState.sync,
  cacheNow: (...args: unknown[]) =>
    (shellState.cacheNow as (...a: unknown[]) => Promise<void>)(...args),
}));

beforeEach(() => {
  shellState.share = { state: "online", handle: "rafi" };
  shellState.sync = {
    state: "synced",
    drafts: 0,
    lastPulledAt: null,
    lastError: null,
  };
  shellState.cacheNow.mockClear();
});

describe("SyncStatusCard", () => {
  it("shows connection, drafts, last refresh and a working Refresh cache", () => {
    shellState.sync = {
      state: "synced",
      drafts: 2,
      lastPulledAt: "2026-01-01T00:00:00.000Z",
      lastError: null,
    };
    render(<SyncStatusCard />);
    expect(screen.getByText("Cache status")).toBeInTheDocument();
    expect(screen.getByText("rafi")).toBeInTheDocument();
    expect(
      screen.getByText("2 draft(s) not saved to the server"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Last refreshed", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last refreshed 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Refresh cache/ }));
    expect(shellState.cacheNow).toHaveBeenCalledOnce();
  });

  it("renders the last error as plain text, no hover needed", () => {
    shellState.sync = {
      state: "offline",
      drafts: 1,
      lastPulledAt: null,
      lastError: "template is 600000 bytes, limit 524288",
    };
    render(<SyncStatusCard />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("template is 600000 bytes");
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("disables Refresh cache when signed out", () => {
    shellState.share = { state: "signed_out" };
    render(<SyncStatusCard />);
    expect(
      screen.getByRole("button", { name: /Refresh cache/ }),
    ).toBeDisabled();
    expect(
      screen.getByText("Sign in to the share service to refresh the cache."),
    ).toBeInTheDocument();
  });
});
