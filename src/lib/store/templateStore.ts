import { create } from "zustand";
import type { TemplateRow, TemplateVersionRow } from "@/lib/agent/types";

/** A template row in the local store: the canonical IPC shape. */
export type Template = TemplateRow;

/** A version row in the local store: the canonical IPC shape. */
export type TemplateVersion = TemplateVersionRow;

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
      templates: state.templates.map((t) =>
        t.id === id ? { ...t, ...updates } : t,
      ),
      currentTemplate:
        state.currentTemplate?.id === id
          ? { ...state.currentTemplate, ...updates }
          : state.currentTemplate,
    })),
  addVersion: (version) =>
    set((state) => ({ versions: [...state.versions, version] })),
}));
