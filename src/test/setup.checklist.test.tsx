import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axe from "axe-core";
import "@/lib/i18n";
import { buildChecklist, parseSection, summarize } from "@/lib/setup/checklist";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/lib/share/client", () => ({
  getServiceUrl: async () => null, getSessionToken: async () => null, setServiceUrl: async () => {},
  register: async () => ({}), login: async () => ({}), logout: async () => {},
}));

import { SettingsPage } from "@/pages/Settings";
import { Onboarding } from "@/components/Onboarding";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue(null); localStorage.clear(); delete (window as any).__TAURI_INTERNALS__; });

const base = { printers: 0, templates: 0, jobs: 0, shareConfigured: false, apiRunning: false, retentionReviewed: false };

describe("checklist model", () => {
  it("marks required steps from counts", () => {
    const items = buildChecklist({ ...base, printers: 2, templates: 5 });
    expect(items.find((i) => i.id === "printer")?.done).toBe(true);
    expect(items.find((i) => i.id === "test_print")?.done).toBe(false);
    expect(summarize(items)).toMatchObject({ requiredDone: 2, requiredTotal: 3, complete: false });
  });
  it("is complete when all required steps are done, optional ones aside", () => {
    const items = buildChecklist({ ...base, printers: 1, templates: 1, jobs: 1 });
    expect(summarize(items).complete).toBe(true);
    expect(items.filter((i) => !i.required).every((i) => i.done === false)).toBe(true);
  });
  it("is never complete when status is unknown", () => {
    const s = summarize(buildChecklist({ ...base, printers: null, templates: null, jobs: null }));
    expect(s.complete).toBe(false);
    expect(s.unknown).toBe(true);
  });
  it("parses the section query safely", () => {
    expect(parseSection("setup")).toBe("setup");
    expect(parseSection("retention")).toBe("retention");
    expect(parseSection("<script>")).toBe("general");
    expect(parseSection(null)).toBe("general");
  });
});

describe("Settings → Setup", () => {
  const renderAt = (url: string) => render(<MemoryRouter initialEntries={[url]}><SettingsPage /></MemoryRouter>);

  it("opens the checklist from ?section=setup and shows live status", async () => {
    // Concurrent first-time dynamic imports can bypass vi.mock, so route the real bridge to the same mock.
    (window as any).__TAURI_INTERNALS__ = { invoke: (...a: unknown[]) => invoke(...a) };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return [{ id: 1 }];
      if (cmd === "list_templates") return [{ id: 1 }, { id: 2 }];
      if (cmd === "list_jobs") return [];
      return null;
    });
    renderAt("/settings?section=setup");
    expect(await screen.findByRole("heading", { name: "Setup checklist" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 of 3 required steps done."));
    const printer = screen.getByText("Add a printer").closest("li")!;
    expect(within(printer).getByText("Done")).toBeInTheDocument();
    const testPrint = screen.getByText("Send a test print").closest("li")!;
    expect(within(testPrint).getByText("To do")).toBeInTheDocument();
  });

  it("says when steps cannot be checked in the browser preview", async () => {
    renderAt("/settings?section=setup");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("can't be checked in the browser preview"));
    expect(screen.queryByText("To do")).toBeNull();
  });

  it("jumps to another section from a checklist action", async () => {
    renderAt("/settings?section=setup");
    const row = (await screen.findByText("Review history retention")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Open Retention" }));
    expect(await screen.findByLabelText("Keep history for (days)")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderAt("/settings?section=setup");
    await screen.findByRole("heading", { name: "Setup checklist" });
    const r = await axe.run({ include: [container] }, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Settings → Appearance", () => {
  it("shows density and branding under General, and applies a rename", async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole("radiogroup", { name: "Density" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Comfortable/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("App name")).toBeInTheDocument();
  });

  it("rejects a logo of the wrong type with a message", async () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    const input = screen.getByLabelText("Upload logo file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "logo.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("PNG, JPEG, WebP, or SVG");
  });
});

describe("Onboarding", () => {
  it("is one short screen with the operator steps and two exits", () => {
    const done = vi.fn();
    render(<Onboarding onComplete={done} />);
    expect(screen.getByRole("heading", { name: "Welcome to PrintNinja" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Start printing" }));
    expect(done).toHaveBeenLastCalledWith("/print");
    fireEvent.click(screen.getByRole("button", { name: "Set up this workstation" }));
    expect(done).toHaveBeenLastCalledWith("/settings?section=setup");
  });

  it("has no axe violations", async () => {
    const { container } = render(<Onboarding onComplete={() => {}} />);
    const r = await axe.run({ include: [container] }, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
