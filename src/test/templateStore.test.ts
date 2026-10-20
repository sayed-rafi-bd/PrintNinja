import { describe, it, expect, beforeEach } from "vitest";
import { useTemplateStore } from "@/lib/store/templateStore";

describe("templateStore", () => {
  beforeEach(() => {
    useTemplateStore.setState({
      templates: [],
      currentTemplate: null,
      versions: [],
      currentVersion: null,
      datasets: [],
      selectedDataset: null,
      zoom: 1,
      dirty: false,
    });
  });

  it("starts with empty templates", () => {
    expect(useTemplateStore.getState().templates).toEqual([]);
  });

  it("setZoom updates zoom level", () => {
    useTemplateStore.getState().setZoom(2);
    expect(useTemplateStore.getState().zoom).toBe(2);
  });

  it("setDirty marks template as dirty", () => {
    useTemplateStore.getState().setDirty(true);
    expect(useTemplateStore.getState().dirty).toBe(true);
  });

  it("updateTemplate modifies existing template", () => {
    const template = { id: 1, name: "Test", current_version_id: null, page_w_mm: 210, page_h_mm: 297, orientation: "portrait" as const, readme: "", summary: "", remote_id: null, server_id: null, published_at: null, origin: "own", origin_owner: null, withdrawn: false, created_at: "", updated_at: "" };
    useTemplateStore.getState().setTemplates([template]);
    useTemplateStore.getState().updateTemplate(1, { name: "Updated" });
    expect(useTemplateStore.getState().templates[0].name).toBe("Updated");
  });

  it("setCurrentTemplate updates current template", () => {
    const template = { id: 1, name: "Test", current_version_id: null, page_w_mm: 210, page_h_mm: 297, orientation: "portrait" as const, readme: "", summary: "", remote_id: null, server_id: null, published_at: null, origin: "own", origin_owner: null, withdrawn: false, created_at: "", updated_at: "" };
    useTemplateStore.getState().setCurrentTemplate(template);
    expect(useTemplateStore.getState().currentTemplate?.name).toBe("Test");
  });
});
