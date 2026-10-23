import { describe, it, expect, vi } from "vitest";
import "@/lib/i18n";
import { checkAndInstall, isUpdaterSupported } from "@/lib/updater";

describe("checkAndInstall", () => {
  it("returns null when already up to date (no download, no relaunch)", async () => {
    const relaunchFn = vi.fn();
    const result = await checkAndInstall(undefined, {
      checkFn: async () => null,
      relaunchFn,
    });
    expect(result).toBeNull();
    expect(relaunchFn).not.toHaveBeenCalled();
  });

  it("downloads, installs and relaunches on a new version", async () => {
    const events = [
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 40 } },
      { event: "Progress", data: { chunkLength: 60 } },
      { event: "Finished", data: {} },
    ];
    const downloadAndInstall = vi.fn(async (onEvent?: (e: never) => void) => {
      for (const e of events) onEvent?.(e as never);
    });
    const relaunchFn = vi.fn();
    const seen: Array<{ downloaded: number; total: number | undefined }> = [];
    const result = await checkAndInstall((p) => seen.push(p), {
      checkFn: async () => ({ version: "2.3.0", downloadAndInstall }),
      relaunchFn,
    });
    expect(result).toBe("2.3.0");
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunchFn).toHaveBeenCalledOnce();
    expect(seen.at(-1)).toEqual({ downloaded: 100, total: 100 });
  });

  it("propagates check failures to the caller", async () => {
    await expect(
      checkAndInstall(undefined, {
        checkFn: async () => {
          throw new Error("offline");
        },
        relaunchFn: vi.fn(),
      }),
    ).rejects.toThrow("offline");
  });
});

describe("isUpdaterSupported", () => {
  it("is false in web mode, true under Tauri", () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(isUpdaterSupported()).toBe(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      expect(isUpdaterSupported()).toBe(true);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});
