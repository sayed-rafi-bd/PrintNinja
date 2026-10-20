import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@/lib/i18n";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { DesignerSidebar } from "@/components/designer/DesignerSidebar";
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

describe("DesignerSidebar", () => {
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

  it("marks the open template and loads another on click", () => {
    const p = props();
    render(<DesignerSidebar {...p} />);
    expect(screen.getByRole("button", { name: /Label/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: /Receipt/ }));
    expect(p.loadTemplate).toHaveBeenCalledWith(p.templates[0]);
  });

  it("applies a page preset and labels its fields", () => {
    const p = props();
    render(<DesignerSidebar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "A4" }));
    expect(p.setPageWidth).toHaveBeenCalledWith(210);
    expect(p.setPageHeight).toHaveBeenCalledWith(297);
    expect(screen.getByLabelText("Width (mm)")).toHaveValue(80);
  });

  it("restores and diffs versions, but not the current one", () => {
    const p = props();
    render(<DesignerSidebar {...p} />);
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
