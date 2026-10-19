import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { PrinterSetupPage } from "@/pages/PrinterSetup";

const P = (o: object) => ({ paper_width_mm: 80, dpi: 203, language: "pdf", ...o });
const PRINTERS = [
  P({ id: 1, name: "Dock Zebra", printer_type: "raw_tcp", address: "10.0.0.5:9100", status: "online" }),
  P({ id: 2, name: "Office HP", printer_type: "ipp", address: "http://10.0.0.9", status: "offline" }),
  P({ id: 3, name: "Counter USB", printer_type: "usb", address: "usb-1" }),
];

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_printers") return PRINTERS;
    if (cmd === "enumerate_system_printers") return [];
    return null;
  });
});
const renderPage = () => render(<MemoryRouter><PrinterSetupPage /></MemoryRouter>);

describe("Printers page", () => {
  it("lists printers with status words, and says when status was not checked", async () => {
    renderPage();
    expect(await screen.findByText("Dock Zebra")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
  });

  it("groups Wi-Fi and raw TCP printers under Network (the old Wi-Fi tab matched nothing)", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    expect(screen.getByRole("tab", { name: "All (3)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Network (2)" })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Network (2)" }));
    await waitFor(() => expect(screen.queryByText("Counter USB")).toBeNull());
    expect(screen.getByText("Office HP")).toBeInTheDocument();
  });

  it("sends a test page from the row", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: "Test print on Dock Zebra" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("test_printer", { id: 1 }));
  });

  it("names the printer before removing it", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: "Remove Dock Zebra" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove “Dock Zebra”?")).toBeInTheDocument();
    expect(invoke.mock.calls.some((c) => c[0] === "delete_printer")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove printer" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_printer", { id: 1 }));
  });

  it("adds a printer from the side panel and validates IPP addresses", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(screen.getByRole("button", { name: /Add printer/i }));
    const panel = await screen.findByRole("dialog");
    fireEvent.change(within(panel).getByLabelText("Printer name"), { target: { value: "Lobby" } });
    fireEvent.change(within(panel).getByLabelText("Address"), { target: { value: "10.0.0.7" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save printer" }));
    expect(invoke.mock.calls.some((c) => c[0] === "add_printer")).toBe(false);
    fireEvent.change(within(panel).getByLabelText("Address"), { target: { value: "http://10.0.0.7" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save printer" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("add_printer", expect.objectContaining({ req: expect.objectContaining({ name: "Lobby", address: "http://10.0.0.7" }) })));
  });

  it("explains an empty group and offers a next step", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "list_printers" ? [] : []));
    renderPage();
    expect(await screen.findByText("No printers yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Add printer/i }).length).toBeGreaterThan(0);
  });
});
