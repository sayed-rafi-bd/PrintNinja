import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@/lib/i18n";
import { DesignerToolbar } from "@/components/designer/DesignerToolbar";
import { DesignerSidebar } from "@/components/designer/DesignerSidebar";
import { PublishBar } from "@/components/designer/PublishBar";

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

describe("PublishBar", () => {
  const base = { templateName: "Label", publishing: false, onPublish: vi.fn(), onUnpublish: vi.fn() };

  it("shows Draft with a Publish action for an unpublished template", () => {
    render(<PublishBar {...base} remoteId={null} publishedAt={null} templateUpdatedAt={null} />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(base.onPublish).toHaveBeenCalled();
  });

  it("warns once when there are unpublished changes", () => {
    render(<PublishBar {...base} remoteId="r1" publishedAt="2026-01-01T00:00:00Z" templateUpdatedAt="2026-02-01T00:00:00Z" />);
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getAllByText(/changes that aren’t published/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Update published copy" })).toBeInTheDocument();
  });

  it("asks before unpublishing, naming the template", async () => {
    const onUnpublish = vi.fn();
    render(<PublishBar {...base} onUnpublish={onUnpublish} remoteId="r1" publishedAt="2026-02-01T00:00:00Z" templateUpdatedAt="2026-01-01T00:00:00Z" />);
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Unpublish “Label”?")).toBeInTheDocument();
    expect(onUnpublish).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(onUnpublish).toHaveBeenCalled());
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
