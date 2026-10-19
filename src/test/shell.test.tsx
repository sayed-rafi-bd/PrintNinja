import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import axe from "axe-core";
import "@/lib/i18n";
import { Layout } from "@/components/Layout";
import { NAV_GROUPS, NAV_ITEMS, isActivePath } from "@/lib/shell/nav";
import { isTypingTarget } from "@/lib/shell/useGlobalShortcuts";

beforeAll(() => {
  (globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderShell(path = "/history") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Layout>
        <Routes>
          <Route path="*" element={<><h1>Page</h1><input aria-label="field" /><Where /></>} />
        </Routes>
      </Layout>
    </MemoryRouter>,
  );
}

describe("navigation model", () => {
  it("groups pages by job: Work, Build, Admin", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(["work", "build", "admin"]);
    expect(NAV_GROUPS[0].items.map((i) => i.path)).toEqual(["/print", "/history"]);
    expect(NAV_GROUPS[1].items.map((i) => i.path)).toEqual(["/", "/templates"]);
    expect(NAV_GROUPS[2].items.map((i) => i.path)).toEqual(["/printers", "/settings"]);
  });

  it("gives every page a unique go-to key", () => {
    const keys = NAV_ITEMS.map((i) => i.shortcut);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("treats /template/:id as part of the Designer", () => {
    expect(isActivePath("/template/4", "/")).toBe(true);
    expect(isActivePath("/templates", "/")).toBe(false);
    expect(isActivePath("/history", "/history")).toBe(true);
  });

  it("detects text entry targets", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const inner = document.createElement("span");
    editor.appendChild(inner);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(inner)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});

describe("app shell", () => {
  it("renders the same landmarks on every route, with labelled navs", () => {
    renderShell();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary, bottom bar" })).toBeInTheDocument();
  });

  it("marks the current page and shows group headings", () => {
    renderShell("/history");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const g of ["Work", "Build", "Admin"]) expect(within(nav).getByText(g)).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Print" })).not.toHaveAttribute("aria-current");
  });

  it("no longer shows the sidebar tip", () => {
    renderShell();
    expect(screen.queryByText(/collapse for more canvas/i)).toBeNull();
  });

  it("opens search with Ctrl+K and jumps to a page", async () => {
    renderShell("/history");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByPlaceholderText("Search pages, templates, actions");
    fireEvent.change(input, { target: { value: "printers" } });
    fireEvent.click(await screen.findByRole("option", { name: /Printers/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/printers"));
  });

  it("goes to a page with G then a letter", () => {
    renderShell("/history");
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "t" });
    expect(screen.getByTestId("where")).toHaveTextContent("/templates");
  });

  it("ignores letter shortcuts while typing in a field", () => {
    renderShell("/history");
    const field = screen.getByLabelText("field");
    field.focus();
    fireEvent.keyDown(field, { key: "g" });
    fireEvent.keyDown(field, { key: "p" });
    expect(screen.getByTestId("where")).toHaveTextContent("/history");
  });

  it("lists every shortcut in the help dialog opened with ?", async () => {
    renderShell();
    fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^Go to /)).toHaveLength(NAV_ITEMS.length);
  });

  it("every page is reachable by keyboard: all nav items are real links", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(NAV_ITEMS.length);
    for (const l of links) expect(l).toHaveAttribute("href");
  });

  it("has no axe violations", async () => {
    const { container } = renderShell();
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
