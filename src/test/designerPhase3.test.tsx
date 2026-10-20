import { createRef, useState } from "react";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, renderHook, screen, fireEvent, act } from "@testing-library/react";
import "@/lib/i18n";
import { CanvasWorkspace } from "@/components/designer/CanvasWorkspace";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import { ControlsRail } from "@/components/designer/ControlsRail";
import { EditorPane, type EditorPaneHandle } from "@/components/designer/EditorPane";
import { HelpersPanel, helperSnippet } from "@/components/designer/HelpersPanel";
import { LayoutToggle, isDesignerLayout } from "@/components/designer/LayoutToggle";
import { usePersistentState } from "@/lib/hooks/usePersistentState";
import { getTemplateError } from "@/lib/render/renderTemplate";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
  // CodeMirror measures text with Range rects, which jsdom does not implement.
  const noRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getClientRects = Range.prototype.getClientRects || noRects;
  Range.prototype.getBoundingClientRect = Range.prototype.getBoundingClientRect || (() => new DOMRect());
});

beforeEach(() => window.localStorage.clear());

describe("getTemplateError", () => {
  it("is null for a template that renders", () => {
    expect(getTemplateError("<p>{{name}}</p>", { name: "x" })).toBeNull();
  });

  it("reports an unclosed block as a single line", () => {
    const msg = getTemplateError("<table>{{#each items}}<tr></tr>", {});
    expect(msg).toBeTruthy();
    expect(msg).not.toContain("\n");
  });

  it("reports a half-typed tag", () => {
    expect(getTemplateError("<p>{{order.</p>", {})).toBeTruthy();
  });
});

describe("CanvasWorkspace error banner", () => {
  const base = { css: "", compiledCss: "", data: {}, pageWidthMm: 100, pageHeightMm: 150 };

  it("shows an alert while the template is invalid, and not otherwise", () => {
    const { rerender } = render(<CanvasWorkspace {...base} html="<p>ok</p>" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    rerender(<CanvasWorkspace {...base} html="{{#each items}}<p>" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Template error/);
    rerender(<CanvasWorkspace {...base} html="<p>fixed</p>" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LayoutToggle", () => {
  it("marks the current layout and reports a change", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="side" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Stacked" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Canvas only" }));
    expect(onChange).toHaveBeenCalledWith("canvas");
  });

  it("only accepts the three known layouts from storage", () => {
    expect(isDesignerLayout("stacked")).toBe(true);
    expect(isDesignerLayout("diagonal")).toBe(false);
    expect(isDesignerLayout(null)).toBe(false);
  });
});

describe("usePersistentState", () => {
  const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

  it("starts from the initial value, then remembers what was set", () => {
    const first = renderHook(() => usePersistentState("k", ["page"], isStrings));
    expect(first.result.current[0]).toEqual(["page"]);
    act(() => first.result.current[1](["page", "versions"]));
    const second = renderHook(() => usePersistentState("k", ["page"], isStrings));
    expect(second.result.current[0]).toEqual(["page", "versions"]);
  });

  it("ignores a stored value that is invalid or not JSON", () => {
    window.localStorage.setItem("k", JSON.stringify([1, 2]));
    expect(renderHook(() => usePersistentState("k", ["page"], isStrings)).result.current[0]).toEqual(["page"]);
    window.localStorage.setItem("k", "{not json");
    expect(renderHook(() => usePersistentState("k", ["page"], isStrings)).result.current[0]).toEqual(["page"]);
  });
});

describe("ControlsAccordion, controlled", () => {
  const props = () => ({
    templates: [{ id: 1, name: "Label" }],
    currentTemplateId: 1, loadTemplate: vi.fn(),
    templateName: "Label", setTemplateName: vi.fn(),
    pageWidth: 100, setPageWidth: vi.fn(), pageHeight: 150, setPageHeight: vi.fn(),
    presets: [], orientation: "portrait" as const, setOrientation: vi.fn(),
    versions: [], onNewVersion: vi.fn(), openDiff: vi.fn(), handleRestoreVersion: vi.fn(),
  });

  it("opens the sections it is given and reports every change, so the parent can remember them", () => {
    const onChange = vi.fn();
    render(<ControlsAccordion {...props()} openSections={["versions"]} onOpenSectionsChange={onChange} />);
    expect(screen.getByRole("button", { name: "Versions" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Page Setup" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Page Setup" }));
    expect(onChange).toHaveBeenCalledWith(["versions", "page"]);
  });
});

describe("ControlsRail", () => {
  it("offers one button per section and an expand button", () => {
    const onOpenSection = vi.fn(); const onExpand = vi.fn();
    render(<ControlsRail onOpenSection={onOpenSection} onExpand={onExpand} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Versions" }));
    expect(onOpenSection).toHaveBeenCalledWith("versions");
    fireEvent.click(screen.getByRole("button", { name: "Open Helpers" }));
    expect(onOpenSection).toHaveBeenCalledWith("helpers");
    fireEvent.click(screen.getByRole("button", { name: "Expand controls" }));
    expect(onExpand).toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(6);
  });
});

describe("HelpersPanel", () => {
  it("is a plain reference when there is nowhere to insert", () => {
    render(<HelpersPanel />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("{{currency}}")).toBeInTheDocument();
  });

  it("inserts a helper with the cursor left before the closing braces", () => {
    const onInsert = vi.fn();
    render(<HelpersPanel onInsert={onInsert} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert currency helper" }));
    expect(onInsert).toHaveBeenCalledWith("{{currency }}", 2);
    expect(helperSnippet("upper")).toEqual({ text: "{{upper }}", back: 2 });
  });
});

describe("EditorPane insertAtCursor", () => {
  function Harness({ handle }: { handle: React.RefObject<EditorPaneHandle> }) {
    const [html, setHtml] = useState("<p></p>");
    const [css, setCss] = useState("");
    return (
      <>
        <EditorPane
          ref={handle}
          templateName="Label" htmlCode={html} cssCode={css}
          onHtmlChange={setHtml} onCssChange={setCss}
          readme="" onReadmeChange={() => {}} readmeSaving={false} onSaveReadme={() => {}}
        />
        <output data-testid="html">{html}</output>
      </>
    );
  }

  it("puts the text into the HTML document and updates the page state", async () => {
    const handle = createRef<EditorPaneHandle>();
    render(<Harness handle={handle} />);
    await act(async () => { handle.current!.insertAtCursor("{{upper }}", 2); });
    expect(screen.getByTestId("html").textContent).toContain("{{upper }}");
  });

  it("switches back to the HTML tab first", async () => {
    const handle = createRef<EditorPaneHandle>();
    render(<Harness handle={handle} />);
    const css = screen.getByRole("tab", { name: "CSS" });
    fireEvent.mouseDown(css); fireEvent.click(css);
    await act(async () => { handle.current!.insertAtCursor("x"); });
    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute("data-state", "active");
  });
});
