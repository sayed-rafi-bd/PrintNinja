import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axe from "axe-core";
import "@/lib/i18n";
import { Layout } from "@/components/Layout";
import { TemplatesPage } from "@/pages/Templates";
import { HistoryPage } from "@/pages/History";
import { PrintPage } from "@/pages/Print";
import { PrinterSetupPage } from "@/pages/PrinterSetup";
import { SettingsPage } from "@/pages/Settings";
import { DesignerPage } from "@/pages/Designer";

// The shell and every page read settings and lists over IPC on mount. Without a
// stub each of those calls fails in jsdom, and `src/lib/invoke` logs the failure
// to console.error, which the "without errors" test below then fails on. The
// answers are the ones a fresh install gives: no printers, no jobs, and the
// starter templates seeded as a real row.
const TEMPLATE_ROW = {
  id: 1,
  name: "Receipt",
  page_w_mm: 80,
  page_h_mm: 200,
  orientation: "portrait",
};
let templateId = 0;
const nextTemplateId = () => ++templateId;
const EMPTY_LISTS = new Set([
  "cache_list_conflicted",
  "enumerate_system_printers",
  "get_trusted_sources",
  "list_batches",
  "list_fonts",
  "list_jobs",
  "list_printers",
  "list_datasets",
  "list_profiles",
  "list_templates",
  "list_versions",
]);
const invoke = vi.fn(async (cmd: string) => {
  if (EMPTY_LISTS.has(cmd)) return [];
  // Each seeded starter needs its own id, or the lists render duplicate React keys.
  if (cmd === "create_template")
    return { ...TEMPLATE_ROW, id: nextTemplateId() };
  if (cmd === "get_template")
    return {
      ...TEMPLATE_ROW,
      summary: "",
      readme: "",
      remote_id: null,
      published_at: null,
      origin: "own",
      withdrawn: false,
    };
  if (cmd === "get_api_status") return { running: false, port: 0, address: "" };
  return null;
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: (...a: unknown[]) => invoke(a[0] as string) };
});

const ROUTES: Array<[string, string, React.ComponentType]> = [
  ["/", "designer", DesignerPage],
  ["/templates", "templates", TemplatesPage],
  ["/print", "print", PrintPage],
  ["/printers", "printers", PrinterSetupPage],
  ["/history", "history", HistoryPage],
  ["/settings", "settings", SettingsPage],
];

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    (((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia);
  (globalThis as any).ResizeObserver =
    (globalThis as any).ResizeObserver ||
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  Element.prototype.scrollIntoView =
    Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture =
    Element.prototype.hasPointerCapture || (() => false);
});

function renderRoute(path: string, Page: React.ComponentType) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Layout>
          <Routes>
            <Route path={path} element={<Page />} />
          </Routes>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("route smoke tests", () => {
  const AXE_TIMEOUT_MS = 30_000;

  it.each(ROUTES)(
    "%s renders in the shell without errors",
    async (path, _name, Page) => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
        errors.push(a);
      });
      const { container } = renderRoute(path, Page);
      await waitFor(() =>
        expect(container.querySelector("main")).not.toBeNull(),
      );
      expect(container.querySelectorAll("main").length).toBe(1);
      expect(container.querySelector("h1")).not.toBeNull();
      spy.mockRestore();
      expect(errors).toEqual([]);
    },
  );

  it.each(ROUTES)(
    "%s has no axe violations",
    async (path, _name, Page) => {
      const { container } = renderRoute(path, Page);
      await waitFor(() =>
        expect(container.querySelector("main")).not.toBeNull(),
      );
      // The preview iframe holds the template itself, not app UI, and jsdom cannot cross into it.
      const results = await axe.run(
        { include: [container], exclude: [["iframe"]] },
        {
          // jsdom has no layout engine; contrast is checked in tokens.test.ts instead.
          rules: {
            "color-contrast": { enabled: false },
            region: { enabled: false },
          },
        },
      );
      const summary = results.violations.map(
        (v) =>
          `${v.id} (${v.nodes.length}): ${v.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 3)
            .join(" | ")}`,
      );
      expect(summary).toEqual([]);
      // axe walks the whole tree; the Designer takes ~6s, which is over vitest's
      // 5s default and made this fail on loaded CI runners.
    },
    AXE_TIMEOUT_MS,
  );
});
