import { useEffect, useMemo, useRef, useState } from "react";
import { computePrintLayout, type Margins } from "@/lib/render/printLayout";

/** CSS pixels per millimetre at 96 dpi (same constant the Designer canvas uses). */
const MM_TO_PX = 3.7795;

/** Space around the sheets inside the scroll area (Tailwind p-4, both sides). */
const PAD_X = 32;

/** A very tall design on a big record count must not mount hundreds of frames. */
export const MAX_PREVIEW_SHEETS = 24;

interface Props {
  /**
   * One complete HTML document per record, each laid out as the Designer
   * canvas lays it out (no paper, no margins, no scaling).
   */
  pages: string[];
  /** The template's design size, mm. Never swapped for orientation. */
  designW: number;
  designH: number;
  /** The physical sheet, mm, already swapped for landscape. */
  paperW: number;
  paperH: number;
  margins: Margins;
  fitMode: string;
  grayscale?: boolean;
  /** Accessible name of the first sheet; later sheets get their number. */
  title: string;
}

/**
 * What will come out of the printer: every record's design page, shown at the
 * design's own size and then scaled and positioned on a sheet of the selected
 * paper by the same rules the PDF uses (`computePrintLayout`, mirrored by
 * `render::layout::compute` in Rust). The design is never re-laid out at the
 * paper size, so its aspect ratio and line breaks match the Designer.
 */
export function PrintPreview({
  pages,
  designW,
  designH,
  paperW,
  paperH,
  margins,
  fitMode,
  grayscale = false,
  title,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setHostWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { top, right, bottom, left } = margins;
  const layout = useMemo(
    () =>
      computePrintLayout(fitMode, designW, designH, paperW, paperH, {
        top,
        right,
        bottom,
        left,
      }),
    [fitMode, designW, designH, paperW, paperH, top, right, bottom, left],
  );

  const sheets = useMemo(() => {
    const out: { doc: string; offsetX: number; offsetY: number }[] = [];
    for (const doc of pages) {
      for (const p of layout.placements) {
        if (out.length >= MAX_PREVIEW_SHEETS) return out;
        out.push({ doc, offsetX: p.offsetX, offsetY: p.offsetY });
      }
    }
    return out;
  }, [pages, layout]);

  const paperWpx = paperW * MM_TO_PX;
  const paperHpx = paperH * MM_TO_PX;
  // Shrink a wide sheet to the space it has; never enlarge it. Width is 0
  // before the first measurement (and in jsdom): show the sheet at full size.
  const shown = hostWidth > 0 ? Math.min(1, (hostWidth - PAD_X) / paperWpx) : 1;
  const display = Math.max(0.05, shown);

  return (
    <div
      ref={hostRef}
      data-testid="print-preview"
      data-fit-mode={fitMode}
      data-scale={layout.scale.toFixed(4)}
      className="flex flex-col items-center gap-4"
    >
      {sheets.map((sheet, i) => (
        <div
          key={i}
          data-testid="print-sheet"
          className="relative shrink-0 bg-white shadow-md ring-1 ring-border"
          // The outer box takes the scaled size so scrolling matches what is drawn.
          style={{ width: paperWpx * display, height: paperHpx * display }}
        >
          <div
            className="relative"
            style={{
              width: paperWpx,
              height: paperHpx,
              transform: `scale(${display})`,
              transformOrigin: "top left",
              filter: grayscale ? "grayscale(1)" : undefined,
            }}
          >
            {/* The printable area: paper minus margins. Anything the fit mode
                pushes outside it (fill's crop, the next sheet's slice) is cut
                off here, as it is in the PDF. */}
            <div
              className="absolute overflow-hidden"
              style={{
                left: layout.contentX * MM_TO_PX,
                top: layout.contentY * MM_TO_PX,
                width: layout.contentW * MM_TO_PX,
                height: layout.contentH * MM_TO_PX,
              }}
            >
              <iframe
                srcDoc={sheet.doc}
                sandbox=""
                title={i === 0 ? title : `${title} ${i + 1}`}
                className="pointer-events-none absolute border-0"
                style={{
                  left: sheet.offsetX * MM_TO_PX,
                  top: sheet.offsetY * MM_TO_PX,
                  // The frame is the design's own size, like the Designer
                  // canvas; only the transform scales it onto the paper.
                  width: designW * MM_TO_PX,
                  height: designH * MM_TO_PX,
                  transform: `scale(${layout.scale})`,
                  transformOrigin: "top left",
                }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
