import { toSVG } from "bwip-js";

export interface BarcodeOptions {
  type: string;
  value: string;
  /** Bar height in mm (bwip-js `height`). */
  height?: number;
  /**
   * Not passed to bwip-js. Its `width` is the width of the WHOLE symbol in mm,
   * so `width: 2` squeezed every barcode into 2 mm and the bars overlapped into
   * a solid black block. The printed size comes from `scaleToWidth`.
   */
  width?: number;
  /** Render the human-readable text under the bars. */
  text?: boolean;
  /** Output width in mm; omit to let bwip-js decide. */
  scaleToWidth?: number;
}

/**
 * Generate an inline SVG barcode.
 *
 * PLANNING.md 7.5 requires *inline SVG* so the rendered template needs no
 * scripts and no external image files.
 *
 * NOTE: the previous implementation drew onto a `<canvas>` and then called
 * `canvas.toDataURL("image/svg+xml")`. A canvas only ever holds raster
 * pixels, so that produced PNG bytes labelled as SVG — browsers refuse to
 * render it and the `<img>` showed a broken image. bwip-js has a real
 * `toSVG()`; use it.
 */
/** Matrix symbols are sized by their module grid; a bar height would stretch them. */
const MATRIX_BCIDS = new Set(["qrcode", "datamatrix", "azteccode"]);

export function generateBarcodeSvg(options: BarcodeOptions): string {
  // Translate our friendly id into the real bwip-js encoder name.
  const bcid = bcidFor(options.type);
  if (!bcid) return "";

  try {
    return toSVG({
      bcid,
      text: options.value,
      // Bar height in mm. Not for matrix symbols: a QR code with `height: 10`
      // came out 150x85, a stretched rectangle that scanners cannot read.
      ...(MATRIX_BCIDS.has(bcid) ? {} : { height: options.height || 10 }),
      includetext: options.text !== false,
      textxalign: "center",
      scale: 3,
      // Match the Rust renderer's QR error correction (medium) so the preview
      // and the printed code hold the same data with the same damage tolerance.
      ...(bcid === "qrcode" ? { eclevel: "M" } : {}),
    });
  } catch {
    return "";
  }
}

/**
 * Convert a number of millimetres to device-independent pixels using the
 * supplied DPI (default 96 CSS px per inch). Keeps bar modules on whole
 * pixels so thermal output is not blurry.
 */
export function mmToPx(mm: number, dpi = 96): number {
  return Math.round((mm / 25.4) * dpi);
}

/**
 * Snap a module width to a whole number of dots at the printer's DPI,
 * because a fractional module width renders as a smeared bar on thermal
 * heads (PLANNING.md 7.5).
 */
export function snapModuleToDot(widthMm: number, dpi: number): number {
  const dots = mmToPx(widthMm, dpi);
  return Math.max(1, Math.round(dots));
}

/** Build a printable `<img>`/inline SVG block for a template. */
export function buildBarcodeHtml(options: BarcodeOptions): string {
  const svg = generateBarcodeSvg(options);
  if (!svg) return "";

  const widthMm = options.scaleToWidth ?? 40;
  // bwip-js emits `<svg ...>` — inject the physical width right after the tag.
  return `<div class="barcode" style="text-align:center;margin:2mm 0">
${svg.replace(/^<svg/, `<svg width="${widthMm}mm"`)}
</div>`;
}

/**
 * The symbologies the `{{barcode}}` helper supports.
 *
 * Print renders templates in Rust (src-tauri/src/render/barcode.rs), which
 * implements exactly this set, so the preview must not draw anything else or
 * it would show a barcode that never prints (REFACTORING.md decision #13).
 * Keep this list in sync with `SYMBOLOGIES` there.
 */
export const PRINT_SYMBOLOGIES = [
  "code128",
  "code39",
  "code93",
  "ean13",
  "ean8",
  "upca",
  "itf",
  "codabar",
] as const;

export function isPrintSymbology(type: string): boolean {
  return (PRINT_SYMBOLOGIES as readonly string[]).includes(type);
}

const HELPER_MIN_MM = 5;
const HELPER_MAX_MM = 200;
export const DEFAULT_BARCODE_WIDTH_MM = 40;
export const DEFAULT_QR_SIZE_MM = 25;

/** A helper argument as text: strings and numbers are used, anything else is empty. */
function helperText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

function helperMm(value: unknown, fallback: number): number {
  const mm = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(mm)) return fallback;
  return Math.min(HELPER_MAX_MM, Math.max(HELPER_MIN_MM, mm));
}

/**
 * HTML for `{{barcode "code128" order.id width=50 text=false}}`.
 *
 * Returns "" for an unknown or preview-only symbology, an empty value, or a
 * value the symbology cannot hold, so one bad row prints an empty spot rather
 * than failing the whole render (the Rust helper does the same).
 */
export function barcodeHelperHtml(
  type: unknown,
  value: unknown,
  options: { width?: unknown; text?: unknown } = {},
): string {
  const kind = helperText(type);
  const text = helperText(value);
  if (!isPrintSymbology(kind) || validateBarcode(kind, text) !== null)
    return "";

  const showText =
    options.text === undefined
      ? true
      : !(
          options.text === false ||
          options.text === 0 ||
          String(options.text).toLowerCase() === "false"
        );

  return buildBarcodeHtml({
    type: kind,
    value: text,
    text: showText,
    scaleToWidth: helperMm(options.width, DEFAULT_BARCODE_WIDTH_MM),
  });
}

/** HTML for `{{qrcode order.url size=30}}`; "" for an empty value. */
export function qrcodeHelperHtml(
  value: unknown,
  options: { size?: unknown } = {},
): string {
  const text = helperText(value);
  if (!text) return "";
  return buildBarcodeHtml({
    type: "qr",
    value: text,
    text: false,
    scaleToWidth: helperMm(options.size, DEFAULT_QR_SIZE_MM),
  });
}

/** True when a template can print `type` through `{{barcode}}` / `{{qrcode}}`. */
export function isHelperSymbology(type: string): boolean {
  return type === "qr" || isPrintSymbology(type);
}

/** A data path a template can read: `order.id`, `this.sku`, `sku`. */
const FIELD_PATH = /^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*$/;

export type BarcodeSnippet =
  | { ok: true; text: string; kind: "helper" | "static" }
  | { ok: false; error: string };

/**
 * What the Designer's Insert Barcode dialog puts in the template.
 *
 * - `fromData`: `value` is a field path, giving `{{barcode "code128" order.id}}`,
 *   so every print (and every CSV row) gets its own code.
 * - otherwise `value` is fixed text. Symbologies that print through a helper
 *   still insert a helper call with a quoted literal, so the preview and the
 *   printed label come from the same renderer. The rest (Data Matrix, PDF417,
 *   Aztec, UPC-E, ITF-14) are preview-only in Rust, so they stay a static SVG.
 */
export function buildBarcodeSnippet(
  type: string,
  value: string,
  fromData: boolean,
): BarcodeSnippet {
  const v = value.trim();
  if (!v) return { ok: false, error: "Value is required" };
  const helper = isHelperSymbology(type);
  const call = (arg: string) =>
    type === "qr" ? `{{qrcode ${arg}}}` : `{{barcode "${type}" ${arg}}}`;

  if (fromData) {
    if (!helper) {
      return {
        ok: false,
        error: `${labelFor(type)} can only use a fixed value for now`,
      };
    }
    if (!FIELD_PATH.test(v)) {
      return { ok: false, error: "Enter a data field such as order.id" };
    }
    return { ok: true, kind: "helper", text: call(v) };
  }

  const error = validateBarcode(type, v);
  if (error) return { ok: false, error };

  if (!helper) {
    const html = buildBarcodeHtml({ type, value: v, scaleToWidth: 40 });
    return html
      ? { ok: true, kind: "static", text: html }
      : { ok: false, error: "Could not generate this barcode" };
  }

  // A Handlebars string literal can hold either quote, but not both.
  if (v.includes('"') && v.includes("'")) {
    return {
      ok: false,
      error: "The value cannot contain both ' and \" characters",
    };
  }
  const literal = v.includes('"') ? `'${v}'` : `"${v}"`;
  return { ok: true, kind: "helper", text: call(literal) };
}

export function validateBarcode(type: string, value: string): string | null {
  const v = value.trim();

  if (!v) return "Value is required";

  switch (type) {
    case "code128":
      return null;
    case "code39":
      return /^[0-9A-Z\-\.\ \/\+\%\$]+$/i.test(v)
        ? null
        : "Code 39 only supports A-Z, 0-9, -, ., space, /, +, %, $";
    case "ean13":
      if (!/^\d{13}$/.test(v)) return "EAN-13 requires exactly 13 digits";
      return validateEanCheckDigit(v) ? null : "Invalid EAN-13 check digit";
    case "ean8":
      if (!/^\d{8}$/.test(v)) return "EAN-8 requires exactly 8 digits";
      return validateEanCheckDigit(v) ? null : "Invalid EAN-8 check digit";
    case "upca":
      if (!/^\d{12}$/.test(v)) return "UPC-A requires exactly 12 digits";
      return validateEanCheckDigit(v) ? null : "Invalid UPC-A check digit";
    case "itf":
      // ITF encodes digit pairs only, so it needs an even count.
      return /^\d+$/.test(v) && v.length % 2 === 0
        ? null
        : "ITF requires an even number of digits";
    case "codabar": {
      // Codabar = optional start letter A-D, digits, optional stop letter
      // A-D, and AT LEAST ONE of the letters must be present. Plain digits
      // with neither are not a valid Codabar value.
      const body = "0-9\\-\\$\\+\\:\\/\\.";
      const shaped = new RegExp(`^[A-Da-d]?[${body}]+[A-Da-d]?$`).test(v);
      const hasLetter = /[A-Da-d]/.test(v);
      return shaped && hasLetter
        ? null
        : "Codabar requires start/stop letters A-D and digits";
    }
    case "qr":
    case "datamatrix":
    case "pdf417":
    case "aztec":
      return null;
    default:
      return null;
  }
}

function validateEanCheckDigit(value: string): boolean {
  const digits = value.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export const BARCODE_TYPES = [
  { value: "code128", label: "Code 128", bcid: "code128" },
  { value: "code39", label: "Code 39", bcid: "code39" },
  { value: "code93", label: "Code 93", bcid: "code93" },
  { value: "ean13", label: "EAN-13", bcid: "ean13" },
  { value: "ean8", label: "EAN-8", bcid: "ean8" },
  { value: "upca", label: "UPC-A", bcid: "upca" },
  { value: "upce", label: "UPC-E", bcid: "upce" },
  { value: "itf", label: "ITF", bcid: "interleaved2of5" },
  { value: "itf14", label: "ITF-14", bcid: "itf14" },
  { value: "codabar", label: "Codabar", bcid: "rationalizedCodabar" },
  { value: "qr", label: "QR Code", bcid: "qrcode" },
  { value: "datamatrix", label: "Data Matrix", bcid: "datamatrix" },
  { value: "pdf417", label: "PDF417", bcid: "pdf417" },
  { value: "aztec", label: "Aztec", bcid: "azteccode" },
] as const;

/**
 * Map our friendly symbology id to the bwip-js encoder name.
 *
 * Four ids do NOT match bwip-js encoder names, and passing them through
 * verbatim made `toSVG` throw `unknown encoder name` — so those options in
 * the Designer picker silently failed to insert:
 *   - itf     -> interleaved2of5
 *   - codabar -> rationalizedCodabar
 *   - aztec   -> azteccode
 *   - qr      -> qrcode
 */
export function bcidFor(type: string): string | null {
  return BARCODE_TYPES.find((t) => t.value === type)?.bcid ?? null;
}

/** Human-readable label for a symbology id. */
export function labelFor(type: string): string {
  return BARCODE_TYPES.find((t) => t.value === type)?.label ?? type;
}
