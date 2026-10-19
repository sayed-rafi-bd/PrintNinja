import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/lib/templates/seedTemplates", () => ({
  ensureStarterTemplates: async () => [{ id: 7, name: "Shipping label", page_w_mm: 100, page_h_mm: 150 }],
}));
vi.mock("@/lib/hooks/useSystemPrinters", () => ({
  useSystemPrinters: () => ({ printers: [{ id: "1", name: "Dock Zebra" }], refresh: async () => [{ id: "1", name: "Dock Zebra" }] }),
}));

import { PrintPage } from "@/pages/Print";
import { usePrintStore } from "@/lib/store/printStore";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  invoke.mockReset();
  usePrintStore.setState({ printerId: "", templateId: "", status: "idle", error: "", copies: 1 });
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_versions") return [{ id: 1, html: "<p>Hi {{store.name}}</p>", css: "" }];
    if (cmd === "list_batches") return [];
    if (cmd === "enumerate_system_printers") return [{ id: "1", name: "Dock Zebra" }];
    if (cmd === "print_html") return { success: true, job_id: "9", duration_ms: 120 };
    return null;
  });
});

const renderPage = () => render(<MemoryRouter><PrintPage /></MemoryRouter>);

describe("Print page", () => {
  it("preselects the first printer and template and enables one primary Print button", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
  });

  it("explains why printing is disabled when nothing is chosen", async () => {
    usePrintStore.setState({ printerId: "", templateId: "" });
    invoke.mockImplementation(async () => []);
    renderPage();
    expect(await screen.findByText(/Choose a printer to enable printing/)).toBeInTheDocument();
  });

  it("shows the preview for the selected template without opening a dialog", async () => {
    renderPage();
    const frame = await screen.findByTitle("Print preview");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps margins and fit options behind Advanced options", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    expect(screen.queryByLabelText("Page range")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }));
    expect(screen.getByLabelText("Page range")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Margins/ })).toBeInTheDocument();
  });

  it("announces success, and failure with a retry", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("print_html", expect.objectContaining({ req: expect.objectContaining({ printer_name: "Dock Zebra", template_id: 7 }) }));

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "print_html") return { success: false, job_id: "10", duration_ms: 5, error: "Paper out" };
      if (cmd === "list_versions") return [{ id: 1, html: "x", css: "" }];
      return [];
    });
    fireEvent.click(screen.getByRole("button", { name: /^Print$/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Paper out");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
