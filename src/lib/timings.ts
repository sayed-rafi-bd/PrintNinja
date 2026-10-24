import type { StageTimings } from "@/lib/agent/types";

/** The pipeline stages in the order they run, with the label shown for each. */
export const TIMING_STAGES = [
  { key: "fetch_ms", labelKey: "timing.stage_fetch" },
  { key: "template_ms", labelKey: "timing.stage_template" },
  { key: "layout_ms", labelKey: "timing.stage_layout" },
  { key: "render_ms", labelKey: "timing.stage_render" },
  { key: "send_ms", labelKey: "timing.stage_send" },
  { key: "history_ms", labelKey: "timing.stage_history" },
] as const satisfies ReadonlyArray<{
  key: keyof StageTimings;
  labelKey: string;
}>;

/** Parse a job's stored `timings_json`; null when absent or malformed. */
export function parseTimings(
  json: string | null | undefined,
): StageTimings | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<
      Record<keyof StageTimings, unknown>
    >;
    if (!raw || typeof raw !== "object") return null;
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    return {
      fetch_ms: num(raw.fetch_ms),
      template_ms: num(raw.template_ms),
      layout_ms: num(raw.layout_ms),
      render_ms: num(raw.render_ms),
      send_ms: num(raw.send_ms),
      history_ms: num(raw.history_ms),
      total_ms: num(raw.total_ms),
    };
  } catch {
    return null;
  }
}
