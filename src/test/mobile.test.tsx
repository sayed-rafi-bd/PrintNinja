import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import "@/lib/i18n";
import { Layout } from "@/components/Layout";
import { PrintPage } from "@/pages/Print";
import { HistoryPage } from "@/pages/History";
import { usePrintStore } from "@/lib/store/printStore";
import { useHistoryStore, type HistoryJob } from "@/lib/store/historyStore";

// Phone-width matchMedia: only PHONE_QUERY ("max-width: 767px") matches.
// Desktop and jsdom default to no match, like the other suites.
const phoneMatchMedia = (query: string) =>
  ({
    matches: query.includes("767"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList;

beforeAll(() => {
  (globalThis as any).ResizeObserver =
    (globalThis as any).ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  Element.prototype.hasPointerCapture =
    Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.scrollIntoView =
    Element.prototype.scrollIntoView || (() => {});
});

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/lib/templates/seedTemplates", () => ({
  ensureStarterTemplates: async () => [
    {
      id: 7,
      name: "Shipping label",
      page_w_mm: 100,
      page_h_mm: 150,
      orientation: "portrait",
      html: "<p>Hi</p>",
      css: "",
      compiled_css: "",
      compiled_key: "",
    },
  ],
}));
vi.mock("@/lib/hooks/useSystemPrinters", () => ({
  useSystemPrinters: () => ({
    printers: [{ id: "1", name: "Dock Zebra" }],
    refresh: async () => [{ id: "1", name: "Dock Zebra" }],
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const job = (over: Partial<HistoryJob>): HistoryJob => ({
  id: 1,
  batch_id: null,
  record_index: null,
  template_id: 3,
  printer_id: 1,
  source: "ui",
  source_url: null,
  status: "success",
  error: null,
  copies: 1,
  settings_json: null,
  rendered_html: null,
  idempotency_key: null,
  is_test: false,
  started_at: "2026-01-02T10:00:00Z",
  finished_at: "2026-01-02T10:00:02Z",
  duration_ms: 2000,
  timings_json: null,
  ...over,
});

const JOBS = [
  job({ id: 1 }),
  job({ id: 2, status: "failed", error: "Paper out" }),
  job({
    id: 3,
    status: "success",
    is_test: true,
    printer_id: 2,
    source: "api",
  }),
];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe("phone shell", () => {
  it("bottom bar has five slots and More opens Designer, API Explorer and Settings", async () => {
    window.matchMedia = phoneMatchMedia as typeof window.matchMedia;
    render(
      <MemoryRouter initialEntries={["/history"]}>
        <Layout>
          <Routes>
            <Route path="*" element={<Where />} />
          </Routes>
        </Layout>
      </MemoryRouter>,
    );
    const bar = screen.getByRole("navigation", { name: "Primary, bottom bar" });
    expect(within(bar).getAllByRole("link")).toHaveLength(4);
    for (const name of ["Print", "History", "Templates", "Printers"])
      expect(within(bar).getByRole("link", { name })).toBeInTheDocument();
    // Designer moved behind More.
    expect(within(bar).queryByRole("link", { name: "Designer" })).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "More" }));
    const dialog = await screen.findByRole("dialog");
    for (const name of ["Designer", "API Explorer", "Settings"])
      expect(within(dialog).getByRole("link", { name })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("link", { name: "Designer" }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/"),
    );
  });
});

describe("phone Print page", () => {
  beforeEach(() => {
    window.matchMedia = phoneMatchMedia as typeof window.matchMedia;
    invoke.mockReset();
    usePrintStore.setState({
      printerId: "",
      templateId: "",
      dataUrl: "",
      httpMethod: "GET",
      copies: 1,
      records: 1,
      useTestData: false,
      pageRange: "",
      grayscale: false,
      status: "idle",
      error: "",
      timings: null,
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "enumerate_system_printers")
        return [{ id: "1", name: "Dock Zebra" }];
      if (cmd === "print_html") {
        return {
          success: true,
          job_id: "9",
          duration_ms: 120,
          timings: null,
        };
      }
      return null;
    });
  });

  it("shows one sticky Print bar with a printer picker and a single Print button", async () => {
    render(
      <MemoryRouter>
        <PrintPage />
      </MemoryRouter>,
    );
    const bar = await screen.findByTestId("print-action-bar");
    expect(bar).toHaveClass("sticky");
    expect(
      within(bar).getByRole("combobox", { name: "Printer" }),
    ).toBeInTheDocument();
    // Exactly one Print button page-wide: the in-card one is phone-hidden.
    expect(screen.getAllByRole("button", { name: /^Print$/ })).toHaveLength(1);
    expect(
      within(bar).getByRole("button", { name: /^Print$/ }),
    ).toBeInTheDocument();
  });

  it("collapses data fields into Advanced options while test data is on", async () => {
    usePrintStore.setState({ useTestData: true });
    render(
      <MemoryRouter>
        <PrintPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("print-action-bar");
    expect(screen.queryByLabelText("Data URL")).toBeNull();
    expect(screen.queryByLabelText("Pages")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Advanced options/ }));
    expect(screen.getByLabelText("Data URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Pages")).toBeInTheDocument();
  });
});

describe("phone History page", () => {
  beforeEach(() => {
    window.matchMedia = phoneMatchMedia as typeof window.matchMedia;
    localStorage.clear();
    useHistoryStore.setState({ jobs: [], selectedJob: null });
    useHistoryStore.getState().clearFilter();
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_jobs") return JOBS;
      if (cmd === "list_printers")
        return [
          { id: 1, name: "Dock Zebra" },
          { id: 2, name: "Front desk" },
        ];
      return null;
    });
  });

  it("moves filters into a labeled sheet and shows removable chips", async () => {
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>,
    );
    await screen.findByText("#2");
    // Inline controls are gone; only Search and the Filters button remain.
    expect(screen.queryByLabelText("Filter test jobs")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByLabelText("Filter test jobs"),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("From date")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("To date")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /^Apply/ }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Reset" }),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByLabelText("Filter test jobs"));
    fireEvent.click(await screen.findByText("Test only"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Apply/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // One chip for the active filter; removing it restores the rows.
    const chip = await screen.findByRole("button", {
      name: "Remove Test only filter",
    });
    expect(screen.queryByText("#1")).not.toBeInTheDocument();
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: /Remove .* filter/ }),
    ).toBeNull();
  });
});
