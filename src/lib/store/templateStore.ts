import { create } from "zustand";

export interface Template {
  id: number;
  name: string;
  current_version_id: number | null;
  page_w_mm: number;
  page_h_mm: number;
  orientation: "portrait" | "landscape";
  readme: string;
  summary: string;
  remote_id: string | null;
  published_at: string | null;
  origin: string;
  origin_owner: string | null;
  withdrawn: boolean;
  created_at: string;
  updated_at: string;
}

export interface TemplateVersion {
  id: number;
  template_id: number;
  version_no: number;
  html: string;
  css: string;
  label: string | null;
  note: string | null;
  created_at: string;
  created_by: string;
  /** Tailwind CSS compiled from `html`; empty if not compiled yet. */
  compiled_css?: string;
  compiled_key?: string;
}

export interface SampleDataset {
  id: number;
  template_id: number;
  name: string;
  json: string;
  is_default: boolean;
}

interface TemplateState {
  templates: Template[];
  currentTemplate: Template | null;
  versions: TemplateVersion[];
  currentVersion: TemplateVersion | null;
  datasets: SampleDataset[];
  selectedDataset: SampleDataset | null;
  zoom: number;
  dirty: boolean;

  setTemplates: (templates: Template[]) => void;
  setCurrentTemplate: (template: Template | null) => void;
  setVersions: (versions: TemplateVersion[]) => void;
  setCurrentVersion: (version: TemplateVersion | null) => void;
  setDatasets: (datasets: SampleDataset[]) => void;
  setSelectedDataset: (dataset: SampleDataset | null) => void;
  setZoom: (zoom: number) => void;
  setDirty: (dirty: boolean) => void;
  updateTemplate: (id: number, updates: Partial<Template>) => void;
  addVersion: (version: TemplateVersion) => void;
}

export const useTemplateStore = create<TemplateState>((set) => ({
  templates: [],
  currentTemplate: null,
  versions: [],
  currentVersion: null,
  datasets: [],
  selectedDataset: null,
  zoom: 1,
  dirty: false,

  setTemplates: (templates) => set({ templates }),
  setCurrentTemplate: (currentTemplate) => set({ currentTemplate }),
  setVersions: (versions) => set({ versions }),
  setCurrentVersion: (currentVersion) => set({ currentVersion }),
  setDatasets: (datasets) => set({ datasets }),
  setSelectedDataset: (selectedDataset) => set({ selectedDataset }),
  setZoom: (zoom) => set({ zoom }),
  setDirty: (dirty) => set({ dirty }),
  updateTemplate: (id, updates) =>
    set((state) => ({
      templates: state.templates.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      currentTemplate:
        state.currentTemplate?.id === id
          ? { ...state.currentTemplate, ...updates }
          : state.currentTemplate,
    })),
  addVersion: (version) =>
    set((state) => ({ versions: [...state.versions, version] })),
}));
