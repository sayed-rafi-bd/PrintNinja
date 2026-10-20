import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@/lib/i18n";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { ControlsAccordion } from "@/components/designer/ControlsAccordion";
import { CanvasPane } from "@/components/designer/CanvasPane";
import { CodeEditors, EditorPane } from "@/components/designer/EditorPane";
import { CanvasWorkspace, MM_TO_PX, fitZoom, stepZoom } from "@/components/designer/CanvasWorkspace";
import { SampleDataPanel } from "@/components/designer/SampleDataPanel";
import { TemplateSyncBar } from "@/components/designer/TemplateSyncBar";

beforeAll(() => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.scrollIntoView = () => {};
});

describe("DesignerToolbar", () => {
  it("fires New and Export, and passes a chosen file to Import", async () => {
    const onNew = vi.fn(); const onExport = vi.fn(); const onImportFile = vi.fn();
    render(<DesignerToolbar onNew={onNew} onImportFile={onImportFile} onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onNew).toHaveBeenCalled();
    expect(onExport).toHaveBeenCalled();
    const file = new File(["{}"], "t.json", { type: "application/json" });
    fireEvent.change(screen.getByTestId("template-import"), { target: { files: [file] } });
    await waitFor(() => expect(onImportFile).toHaveBeenCalledWith(file));
  });
});

describe("TemplateSyncBar", () => {
  const base = {
    templateName: "Label",
    pending: null,
    onSave: vi.fn(),
    onRefresh: vi.fn(),
    onPublish: vi.fn(),
    onUnpublish: vi.fn(),
  };

  it("saves a template that is only on this computer, and offers Publish", () => {
    render(<TemplateSyncBar {...base} remoteId={null} publishedAt={null} templateUpdatedAt={null} />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Only on this computer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save to server" }));
    expect(base.onSave).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Publish to Community" }));
    expect(base.onPublish).toHaveBeenCalled();
  });

  it("offers Refresh and Unpublish once a template is published", () => {
    render(<TemplateSyncBar {...base} remoteId="r1" publishedAt="2026-02-01T00:00:00Z" templateUpdatedAt="2026-01-01T00:00:00Z" />);
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh from server/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish/ })).not.toBeInTheDocument();
  });

  it("says when a private template is saved but not published", () => {
    render(<TemplateSyncBar {...base} remoteId="r1" publishedAt={null} templateUpdatedAt="2026-02-01T00:00:00Z" />);
    expect(screen.getByText(/private copy/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish to Community" })).toBeInTheDocument();
  });

  it("warns once when local changes are not on the server yet", () => {
    render(<TemplateSyncBar {...base} remoteId="r1" publishedAt="2026-01-01T00:00:00Z" templateUpdatedAt="2026-02-01T00:00:00Z" />);
    expect(screen.getAllByText(/not on the server yet/)).toHaveLength(1);
  });

  it("asks before refreshing, naming the template", async () => {
    render(<TemplateSyncBar {...base} remoteId="r1" publishedAt="2026-02-01T00:00:00Z" templateUpdatedAt="2026-02-01T00:00:00Z" />);
    fireEvent.click(screen.getByRole("button", { name: /Refresh from server/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Refresh “Label” from the server?")).toBeInTheDocument();
    expect(base.onRefresh).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh template" }));
    await waitFor(() => expect(base.onRefresh).toHaveBeenCalled());
  });

  it("asks before unpublishing, naming the template", async () => {
    const onUnpublish = vi.fn();
    render(<TemplateSyncBar {...base} onUnpublish={onUnpublish} remoteId="r1" publishedAt="2026-02-01T00:00:00Z" templateUpdatedAt="2026-01-01T00:00:00Z" />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Unpublish “Label”?")).toBeInTheDocument();
    expect(onUnpublish).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(onUnpublish).toHaveBeenCalled());
  });

  it("hides Save and Publish on a saved copy from Community", () => {
    render(<TemplateSyncBar {...base} readOnly remoteId="x1" publishedAt="2026-02-01T00:00:00Z" templateUpdatedAt="2026-02-01T00:00:00Z" />);
    expect(screen.getByText("Read-only copy")).toBeInTheDocument();
    expect(screen.getByText(/can print it, but not change it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save to server" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish/ })).not.toBeInTheDocument();
  });
});

describe("ControlsAccordion", () => {
  const versions = [
    { id: 2, version_no: 2, label: "second", note: "", created_at: "2026-02-01T10:00:00Z" },
    { id: 1, version_no: 1, label: "first", note: "", created_at: "2026-01-01T10:00:00Z" },
  ] as any;
  const props = () => ({
    templates: [{ id: 1, name: "Receipt" }, { id: 2, name: "Label" }],
    currentTemplateId: 2, loadTemplate: vi.fn(),
    templateName: "Label", setTemplateName: vi.fn(),
    pageWidth: 80, setPageWidth: vi.fn(), pageHeight: 200, setPageHeight: vi.fn(),
    presets: [{ label: "A4", width: 210, height: 297 }],
    orientation: "portrait" as const, setOrientation: vi.fn(),
    versions, onNewVersion: vi.fn(), openDiff: vi.fn(), handleRestoreVersion: vi.fn(),
  });

  const ALL_OPEN = ["templates", "page", "sample-data", "versions", "helpers"];

  it("opens only Page Setup at first, and opens and closes sections on click", () => {
    render(<ControlsAccordion {...props()} />);
    const trigger = (name: string) => screen.getByRole("button", { name });
    expect(trigger("Page Setup")).toHaveAttribute("aria-expanded", "true");
    for (const name of ["Templates", "Versions", "Helpers"]) {
      expect(trigger(name)).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.getByLabelText("Width (mm)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Receipt/ })).not.toBeInTheDocument();
    // Several sections can be open at once.
    fireEvent.click(trigger("Templates"));
    expect(screen.getByRole("button", { name: /Receipt/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Width (mm)")).toBeInTheDocument();
    fireEvent.click(trigger("Page Setup"));
    expect(screen.queryByLabelText("Width (mm)")).not.toBeInTheDocument();
  });

  it("starts fully collapsed when asked to, as on a phone", () => {
    render(<ControlsAccordion {...props()} defaultOpen={[]} showHelpers={false} />);
    for (const name of ["Templates", "Page Setup", "Versions"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.queryByRole("button", { name: "Helpers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sample data" })).not.toBeInTheDocument();
  });

  it("shows the sample data and helpers sections when given them", () => {
    render(<ControlsAccordion {...props()} defaultOpen={ALL_OPEN} sampleData={<p>datasets here</p>} />);
    expect(screen.getByRole("button", { name: "Sample data" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("datasets here")).toBeInTheDocument();
    expect(screen.getByText("Available helpers:")).toBeInTheDocument();
  });

  it("marks the open template and loads another on click", () => {
    const p = props();
    render(<ControlsAccordion {...p} defaultOpen={ALL_OPEN} />);
    expect(screen.getByRole("button", { name: /Label/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: /Receipt/ }));
    expect(p.loadTemplate).toHaveBeenCalledWith(p.templates[0]);
  });

  it("applies a page preset and labels its fields", () => {
    const p = props();
    render(<ControlsAccordion {...p} defaultOpen={ALL_OPEN} />);
    fireEvent.click(screen.getByRole("button", { name: "A4" }));
    expect(p.setPageWidth).toHaveBeenCalledWith(210);
    expect(p.setPageHeight).toHaveBeenCalledWith(297);
    expect(screen.getByLabelText("Width (mm)")).toHaveValue(80);
  });

  it("restores and diffs versions, but not the current one", () => {
    const p = props();
    render(<ControlsAccordion {...p} defaultOpen={ALL_OPEN} />);
    expect(screen.getByRole("button", { name: "Restore version 2" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Restore version 1" }));
    expect(p.handleRestoreVersion).toHaveBeenCalledWith(versions[1]);
    fireEvent.click(screen.getByRole("button", { name: "Diff v1 to v2" }));
    expect(p.openDiff).toHaveBeenCalledWith(versions[1], versions[0]);
  });
});

describe("ClassWarnings", () => {
  it("renders nothing for a template without data-built classes", async () => {
    const { ClassWarnings } = await import("@/components/designer/ClassWarnings");
    const { container } = render(
      <ClassWarnings html={`<p class="p-2 {{#if a}}flex{{else}}grid{{/if}}">x</p>`} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the line and the offending class, and explains the fix", async () => {
    const { ClassWarnings } = await import("@/components/designer/ClassWarnings");
    render(<ClassWarnings html={`<p>one</p>\n<b class="p-2 bg-{{color}}-500">x</b>`} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("1 class name is built from data");
    expect(alert).toHaveTextContent("Line 2:");
    expect(alert).toHaveTextContent("bg-{{color}}-500");
    expect(alert).toHaveTextContent(/every branch/);
    expect(alert).toHaveTextContent(/CSS variable/);
  });

  it("counts several and caps the list", async () => {
    const { ClassWarnings } = await import("@/components/designer/ClassWarnings");
    const rows = Array.from({ length: 7 }, (_, i) => `<i class="m-{{n${i}}}">x</i>`).join("\n");
    render(<ClassWarnings html={rows} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("7 class names are built from data");
    expect(alert).toHaveTextContent("…and 2 more");
    expect(within(alert).getAllByText(/^Line \d+:/)).toHaveLength(5);
  });

  it("updates when the template is fixed", async () => {
    const { ClassWarnings } = await import("@/components/designer/ClassWarnings");
    const { rerender, container } = render(<ClassWarnings html={`<b class="bg-{{c}}">x</b>`} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<ClassWarnings html={`<b class="{{#if c}}bg-red-600{{else}}bg-green-600{{/if}}">x</b>`} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CanvasPane", () => {
  const base = { html: "<p>Hi {{store.name}}</p>", css: "", compiledCss: "", width: 302, height: 756 };

  it("renders the template with the sample data into a sandboxed frame", () => {
    render(<CanvasPane {...base} data={{ store: { name: "Ninja Mart" } }} />);
    const frame = screen.getByTitle("Canvas preview") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("Hi Ninja Mart");
  });

  it("re-renders when the sample data changes and sizes the page from width and height", () => {
    const { rerender } = render(<CanvasPane {...base} data={{ store: { name: "One" } }} />);
    rerender(<CanvasPane {...base} data={{ store: { name: "Two" } }} width={100} height={200} />);
    const frame = screen.getByTitle("Canvas preview");
    expect(frame.getAttribute("srcdoc")).toContain("Hi Two");
    expect(frame.parentElement).toHaveStyle({ width: "100px", height: "200px" });
  });

  it("scales the page instead of resizing it, so zooming never reflows the template", () => {
    render(<CanvasPane {...base} data={{}} width={400} height={800} zoom={0.5} />);
    const frame = screen.getByTitle("Canvas preview");
    // The page keeps its true size and is scaled; the box around it takes the scaled size.
    expect(frame.parentElement).toHaveStyle({ width: "400px", height: "800px", transform: "scale(0.5)" });
    expect(frame.parentElement?.parentElement).toHaveStyle({ width: "200px", height: "400px" });
  });
});

describe("zoom maths", () => {
  it("fits the page to the width it has, never above 100%", () => {
    // 600 px of space, 32 px of it padding, against a 568 px page: exactly 100%.
    expect(fitZoom(600, 568)).toBe(1);
    expect(fitZoom(2000, 302)).toBe(1);
    // An A4 page (794 px) in 500 px of space.
    expect(fitZoom(500, 794)).toBeCloseTo((500 - 32) / 794, 5);
  });

  it("shows the page at full size before it has been measured, and never goes below 25%", () => {
    expect(fitZoom(0, 794)).toBe(1);
    expect(fitZoom(100, 794)).toBe(0.25);
  });

  it("steps to the next zoom level up or down, and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.63, 1)).toBe(0.75);
    expect(stepZoom(0.63, -1)).toBe(0.5);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });
});

describe("CanvasWorkspace", () => {
  const props = { html: "<p>Hi</p>", css: "", compiledCss: "", data: {}, pageWidthMm: 80, pageHeightMm: 200 };
  const pageBox = () => screen.getByTitle("Canvas preview").parentElement as HTMLElement;
  // The picker repeats the percentage once it is off Fit, so read the live readout next to the buttons.
  const readout = () => document.querySelector("[aria-live=polite]") as HTMLElement;

  it("starts on Fit, with zoom controls in its own toolbar", () => {
    render(<CanvasWorkspace {...props} />);
    expect(screen.getByRole("combobox", { name: "Zoom level" })).toHaveTextContent("Fit");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeInTheDocument();
    expect(readout()).toHaveTextContent("100%");
  });

  it("zooms out and in by steps, leaving Fit", () => {
    render(<CanvasWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(readout()).toHaveTextContent("75%");
    expect(screen.getByRole("combobox", { name: "Zoom level" })).toHaveTextContent("75%");
    // The page is laid out at its true size (80 mm) and scaled.
    expect(pageBox()).toHaveStyle({ width: `${80 * MM_TO_PX}px`, transform: "scale(0.75)" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(readout()).toHaveTextContent("125%");
  });

  it("offers Fit, 50% and 100% in the zoom picker", async () => {
    render(<CanvasWorkspace {...props} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Zoom level" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Fit", "50%", "100%"]);
    fireEvent.click(screen.getByRole("option", { name: "50%" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Zoom level" })).toHaveTextContent("50%"));
    expect(pageBox()).toHaveStyle({ transform: "scale(0.5)" });
  });

  it("fills its parent when asked, so the page does not scroll", () => {
    const { container } = render(<CanvasWorkspace {...props} fill />);
    expect(container.firstElementChild).toHaveClass("h-full");
  });
});

describe("CodeEditors", () => {
  it("labels the HTML editor with the template name, and has a CSS editor", () => {
    render(<CodeEditors templateName="Label" htmlCode="<b>x</b>" cssCode="b{}" onHtmlChange={vi.fn()} onCssChange={vi.fn()} />);
    expect(screen.getByText("HTML — Label")).toBeInTheDocument();
    expect(screen.getByText("CSS")).toBeInTheDocument();
  });
});

describe("EditorPane", () => {
  const props = () => ({
    templateName: "Label", htmlCode: "<b>x</b>", cssCode: "b{}",
    onHtmlChange: vi.fn(), onCssChange: vi.fn(),
    readme: "# Label docs", onReadmeChange: vi.fn(), readmeSaving: false, onSaveReadme: vi.fn(),
  });
  // Radix Tabs switch on mousedown, not click.
  const openTab = (name: string) => {
    const tab = screen.getByRole("tab", { name });
    fireEvent.mouseDown(tab, { button: 0 });
    fireEvent.click(tab);
  };

  it("has HTML, CSS and README tabs, starting on HTML", () => {
    render(<EditorPane {...props()} />);
    const names = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(names).toEqual(["HTML", "CSS", "README"]);
    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps both code editors mounted, so a tab switch does not lose the cursor or undo history", () => {
    const { container } = render(<EditorPane {...props()} />);
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(2);
    openTab("CSS");
    expect(screen.getByRole("tab", { name: "CSS" })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelectorAll(".cm-editor")).toHaveLength(2);
  });

  it("shows the README editor and its Save button on the README tab", () => {
    const p = props();
    render(<EditorPane {...p} />);
    expect(screen.queryByText(/README — Label/)).not.toBeInTheDocument();
    openTab("README");
    expect(screen.getByText("README — Label")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save README" }));
    expect(p.onSaveReadme).toHaveBeenCalled();
  });

  it("shows notices under the HTML and CSS tabs, but not the README", () => {
    render(<EditorPane {...props()} notices={<p>watch out</p>} />);
    expect(screen.getByText("watch out")).toBeInTheDocument();
    openTab("CSS");
    expect(screen.getByText("watch out")).toBeInTheDocument();
    openTab("README");
    expect(screen.queryByText("watch out")).not.toBeInTheDocument();
  });
});

describe("SampleDataPanel", () => {
  const datasets = [
    { name: "Sample Order", json: '{"store":{"name":"A"},"items":[]}', isDefault: true },
    { name: "Empty", json: "{}", isDefault: false },
  ];
  const props = () => ({ datasets, selectedName: "Sample Order", onSelect: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() });

  it("picks the dataset the canvas uses, and lists its fields", () => {
    const p = props();
    render(<SampleDataPanel {...p} />);
    expect(screen.getByRole("radio", { name: "Use dataset Sample Order" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Use dataset Empty" }));
    expect(p.onSelect).toHaveBeenCalledWith("Empty");
    expect(screen.getAllByText("{{store}}").length).toBeGreaterThan(0);
  });

  it("adds, edits and deletes datasets, but never deletes the default one", () => {
    const p = props();
    render(<SampleDataPanel {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Add Dataset/ }));
    expect(p.onAdd).toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    expect(p.onEdit).toHaveBeenCalledWith(datasets[1]);
    expect(screen.getByRole("button", { name: "Delete dataset Sample Order" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete dataset Empty" }));
    expect(p.onDelete).toHaveBeenCalledWith(datasets[1]);
  });
});
