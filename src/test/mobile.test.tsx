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
import { PrinterSetupPage } from "@/pages/PrinterSetup";
import { TemplatesPage } from "@/pages/Templates";
import { usePrintStore } from "@/lib/store/printStore";
import { useHistoryStore, type HistoryJob } from "@/lib/store/historyStore";

// Templates page talks to the share service; stub it like templates.test.tsx.
const shareMock = vi.hoisted(() => ({
  getServiceUrl: vi.fn(async () => null as string | null),
  getSessionToken: vi.fn(async () => null as string | null),
  hasUnpublishedChanges: (t: {
    remote_id: string | null;
    published_at: string | null;
    updated_at: string;
  }) => !!t.remote_id && !!t.published_at && t.updated_at > t.published_at,
  fetchRemoteTemplate: vi.fn(async () => ({})),
  fetchCommunityTemplates: vi.fn(async () => []),
  saveRemoteTemplate: vi.fn(async () => {}),
  unsaveRemoteTemplate: vi.fn(async () => {}),
  RemoteTemplateNotFoundError: class extends Error {},
  ServerUnreachableError: class extends Error {},
}));
vi.mock("@/lib/share/client", () => shareMock);
vi.mock("@/lib/share/sync", () => ({
  downloadToLocal: vi.fn(async () => ({ id: 9, created: true })),
  listAvailableRemoteTemplates: vi.fn(async () => ({ mine: [], saved: [] })),
}));
const saveMock = vi.hoisted(() => ({
  saveRowToServer: vi.fn(async () => ({})),
  takeServerCopy: vi.fn(async () => ({})),
  deleteTemplateEverywhere: vi.fn(async () => {}),
}));
vi.mock("@/lib/share/save", () => saveMock);

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

describe("phone Printers page", () => {
  const PRINTERS = [
    {
      id: 1,
      name: "Dock Zebra",
      printer_type: "raw_tcp",
      address: "10.0.0.5:9100",
      status: "online",
      language: "pdf",
      paper_width_mm: 80,
      dpi: 203,
    },
    {
      id: 2,
      name: "Office HP",
      printer_type: "ipp",
      address: "http://10.0.0.9",
      status: "offline",
      language: "pdf",
      paper_width_mm: 80,
      dpi: 203,
    },
    {
      id: 3,
      name: "Counter USB",
      printer_type: "usb",
      address: "usb-1",
      language: "pdf",
      paper_width_mm: 80,
      dpi: 203,
    },
  ];

  beforeEach(() => {
    window.matchMedia = phoneMatchMedia as typeof window.matchMedia;
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_printers") return PRINTERS;
      if (cmd === "enumerate_system_printers") return [];
      return null;
    });
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <PrinterSetupPage />
      </MemoryRouter>,
    );

  it("renders printer cards with icon-word status and no table", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Printers" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    // Status reads as an icon + word badge, including "Not checked".
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5:9100")).toBeInTheDocument();
    // Primary Test print action keeps its accessible name.
    expect(
      screen.getByRole("button", { name: "Test print on Dock Zebra" }),
    ).toBeInTheDocument();
  });

  it("connection tabs still filter the cards", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Network (2)" }));
    expect(screen.getByText("Office HP")).toBeInTheDocument();
    expect(screen.queryByText("Counter USB")).toBeNull();
  });

  it("tests and removes a printer from its card", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.click(
      screen.getByRole("button", { name: "Test print on Dock Zebra" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("test_printer", { id: 1 }),
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Dock Zebra" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove Dock Zebra" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Remove “Dock Zebra”?"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove printer" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("delete_printer", { id: 1 }),
    );
  });

  it("edits a printer from its card menu", async () => {
    renderPage();
    await screen.findByText("Dock Zebra");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Dock Zebra" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Edit Dock Zebra" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Edit printer" }),
    ).toBeInTheDocument();
  });
});

describe("phone Templates page", () => {
  const base = {
    readme: "",
    summary: "",
    remote_id: null,
    published_at: null,
    origin: "own",
    origin_owner: null,
    withdrawn: false,
    updated_at: "2026-02-01T00:00:00Z",
    page_w_mm: 100,
    page_h_mm: 150,
  };
  const LIST = [
    { ...base, id: 1, name: "Shipping label" },
    {
      ...base,
      id: 2,
      name: "Receipt",
      remote_id: "r2",
      server_id: "r2",
      base_revision: 3,
      published_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      ...base,
      id: 3,
      name: "Pallet tag",
      remote_id: "r3",
      server_id: "r3",
      base_revision: 2,
      published_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    window.matchMedia = phoneMatchMedia as typeof window.matchMedia;
    invoke.mockReset();
    saveMock.deleteTemplateEverywhere.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_templates") return LIST;
      if (cmd === "cache_list_conflicted") return [];
      return null;
    });
  });

  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={["/templates"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <TemplatesPage />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

  it("renders template cards with status and page size, no table", async () => {
    renderPage();
    await screen.findByText("Shipping label");
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByRole("list", { name: "My templates" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Not on the server")).toBeInTheDocument();
    expect(screen.getAllByText("100 × 150 mm")).toHaveLength(3);
  });

  it("tapping a card opens the designer", async () => {
    renderPage();
    await screen.findByText("Receipt");
    fireEvent.click(screen.getByText("Receipt"));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/template/2"),
    );
  });

  it("sort dropdown reorders the cards", async () => {
    renderPage();
    await screen.findByText("Shipping label");
    const list = screen.getByRole("list", { name: "My templates" });
    const names = () =>
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("p")?.textContent);
    expect(names()).toEqual(["Shipping label", "Receipt", "Pallet tag"]);
    fireEvent.click(screen.getByRole("combobox", { name: "Sort templates" }));
    fireEvent.click(await screen.findByRole("option", { name: "Name (A–Z)" }));
    await waitFor(() =>
      expect(names()).toEqual(["Pallet tag", "Receipt", "Shipping label"]),
    );
  });

  it("card menu prints and deletes", async () => {
    renderPage();
    await screen.findByText("Shipping label");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Shipping label" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Print" }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/print"),
    );
    expect(usePrintStore.getState().templateId).toBe("1");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Receipt" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Delete Receipt everywhere",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Delete “Receipt” everywhere?"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete template" }),
    );
    await waitFor(() =>
      expect(saveMock.deleteTemplateEverywhere).toHaveBeenCalled(),
    );
  });
});

describe("phone History cards", () => {
  beforeEach(() => {
    window.matchMedia = phoneMatchMedia as typeof window.matchMedia;
    localStorage.clear();
    useHistoryStore.setState({ jobs: [], selectedJob: null });
    useHistoryStore.getState().clearFilter();
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "list_jobs") return JOBS;
      if (cmd === "list_printers")
        return [
          { id: 1, name: "Dock Zebra" },
          { id: 2, name: "Front desk" },
        ];
      if (cmd === "reprint_job") return job({ id: 100 + args.id });
      if (cmd === "delete_job") return null;
      return null;
    });
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>,
    );

  it("renders job cards with status and printer, no table", async () => {
    renderPage();
    await screen.findByText("#2");
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Print jobs" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Paper out")).toBeInTheDocument();
    // Checkbox multi-select keeps its accessible names in card mode.
    expect(
      screen.getByRole("checkbox", { name: "Select row 1" }),
    ).toBeInTheDocument();
  });

  it("tapping a card opens the details", async () => {
    renderPage();
    await screen.findByText("#1");
    fireEvent.click(screen.getByText("#1"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("card menu reprints a job", async () => {
    renderPage();
    await screen.findByText("#1");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for job 1" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Reprint job 1" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reprint job #1?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reprint" }));
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((c) => c[0] === "reprint_job"),
      ).toHaveLength(1),
    );
  });

  it("selection shows a sticky bulk bar", async () => {
    renderPage();
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    const bar = await screen.findByText("1 selected");
    expect(bar.parentElement).toHaveClass("sticky");
  });
});
