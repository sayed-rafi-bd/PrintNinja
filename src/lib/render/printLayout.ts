/**
 * Design → paper layout for the Print page preview.
 *
 * A template is authored on a fixed design page (the Designer canvas, e.g.
 * 102 × 102 mm). It is never re-laid out at another size: each record is
 * rendered once at exactly the design size and that finished page is scaled
 * and positioned on the sheet according to the print settings. This is the
 * TypeScript half of `src-tauri/src/render/layout.rs`; both are pinned to
 * `src-tauri/tests/fixtures/layout_cases.json`, so the preview shows what the
 * PDF will contain. Keep the two in step.
 *
 * All lengths are millimetres.
 */

/** Same cap as `MAX_SHEETS_PER_DESIGN` in layout.rs. */
export const MAX_SHEETS_PER_DESIGN = 200;

export type FitMode = "actual" | "fit-width" | "fit-page" | "shrink" | "fill";

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Where one design page sits on one sheet, relative to the content box. */
export interface Placement {
  offsetX: number;
  offsetY: number;
}

export interface PrintLayout {
  /** Printable area on the sheet (paper minus margins). */
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
  /** Design → paper scale; uniform, so the aspect ratio is kept. */
  scale: number;
  drawW: number;
  drawH: number;
  /** One entry per sheet a single design page occupies. */
  placements: Placement[];
}

/**
 * How each fit mode maps the design onto the content box:
 *
 * - `actual`    – 1:1, top-left; a taller design continues on the next sheet.
 * - `fit-width` – scaled to the content width, top-left; continues on the next
 *   sheet when taller than the content box (the default).
 * - `fit-page`  – largest scale at which the whole design fits; centred.
 * - `fill`      – smallest scale that covers the content box; centred and
 *   cropped to it.
 * - `shrink`    – like `fit-page` but never enlarges; centred.
 */
function scaleFor(
  fitMode: string,
  dw: number,
  dh: number,
  pcw: number,
  pch: number,
): number {
  switch (fitMode) {
    case "actual":
      return 1;
    case "fit-page":
      return Math.min(pcw / dw, pch / dh);
    case "fill":
      return Math.max(pcw / dw, pch / dh);
    case "shrink":
      return Math.min(pcw / dw, pch / dh, 1);
    default:
      return pcw / dw; // fit-width (default)
  }
}

/** Place a `designW` × `designH` page on a `paperW` × `paperH` sheet. */
export function computePrintLayout(
  fitMode: string,
  designW: number,
  designH: number,
  paperW: number,
  paperH: number,
  margins: Margins,
): PrintLayout {
  const dw = Math.max(1, designW);
  const dh = Math.max(1, designH);
  const pcw = Math.max(1, paperW - margins.left - margins.right);
  const pch = Math.max(1, paperH - margins.top - margins.bottom);

  const scale = scaleFor(fitMode, dw, dh, pcw, pch);
  const drawW = dw * scale;
  const drawH = dh * scale;

  let placements: Placement[];
  if (fitMode === "fit-page" || fitMode === "fill" || fitMode === "shrink") {
    placements = [{ offsetX: (pcw - drawW) / 2, offsetY: (pch - drawH) / 2 }];
  } else {
    // Epsilon: a design exactly one content box tall is one sheet, not two.
    const sheets = Math.min(
      MAX_SHEETS_PER_DESIGN,
      Math.max(1, Math.ceil((drawH - 1e-6) / pch)),
    );
    placements = Array.from({ length: sheets }, (_, k) => ({
      offsetX: 0,
      offsetY: k === 0 ? 0 : -k * pch,
    }));
  }

  return {
    contentX: margins.left,
    contentY: margins.top,
    contentW: pcw,
    contentH: pch,
    scale,
    drawW,
    drawH,
    placements,
  };
}

/**
 * Paper geometry from a design size plus an optional explicit paper size:
 * explicit wins per axis, then the design size. The paper is swapped for
 * landscape; the design never is. Mirrors `effective_geometry` in print.rs.
 */
export function resolvePaper(
  designW: number,
  designH: number,
  orientation: "portrait" | "landscape",
  reqW?: number | null,
  reqH?: number | null,
): { paperW: number; paperH: number } {
  const baseW = reqW ?? designW;
  const baseH = reqH ?? designH;
  return orientation === "landscape"
    ? { paperW: baseH, paperH: baseW }
    : { paperW: baseW, paperH: baseH };
}
