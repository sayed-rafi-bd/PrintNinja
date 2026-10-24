import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import {
  getAppVersion,
  isNewer,
  normalizeVersion,
  useUpdateCheck,
} from "@/lib/appUpdate";
import { UpdateBadge } from "@/components/UpdateBadge";

const getVersionMock = vi.fn();
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: (...args: unknown[]) => getVersionMock(...args),
}));

const openUrlMock = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

function probe() {
  const Probe = () => {
    const u = useUpdateCheck();
    return (
      <p data-testid="probe">
        {u.available ? `${u.version} ${u.url}` : "none"}
      </p>
    );
  };
  return render(<Probe />);
}

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  getVersionMock.mockReset().mockResolvedValue("3.1.0");
  openUrlMock.mockReset().mockResolvedValue(undefined);
  // No real network in unit tests: per-file fetch behavior below.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
});

describe("version compare", () => {
  it("strips a leading v and compares dotted parts numerically", () => {
    expect(normalizeVersion("v3.2.0")).toBe("3.2.0");
    expect(isNewer("3.2.0", "3.1.0")).toBe(true);
    expect(isNewer("v3.2.0", "v3.1.9")).toBe(true);
    expect(isNewer("3.10.0", "3.9.9")).toBe(true);
    expect(isNewer("4.0.0", "3.99.99")).toBe(true);
    expect(isNewer("3.1.0", "3.1.0")).toBe(false);
    expect(isNewer("3.0.9", "3.1.0")).toBe(false);
    expect(isNewer("3.1", "3.1.0")).toBe(false);
  });
});

describe("getAppVersion", () => {
  it("prefers the Tauri bundle version", async () => {
    getVersionMock.mockResolvedValue("v9.9.9");
    await expect(getAppVersion()).resolves.toBe("9.9.9");
  });

  it("falls back to the baked package version in web mode", async () => {
    getVersionMock.mockRejectedValue(new Error("no tauri"));
    // The baked version tracks package.json (see vite.config.ts), so compare
    // against it instead of a literal that breaks on every version bump.
    await expect(getAppVersion()).resolves.toBe(
      normalizeVersion(__APP_VERSION__),
    );
  });
});

describe("useUpdateCheck", () => {
  const release = (tag: string) => ({
    ok: true,
    json: async () => ({
      tag_name: tag,
      html_url: `https://github.com/o/r/releases/tag/${tag}`,
    }),
  });

  it("shows a newer release once fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => release("v9.9.9") as Response),
    );
    probe();
    expect(await screen.findByTestId("probe")).toHaveTextContent(
      "9.9.9 https://github.com/o/r/releases/tag/v9.9.9",
    );
    expect(
      JSON.parse(localStorage.getItem("printninja-update-check")!),
    ).toMatchObject({ version: "9.9.9" });
  });

  it("stays quiet when up to date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => release("v3.1.0") as Response),
    );
    probe();
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("none"),
    );
    expect(localStorage.getItem("printninja-update-check")).toBeNull();
  });

  it("stays quiet when the network fails", async () => {
    probe();
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("none"),
    );
  });

  it("paints from a fresh cache immediately", () => {
    localStorage.setItem(
      "printninja-update-check",
      JSON.stringify({
        version: "9.9.9",
        url: "https://github.com/o/r/releases/tag/v9.9.9",
        checkedAt: Date.now(),
      }),
    );
    probe();
    expect(screen.getByTestId("probe")).toHaveTextContent("9.9.9");
  });

  it("hides a stale badge when the app itself was updated", async () => {
    localStorage.setItem(
      "printninja-update-check",
      JSON.stringify({
        version: "9.9.9",
        url: "https://github.com/o/r/releases/tag/v9.9.9",
        checkedAt: Date.now(),
      }),
    );
    getVersionMock.mockResolvedValue("9.9.9");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => release("v9.9.9") as Response),
    );
    probe();
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("none"),
    );
  });
});

describe("UpdateBadge", () => {
  it("links a newer release to its page and follows the anchor in web mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              tag_name: "v9.9.9",
              html_url: "https://github.com/o/r/releases/tag/v9.9.9",
            }),
          }) as Response,
      ),
    );
    render(<UpdateBadge />);
    const link = await screen.findByRole("link", {
      name: "Update to v9.9.9 (opens the release page)",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/o/r/releases/tag/v9.9.9",
    );
    expect(link).toHaveAttribute("target", "_blank");
    fireEvent.click(link);
    // Web builds let the anchor open the tab natively: the click gesture
    // stays synchronous, so the popup blocker never trips. No opener call.
    await waitFor(() => expect(openUrlMock).not.toHaveBeenCalled());
  });

  it("opens the release through the opener plugin in the desktop app", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              tag_name: "v9.9.9",
              html_url: "https://github.com/o/r/releases/tag/v9.9.9",
            }),
          }) as Response,
      ),
    );
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    render(<UpdateBadge />);
    const link = await screen.findByRole("link", {
      name: "Update to v9.9.9 (opens the release page)",
    });
    fireEvent.click(link);
    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith(
        "https://github.com/o/r/releases/tag/v9.9.9",
      ),
    );
  });

  it("renders nothing when up to date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({
              tag_name: "v3.1.0",
              html_url: "https://github.com/o/r/releases/tag/v3.1.0",
            }),
          }) as Response,
      ),
    );
    render(<UpdateBadge />);
    await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
  });
});
