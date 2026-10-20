import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/lib/i18n";
import { DesignerPage } from "@/pages/Designer";

// The page reads templates and versions over IPC on mount; answer as a fresh
// install does (see smoke.test.tsx).
const TEMPLATE_ROW = { id: 1, name: "Receipt", page_w_mm: 80, page_h_mm: 200, orientation: "portrait" };
let templateId = 0;
const EMPTY_LISTS = new Set(["list_templates", "list_versions", "list_fonts", "list_printers", "list_profiles"]);
const invoke = vi.fn(async (cmd: string) => {
  if (EMPTY_LISTS.has(cmd)) return [];
  if (cmd === "create_template") return { ...TEMPLATE_ROW, id: ++templateId };
  if (cmd === "get_template")
    return { ...TEMPLATE_ROW, summary: "", readme: "", remote_id: null, published_at: null, origin: "own", withdrawn: false };
  return null;
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: (...a: unknown[]) => invoke(a[0] as string) };
});

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((q: string) =>
      ({
        matches: false, media: q, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
      }) as unknown as typeof window.matchMedia);
  (globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  // CodeMirror measures text with Range rects, which jsdom does not implement.
  const noRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getClientRects = Range.prototype.getClientRects || noRects;
  Range.prototype.getBoundingClientRect = Range.prototype.getBoundingClientRect || (() => new DOMRect());
});

function renderDesigner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<DesignerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Radix Tabs switch on mousedown, not click.
const openTab = (name: string) => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
};

describe("Designer page layout", () => {
  it("offers Canvas, Code, README and Variables, and no Visual or Preview tab", async () => {
    renderDesigner();
    const tablist = await screen.findByRole("tablist", { name: "Designer views" });
    const names = Array.from(tablist.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(names).toEqual(["Canvas", "Code", "README", "Variables"]);
    expect(screen.queryByRole("tab", { name: "Visual" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Preview" })).not.toBeInTheDocument();
  });

  it("no longer shows the Properties card, but keeps Quick Helpers", async () => {
    renderDesigner();
    await screen.findByRole("tablist", { name: "Designer views" });
    expect(screen.queryByText("Properties")).not.toBeInTheDocument();
    expect(screen.getByText("Quick Helpers")).toBeInTheDocument();
  });

  it("keeps the sync bar in the page header area, outside the tabs", async () => {
    renderDesigner();
    const tablist = await screen.findByRole("tablist", { name: "Designer views" });
    const save = screen.getByRole("button", { name: "Save to server" });
    expect(screen.getByText("Draft")).toBeInTheDocument();
    // TabsList carries data-orientation too, so start from its parent to reach the Tabs root.
    const tabsRoot = tablist.parentElement?.closest("[data-orientation]");
    expect(tabsRoot).not.toBeNull();
    expect(tabsRoot?.contains(tablist)).toBe(true);
    expect(tabsRoot?.contains(save)).toBe(false);
  });

  it("starts on the canvas and shows the code editors on the Code tab", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    expect(screen.queryByText("CSS")).not.toBeInTheDocument();
    openTab("Code");
    await waitFor(() => expect(screen.getByText(/^HTML — /)).toBeInTheDocument());
    expect(screen.getByText("CSS")).toBeInTheDocument();
    expect(screen.queryByTitle("Canvas preview")).not.toBeInTheDocument();
  });

  it("Save & Preview returns to the canvas", async () => {
    renderDesigner();
    await screen.findByTitle("Canvas preview");
    openTab("Code");
    await waitFor(() => expect(screen.getByText(/^HTML — /)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Save & Preview/ }));
    expect(await screen.findByTitle("Canvas preview")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  });
});
