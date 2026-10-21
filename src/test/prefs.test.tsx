import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  DEFAULT_APP_NAME,
  MAX_APP_NAME_LENGTH,
  MAX_LOGO_BYTES,
  checkLogoFile,
  isValidLogoDataUrl,
  parseDensity,
  sanitizeAppName,
} from "@/lib/prefs/prefs";
import { PrefsProvider, usePrefs } from "@/lib/prefs/PrefsProvider";

describe("prefs helpers", () => {
  it("defaults to comfortable density", () => {
    expect(parseDensity(null)).toBe("comfortable");
    expect(parseDensity("nonsense")).toBe("comfortable");
    expect(parseDensity("compact")).toBe("compact");
  });
  it("sanitizes the app name", () => {
    expect(sanitizeAppName("  Acme   Print  ")).toBe("Acme Print");
    expect(sanitizeAppName("")).toBe(DEFAULT_APP_NAME);
    expect(sanitizeAppName("   ")).toBe(DEFAULT_APP_NAME);
    expect(sanitizeAppName("x".repeat(100))).toHaveLength(MAX_APP_NAME_LENGTH);
  });
  it("accepts only image data URLs", () => {
    expect(isValidLogoDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(
      isValidLogoDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="),
    ).toBe(true);
    expect(isValidLogoDataUrl("https://example.com/logo.png")).toBe(false);
    expect(isValidLogoDataUrl("data:text/html;base64,PGI+")).toBe(false);
    expect(isValidLogoDataUrl("javascript:alert(1)")).toBe(false);
    expect(isValidLogoDataUrl(null)).toBe(false);
  });
  it("checks logo type and size", () => {
    expect(checkLogoFile({ type: "image/png", size: 1000 }).ok).toBe(true);
    expect(checkLogoFile({ type: "application/pdf", size: 1000 }).ok).toBe(
      false,
    );
    expect(
      checkLogoFile({ type: "image/png", size: MAX_LOGO_BYTES + 1 }).ok,
    ).toBe(false);
  });
});

function Probe() {
  const p = usePrefs();
  return (
    <div>
      <span data-testid="d">{p.density}</span>
      <span data-testid="n">{p.appName}</span>
      <button onClick={() => p.setDensity("compact")}>compact</button>
      <button onClick={() => p.setAppName("Acme Print")}>rename</button>
    </div>
  );
}

describe("PrefsProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.density;
    document.title = "";
  });

  it("applies density to <html> and persists it", async () => {
    render(
      <PrefsProvider>
        <Probe />
      </PrefsProvider>,
    );
    expect(document.documentElement.dataset.density).toBe("comfortable");
    fireEvent.click(screen.getByText("compact"));
    await waitFor(() =>
      expect(document.documentElement.dataset.density).toBe("compact"),
    );
    expect(localStorage.getItem("printninja-setting:ui_density")).toBe(
      "compact",
    );
  });

  it("applies the app name to the document title and persists it", async () => {
    render(
      <PrefsProvider>
        <Probe />
      </PrefsProvider>,
    );
    expect(document.title).toBe(DEFAULT_APP_NAME);
    fireEvent.click(screen.getByText("rename"));
    await waitFor(() => expect(document.title).toBe("Acme Print"));
    expect(localStorage.getItem("printninja-setting:brand_name")).toBe(
      "Acme Print",
    );
  });

  it("restores stored preferences on start", async () => {
    localStorage.setItem("printninja-setting:ui_density", "compact");
    localStorage.setItem("printninja-setting:brand_name", "Warehouse 4");
    render(
      <PrefsProvider>
        <Probe />
      </PrefsProvider>,
    );
    expect(screen.getByTestId("d")).toHaveTextContent("compact");
    expect(screen.getByTestId("n")).toHaveTextContent("Warehouse 4");
  });
});
