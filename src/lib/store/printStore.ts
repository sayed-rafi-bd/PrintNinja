import { create } from "zustand";
import type { StageTimings } from "@/lib/agent/types";

export interface PrinterProfile {
  id: number;
  printer_id: number;
  template_id: number;
  settings_json: string;
}

export interface PrintJob {
  id: number;
  status: "queued" | "printing" | "success" | "failed" | "cancelled";
  error?: string;
  duration_ms?: number;
}

interface PrintState {
  printerId: string;
  templateId: string;
  dataUrl: string;
  httpMethod: "GET" | "POST";
  orientation: "portrait" | "landscape";
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  fitMode: "actual" | "fit-width" | "fit-page" | "shrink" | "fill";
  copies: number;
  records: number;
  useTestData: boolean;
  pageRange: string;
  grayscale: boolean;
  /** Explicit paper size in mm; null means the template's design size. */
  paperW: number | null;
  paperH: number | null;
  status: "idle" | "queued" | "printing" | "success" | "failed";
  error: string;
  durationMs: number;
  timings: StageTimings | null;

  setPrinterId: (v: string) => void;
  setTemplateId: (v: string) => void;
  setDataUrl: (v: string) => void;
  setHttpMethod: (v: "GET" | "POST") => void;
  setOrientation: (v: "portrait" | "landscape") => void;
  setMarginTop: (v: number) => void;
  setMarginRight: (v: number) => void;
  setMarginBottom: (v: number) => void;
  setMarginLeft: (v: number) => void;
  setFitMode: (
    v: "actual" | "fit-width" | "fit-page" | "shrink" | "fill",
  ) => void;
  setCopies: (v: number) => void;
  setRecords: (v: number) => void;
  setUseTestData: (v: boolean) => void;
  setPageRange: (v: string) => void;
  setGrayscale: (v: boolean) => void;
  setPaperW: (v: number | null) => void;
  setPaperH: (v: number | null) => void;
  setStatus: (v: "idle" | "queued" | "printing" | "success" | "failed") => void;
  setError: (v: string) => void;
  setDurationMs: (v: number) => void;
  setTimings: (v: StageTimings | null) => void;
}

export const usePrintStore = create<PrintState>((set) => ({
  printerId: "",
  templateId: "",
  dataUrl: "",
  httpMethod: "GET",
  orientation: "portrait",
  marginTop: 5,
  marginRight: 5,
  marginBottom: 5,
  marginLeft: 5,
  fitMode: "fit-width",
  copies: 1,
  records: 1,
  useTestData: false,
  pageRange: "",
  grayscale: false,
  paperW: null,
  paperH: null,
  status: "idle",
  error: "",
  durationMs: 0,
  timings: null,

  setPrinterId: (printerId) => set({ printerId }),
  setTemplateId: (templateId) => set({ templateId }),
  setDataUrl: (dataUrl) => set({ dataUrl }),
  setHttpMethod: (httpMethod) => set({ httpMethod }),
  setOrientation: (orientation) => set({ orientation }),
  setMarginTop: (marginTop) => set({ marginTop }),
  setMarginRight: (marginRight) => set({ marginRight }),
  setMarginBottom: (marginBottom) => set({ marginBottom }),
  setMarginLeft: (marginLeft) => set({ marginLeft }),
  setFitMode: (fitMode) => set({ fitMode }),
  setCopies: (copies) =>
    set({ copies: Math.max(1, Math.floor(Number(copies) || 1)) }),
  setRecords: (records: number) =>
    set({
      records: Math.min(500, Math.max(1, Math.floor(Number(records) || 1))),
    }),
  setUseTestData: (useTestData) => set({ useTestData }),
  setPageRange: (pageRange) => set({ pageRange }),
  setGrayscale: (grayscale) => set({ grayscale }),
  setPaperW: (paperW) => set({ paperW }),
  setPaperH: (paperH) => set({ paperH }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  setDurationMs: (durationMs) => set({ durationMs }),
  setTimings: (timings) => set({ timings }),
}));
