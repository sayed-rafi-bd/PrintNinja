import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getTemplateError } from "@/lib/render/renderTemplate";
import { cn } from "@/lib/utils";
import { CanvasPane } from "./CanvasPane";

/** CSS pixels per millimetre at 96 dpi. */
export const MM_TO_PX = 3.7795;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** The zoom levels offered in the picker, besides Fit. */
const ZOOM_PRESETS = [0.5, 1];
/** Space kept around the page inside the scroll area (Tailwind p-4, both sides). */
const PAD_X = 32;

type ZoomMode = "fit" | number;

/** The zoom that makes the page exactly as wide as the space it has, never above 100%. */
export function fitZoom(availableWidth: number, pageWidthPx: number): number {
  // Width is 0 before the first measurement (and in jsdom): show the page at full size.
  if (availableWidth <= 0 || pageWidthPx <= 0) return 1;
  return Math.min(
    1,
    Math.max(MIN_ZOOM, (availableWidth - PAD_X) / pageWidthPx),
  );
}

/** The next zoom step above or below `zoom`, or `zoom` itself at the end of the range. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const eps = 0.001;
  if (direction > 0) return ZOOM_STEPS.find((s) => s > zoom + eps) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < zoom - eps) ?? MIN_ZOOM;
}

interface Props {
  html: string;
  css: string;
  compiledCss: string;
  data: Record<string, unknown>;
  pageWidthMm: number;
  pageHeightMm: number;
  /** Fill the height of the parent and scroll inside (desktop); otherwise a fixed minimum height. */
  fill?: boolean;
  className?: string;
}

/** The canvas with its toolbar: Fit, −, zoom %, +. Owns the zoom, which starts on Fit. */
export function CanvasWorkspace({
  html,
  css,
  compiledCss,
  data,
  pageWidthMm,
  pageHeightMm,
  fill = false,
  className,
}: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ZoomMode>("fit");
  const [areaWidth, setAreaWidth] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setAreaWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageWidth = pageWidthMm * MM_TO_PX;
  const pageHeight = pageHeightMm * MM_TO_PX;
  const zoom = mode === "fit" ? fitZoom(areaWidth, pageWidth) : mode;
  const pct = Math.round(zoom * 100);
  // While the template is momentarily invalid (an unclosed {{#each}}, say) the
  // page below shows the raw source; this says why.
  const error = useMemo(() => getTemplateError(html, data), [html, data]);

  const isPreset = mode !== "fit" && ZOOM_PRESETS.includes(mode);
  const selectValue =
    mode === "fit" ? "fit" : isPreset ? String(mode) : "custom";

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card",
        fill && "h-full",
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">{t("designer.canvas")}</span>
        <div className="flex items-center gap-1">
          <Select
            value={selectValue}
            onValueChange={(v) => {
              if (v === "fit") setMode("fit");
              else if (v !== "custom") setMode(Number(v));
            }}
          >
            <SelectTrigger aria-label="Zoom level" className="h-8 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fit">Fit</SelectItem>
              {ZOOM_PRESETS.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {Math.round(p * 100)}%
                </SelectItem>
              ))}
              {selectValue === "custom" && (
                <SelectItem value="custom">{pct}%</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom <= MIN_ZOOM + 0.001}
            onClick={() => setMode(stepZoom(zoom, -1))}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="w-12 text-center text-xs" aria-live="polite">
            {pct}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= MAX_ZOOM - 0.001}
            onClick={() => setMode(stepZoom(zoom, 1))}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 break-words">
            <strong className="font-semibold">Template error:</strong> {error}
          </span>
        </div>
      )}
      {/* m-auto centres a small page and still lets a large one scroll to its left edge.
          The stable gutter stops a scrollbar appearing and re-fitting the page in a loop. */}
      <div
        ref={scrollRef}
        className={cn(
          "flex overflow-auto bg-muted p-4 [scrollbar-gutter:stable]",
          fill ? "min-h-0 flex-1" : "min-h-[500px]",
        )}
      >
        <div className="m-auto">
          <CanvasPane
            html={html}
            css={css}
            compiledCss={compiledCss}
            data={data}
            width={pageWidth}
            height={pageHeight}
            zoom={zoom}
          />
        </div>
      </div>
    </div>
  );
}
