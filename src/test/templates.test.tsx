import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const share = vi.hoisted(() => ({
  getServiceUrl: vi.fn(async () => null as string | null),
  getSessionToken: vi.fn(async () => null as string | null),
  hasUnpublishedChanges: (t: { remote_id: string | null; published_at: string | null; updated_at: string }) =>
    !!t.remote_id && !!t.published_at && t.updated_at > t.published_at,
}));
vi.mock("@/lib/share/client", () => share);

import { TemplatesPage } from "@/pages/Templates";
import { usePrintStore } from "@/lib/store/printStore";

const base = { readme: "", summary: "", remote_id: null, published_at: null, origin: "own", origin_owner: null, withdrawn: false, updated_at: "2026-02-01T00:00:00Z", page_w_mm: 100, page_h_mm: 150 };
const LIST = [
  { ...base, id: 1, name: "Shipping label" },
  { ...base, id: 2, name: "Receipt", remote_id: "r2", published_at: "2026-02-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { ...base, id: 3, name: "Pallet tag", remote_id: "r3", published_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" },
  { ...base, id: 4, name: "Saved A", origin: "saved", origin_owner: "ana", remote_id: "x1" },
  { ...base, id: 5, name: "Saved B", origin: "saved", origin_owner: "bo", remote_id: "x2", withdrawn: true },
];

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
const renderPage = () => render(<MemoryRouter initialEntries={["/templates"]}><Routes><Route path="*" element={<><TemplatesPage /><Where /></>} /></Routes></MemoryRouter>);

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  invoke.mockReset();
  share.getServiceUrl.mockResolvedValue(null);
  invoke.mockImplementation(async (cmd: string) => (cmd === "list_templates" ? LIST : cmd === "delete_template" ? null : null));
});

describe("Templates page", () => {
  it("opens on Mine with counts and one status per template", async () => {
    renderPage();
    expect(await screen.findByText("Shipping label")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mine (3)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Saved (2)" })).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByText("Changes not published")).toBeInTheDocument();
  });

  it("Print selects the template and goes to the Print page", async () => {
    renderPage();
    await screen.findByText("Shipping label");
    const row = screen.getByText("Shipping label").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Print/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/print"));
    expect(usePrintStore.getState().templateId).toBe("1");
  });

  it("Edit opens the template in Designer without a page reload", async () => {
    renderPage();
    await screen.findByText("Receipt");
    const row = screen.getByText("Receipt").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Edit/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/template/2"));
  });

  it("asks before removing a saved template, naming it", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Saved/ }));
    fireEvent.keyDown(screen.getByRole("tab", { name: /Saved/ }), { key: "Enter" });
    const row = (await screen.findByText("Saved A")).closest("tr")!;
    expect(within(screen.getByRole("table", { name: "Saved templates" })).getByText("Withdrawn by author")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove “Saved A” from Saved?")).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "delete_template")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove template" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_template", { id: 4 }));
  });

  it("explains when no share service is configured", async () => {
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Community" }));
    expect(await screen.findByText("Share service not set up")).toBeInTheDocument();
  });
});
