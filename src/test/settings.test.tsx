import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/lib/share/client", () => ({
  getServiceUrl: async () => null, getSessionToken: async () => null, setServiceUrl: async () => {},
  register: async () => ({}), login: async () => ({}), logout: async () => {},
}));

import { SettingsPage } from "@/pages/Settings";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue(null); localStorage.clear(); });
const renderPage = () => render(<MemoryRouter><SettingsPage /></MemoryRouter>);
const open = (name: string) => { fireEvent.mouseDown(screen.getByRole("tab", { name })); };

describe("Settings page", () => {
  it("lists sections in a vertical navigation", () => {
    renderPage();
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    expect(list).toHaveAttribute("aria-orientation", "vertical");
    for (const n of ["General", "Share", "API and automation", "Data sources", "Retention", "Diagnostics"]) {
      expect(within(list).getByRole("tab", { name: n })).toBeInTheDocument();
    }
  });

  it("has no theme control (single light theme)", () => {
    renderPage();
    expect(screen.queryByText(/^Theme$/)).toBeNull();
  });

  it("rejects an invalid retention value inline and does not save it", async () => {
    renderPage();
    open("Retention");
    const input = await screen.findByLabelText("Keep history for (days)");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toHaveTextContent("whole number of at least 1");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(invoke.mock.calls.some((c) => c[0] === "set_setting" && c[1]?.key === "retention_days")).toBe(false);
  });

  it("saves a valid retention value", async () => {
    renderPage();
    open("Retention");
    const input = await screen.findByLabelText("Keep history for (days)");
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.blur(input);
    await waitFor(() => expect(localStorage.getItem("printninja-setting:retention_days")).toBe("90"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps API and deep-link settings together under one section", async () => {
    renderPage();
    open("API and automation");
    expect(await screen.findByText("Local REST API")).toBeInTheDocument();
    expect(screen.getByText("Trusted Sources")).toBeInTheDocument();
  });

  it("offers diagnostics export in its own section", async () => {
    renderPage();
    open("Diagnostics");
    expect(await screen.findByRole("button", { name: /Export Diagnostics/ })).toBeInTheDocument();
  });
});
