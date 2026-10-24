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

/**
 * Milliseconds as seconds for display. The backend reports whole milliseconds;
 * the conversion happens here. Sub-10 s values keep three decimals so fast
 * stages (7 ms -> "0.007 s") stay distinguishable; longer ones drop to two.
 */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return `${seconds.toFixed(seconds < 10 ? 3 : 2)} s`;
}

/**
 * A stage's share of the whole job. `part` of 0 reads "0%"; anything that
 * would round to 0 reads "<1%" so a real but tiny stage never looks skipped.
 */
export function formatPercent(part: number, whole: number): string {
  if (!(whole > 0) || !(part > 0)) return "0%";
  const pct = (part / whole) * 100;
  if (pct < 1) return "<1%";
  return `${Math.round(Math.min(100, pct))}%`;
}

/**
 * The denominator for stage shares: the recorded total, or the sum of the
 * stages if that is larger (rounding can make stages add up past the total).
 */
export function timingDenominator(timings: StageTimings): number {
  return Math.max(
    timings.total_ms,
    TIMING_STAGES.reduce((sum, s) => sum + timings[s.key], 0),
    1,
  );
}
