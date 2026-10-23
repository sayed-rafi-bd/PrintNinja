import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/lib/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/lib/templates/seedTemplates", () => ({
  ensureStarterTemplates: async () => [
    { id: 7, name: "Shipping label", page_w_mm: 100, page_h_mm: 150, orientation: "portrait", html: "<p>Hi {{store.name}}</p>", css: "", compiled_css: "", compiled_key: "" },
  ],
}));
vi.mock("@/lib/hooks/useSystemPrinters", () => ({
  useSystemPrinters: () => ({
    printers: [{ id: "1", name: "Dock Zebra" }],
    refresh: async () => [{ id: "1", name: "Dock Zebra" }],
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { PrintPage } from "@/pages/Print";
import { usePrintStore } from "@/lib/store/printStore";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  invoke.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  usePrintStore.setState({
    printerId: "",
    templateId: "",
    status: "idle",
    error: "",
    copies: 1,
    timings: null,
    pageRange: "",
    grayscale: false,
  });
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_batches") return [];
    if (cmd === "enumerate_system_printers")
      return [{ id: "1", name: "Dock Zebra" }];
    if (cmd === "print_html") {
      return {
        success: true,
        job_id: "9",
        duration_ms: 120,
        timings: {
          fetch_ms: 0,
          template_ms: 1,
          layout_ms: 0,
          render_ms: 90,
          send_ms: 25,
          history_ms: 4,
          total_ms: 120,
        },
      };
    }
    return null;
  });
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <PrintPage />
    </MemoryRouter>,
  );

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
    expect(
      await screen.findByText(/Choose a printer to enable printing/),
    ).toBeInTheDocument();
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

  it("refuses a batch with a non-numeric template id before any IPC", async () => {
    usePrintStore.setState({ printerId: "Dock Zebra", templateId: "abc" });
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    fireEvent.click(screen.getByRole("button", { name: "New batch" }));
    fireEvent.change(screen.getByPlaceholderText(/"name":"Tea"/), {
      target: { value: '[{"name":"Tea"}]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Batch" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Select a template first"),
    );
    expect(invoke.mock.calls.some(([cmd]) => cmd === "create_batch")).toBe(
      false,
    );
  });

  it("reports an unresolvable batch printer instead of sending id 0", async () => {
    usePrintStore.setState({ printerId: "Ghost Printer", templateId: "7" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_versions")
        return [{ id: 1, html: "<p>Hi</p>", css: "" }];
      if (cmd === "list_batches") return [];
      if (cmd === "list_printers") return [];
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
    renderPage();
    await screen.findByRole("button", { name: /^Print$/ });
    fireEvent.click(screen.getByRole("button", { name: "New batch" }));
    fireEvent.change(screen.getByPlaceholderText(/"name":"Tea"/), {
      target: { value: '[{"name":"Tea"}]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Batch" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not resolve printer — re-select it",
      ),
    );
    expect(invoke.mock.calls.some(([cmd]) => cmd === "create_batch")).toBe(
      false,
    );
  });

  it("announces success, and failure with a retry", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith(
      "print_html",
      expect.objectContaining({
        req: expect.objectContaining({
          printer_name: "Dock Zebra",
          template_id: 7,
        }),
      }),
    );

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "print_html")
        return {
          success: false,
          job_id: "10",
          duration_ms: 5,
          error: "Paper out",
        };
      return [];
    });
    fireEvent.click(screen.getByRole("button", { name: /^Print$/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Paper out");
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("sends page range and grayscale with the print request", async () => {
    usePrintStore.setState({ pageRange: "1-3", grayscale: true });
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({
            page_range: "1-3",
            grayscale: true,
          }),
        }),
      ),
    );
  });

  it("sends the chosen data-url HTTP method with the print request", async () => {
    usePrintStore.setState({
      dataUrl: "https://api.example.com/orders/123",
      httpMethod: "POST",
    });
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "print_html",
        expect.objectContaining({
          req: expect.objectContaining({
            data_url: "https://api.example.com/orders/123",
            http_method: "POST",
          }),
        }),
      ),
    );
  });
  it("shows that the printer is ready before anything is printed", async () => {
    renderPage();
    expect(await screen.findByText("Printer is ready")).toBeInTheDocument();
  });

  it("reports a finished print in the alert, with its timing, and shows no toast", async () => {
    renderPage();
    const print = await screen.findByRole("button", { name: /^Print$/ });
    await waitFor(() => expect(print).toBeEnabled());
    fireEvent.click(print);
    expect(await screen.findByText("Print sent")).toBeInTheDocument();
    expect(screen.queryByText("Printer is ready")).toBeNull();
    const timing = screen.getByTestId("timing-breakdown");
    expect(timing).toHaveTextContent("Total 120 ms");
    expect(timing).toHaveTextContent("Render 90 ms");
    expect(timing).toHaveTextContent("Send 25 ms");
    expect(timing).toHaveTextContent("History write 4 ms");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
