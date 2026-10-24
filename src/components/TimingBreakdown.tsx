import { useTranslation } from "react-i18next";
import {
  TIMING_STAGES,
  formatPercent,
  formatSeconds,
  timingDenominator,
} from "@/lib/timings";
import type { StageTimings } from "@/lib/agent/types";
import { cn } from "@/lib/utils";

/**
 * Where a print job's time went. `inline` is a compact wrapped line for alerts
 * and table cells; `list` is a labelled row per stage with a share-of-total
 * bar, for the history detail dialog.
 */
export function TimingBreakdown({
  timings,
  variant = "inline",
  className,
}: {
  timings: StageTimings;
  variant?: "inline" | "list";
  className?: string;
}) {
  const { t } = useTranslation();
  if (variant === "list") {
    const denom = timingDenominator(timings);
    return (
      <div
        className={cn("space-y-1.5", className)}
        data-testid="timing-breakdown"
      >
        {TIMING_STAGES.map((s) => {
          const value = timings[s.key];
          return (
            <div
              key={s.key}
              className="grid grid-cols-[7rem_1fr_4.5rem_3rem] items-center gap-2 text-sm"
            >
              <span className="text-muted-foreground">{t(s.labelKey)}</span>
              <div
                className="h-1.5 overflow-hidden rounded-sm bg-muted"
                aria-hidden="true"
              >
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.min(100, (value / denom) * 100)}%` }}
                />
              </div>
              <span className="text-right tabular-nums">
                {formatSeconds(value)}
              </span>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatPercent(value, denom)}
              </span>
            </div>
          );
        })}
        <div className="grid grid-cols-[7rem_1fr_4.5rem_3rem] items-center gap-2 border-t pt-1.5 text-sm font-medium">
          <span>{t("common.total")}</span>
          <span />
          <span className="text-right tabular-nums">
            {formatSeconds(timings.total_ms)}
          </span>
          <span />
        </div>
      </div>
    );
  }

  const denom = timingDenominator(timings);
  return (
    <p
      className={cn(
        "flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums",
        className,
      )}
      data-testid="timing-breakdown"
    >
      <span className="font-medium">
        {t("common.total")} {formatSeconds(timings.total_ms)}
      </span>
      {TIMING_STAGES.map((s) => (
        <span key={s.key}>
          {t(s.labelKey)} {formatSeconds(timings[s.key])}{" "}
          <span className="opacity-70">
            ({formatPercent(timings[s.key], denom)})
          </span>
        </span>
      ))}
    </p>
  );
}
