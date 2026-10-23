import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/lib/i18n";
import { UpdateSettings } from "@/components/UpdateSettings";

vi.mock("@/lib/updater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/updater")>();
  return { ...actual, checkAndInstall: vi.fn(async () => null) };
});

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("UpdateSettings", () => {
  it("renders nothing in web mode", () => {
    const { container } = render(<UpdateSettings appVersion="2.2.0" />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the update row under Tauri", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      render(<UpdateSettings appVersion="2.2.0" />);
      expect(screen.getByTestId("settings-check-updates")).toBeInTheDocument();
      expect(screen.getByText("Current version: v2.2.0")).toBeInTheDocument();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});
