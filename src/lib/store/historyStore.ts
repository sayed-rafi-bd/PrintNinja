import { create } from "zustand";

import type { HistoryJob as AgentHistoryJob } from "@/lib/agent/types";

/** A print job row: the canonical IPC shape. */
export type HistoryJob = AgentHistoryJob;

export interface HistoryFilter {
  status: string;
  printer: string;
  dateFrom: string;
  dateTo: string;
  search: string;
  source: string;
  isTest: boolean | null;
}

interface HistoryState {
  jobs: HistoryJob[];
  filter: HistoryFilter;
  selectedJob: HistoryJob | null;
  retentionDays: number;
  maxRecords: number;

  setJobs: (jobs: HistoryJob[]) => void;
  setFilter: (filter: Partial<HistoryFilter>) => void;
  setSelectedJob: (job: HistoryJob | null) => void;
  setRetentionDays: (days: number) => void;
  setMaxRecords: (max: number) => void;
  clearFilter: () => void;
}

const defaultFilter: HistoryFilter = {
  status: "all",
  printer: "all",
  dateFrom: "",
  dateTo: "",
  search: "",
  source: "all",
  isTest: null,
};

export const useHistoryStore = create<HistoryState>((set) => ({
  jobs: [],
  filter: defaultFilter,
  selectedJob: null,
  retentionDays: 30,
  maxRecords: 10000,

  setJobs: (jobs) => set({ jobs }),
  setFilter: (filter) => set((state) => ({ filter: { ...state.filter, ...filter } })),
  setSelectedJob: (selectedJob) => set({ selectedJob }),
  setRetentionDays: (retentionDays) => set({ retentionDays }),
  setMaxRecords: (maxRecords) => set({ maxRecords }),
  clearFilter: () => set({ filter: defaultFilter }),
}));
