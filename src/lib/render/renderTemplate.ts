import Handlebars from "handlebars";
import { buildTemplateCss, injectStyles } from "@/lib/templates/templateCss";
import { sanitizeForRender } from "@/lib/render/sanitize";
import { barcodeHelperHtml, qrcodeHelperHtml } from "@/lib/utils/barcode";

/**
 * Register the shared helper set once.
 *
 * Handlebars' global registry is a singleton, so re-registering on every
 * render leaks helpers and makes rendering order-dependent.
 */
let helpersRegistered = false;

function registerHelpers() {
  if (helpersRegistered) return;
  helpersRegistered = true;

  // Handlebars passes the options object as the last argument, so any
  // optional param must be type-checked rather than assumed.
  Handlebars.registerHelper(
    "currency",
    function (value: unknown, symbol?: unknown) {
      const sym = typeof symbol === "string" ? symbol : "$";
      return `${sym}${Number(value ?? 0).toFixed(2)}`;
    },
  );

  Handlebars.registerHelper(
    "date",
    function (value: unknown, format?: unknown) {
      if (!value) return "";
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return String(value);
      const fmt = typeof format === "string" ? format : undefined;
      if (fmt === "short") return d.toLocaleDateString();
      if (fmt === "time") return d.toLocaleTimeString();
      return d.toLocaleString();
    },
  );

  Handlebars.registerHelper("upper", (v: unknown) =>
    String(v ?? "").toUpperCase(),
  );
  Handlebars.registerHelper("lower", (v: unknown) =>
    String(v ?? "").toLowerCase(),
  );

  Handlebars.registerHelper(
    "number",
    function (value: unknown, decimals?: unknown) {
      const d = typeof decimals === "number" ? decimals : 0;
      return Number(value ?? 0).toFixed(d);
    },
  );

  Handlebars.registerHelper(
    "padLeft",
    function (value: unknown, width?: unknown, pad?: unknown) {
      const w = typeof width === "number" ? width : 0;
      const filler = typeof pad === "string" && pad.length > 0 ? pad[0] : " ";
      const s = String(value ?? "");
      return filler.repeat(Math.max(0, w - s.length)) + s;
    },
  );

  // `{{barcode "code128" order.id width=50 text=false}}` and
  // `{{qrcode order.url size=30}}`. The Rust renderer implements the same
  // helpers (src-tauri/src/render/handlebars.rs); keep them in step.
  // The last argument Handlebars passes is always the options object, so a
  // missing value arrives as the options object and is read as empty.
  Handlebars.registerHelper(
    "barcode",
    function (this: unknown, ...args: unknown[]) {
      const options = args.pop() as Handlebars.HelperOptions;
      const [type, value] = args;
      return new Handlebars.SafeString(
        barcodeHelperHtml(type, value, options?.hash ?? {}),
      );
    },
  );

  Handlebars.registerHelper(
    "qrcode",
    function (this: unknown, ...args: unknown[]) {
      const options = args.pop() as Handlebars.HelperOptions;
      return new Handlebars.SafeString(
        qrcodeHelperHtml(args[0], options?.hash ?? {}),
      );
    },
  );
}

const CSP_META =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";

function injectCsp(html: string): string {
  if (/http-equiv=["']Content-Security-Policy/i.test(html)) return html;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${CSP_META}\n</head>`);
  }
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${CSP_META}`);
  }
  if (html.includes("<html")) {
    return html.replace("<html", `<html>\n<head>${CSP_META}</head>`);
  }
  return `${CSP_META}\n${html}`;
}

/**
 * Compile a Handlebars template once, without wrapping the result in a
 * document. Used to render one page per record before wrapping once.
 */
function renderBody(html: string, data: unknown): string {
  registerHelpers();

  let body: string;
  try {
    body = Handlebars.compile(html)(data);
  } catch {
    // A broken template must still produce a printable document showing the
    // raw source, rather than crashing the preview/print pipeline.
    // Escape HTML to prevent execution even inside <pre>.
    const escaped = html
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    body = `<pre style="white-space:pre-wrap">${escaped}</pre>`;
  }

  // Strip scripts and event handlers unconditionally — preview must never
  // execute code, even from a compromised server row.
  return sanitizeForRender(body);
}

/**
 * Wrap a rendered body in a complete HTML document with the bundled print
 * stylesheet inlined. Hardened per V2.md §8.3: strips scripts/handlers and
 * injects CSP before wrapping. The document is intended to be loaded in a
 * sandboxed iframe with no `allow-scripts` or `allow-same-origin`.
 */
function wrapDocument(
  body: string,
  css: string,
  compiledCss?: string | null,
): string {
  const combined = buildTemplateCss(css, compiledCss);

  // If the template is already a full document, inject into it rather than
  // nesting a second <html>.
  if (/<html[\s>]/i.test(body)) {
    let doc = injectStyles(body, combined);
    doc = injectCsp(doc);
    return doc;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
${CSP_META}
<style data-printninja>${combined}</style>
</head>
<body>
${body}
</body>
</html>`;
}
/**
 * Compile a Handlebars template, render it with `data`, and wrap the result
 * in a complete HTML document with the bundled print stylesheet inlined.
 *
 * Hardened per V2.md §8.3: strips scripts/handlers and injects CSP before
 * wrapping. The document is intended to be loaded in a sandboxed iframe
 * with no `allow-scripts` or `allow-same-origin`.
 */
export function renderTemplate(
  html: string,
  css: string,
  data: Record<string, unknown>,
  /** The template's compiled Tailwind CSS; the shared bundle is used if blank. */
  compiledCss?: string | null,
): string {
  return wrapDocument(renderBody(html, data), css, compiledCss);
}

/**
 * Render one page per record: a single object renders one page, an array
 * renders one page per element joined with a page break, wrapped once.
 * Mirrors the print pipeline (print.rs step 2), so the preview shows
 * exactly what will print.
 */
export function renderRecords(
  html: string,
  css: string,
  data: unknown,
  /** The template's compiled Tailwind CSS; the shared bundle is used if blank. */
  compiledCss?: string | null,
): string {
  const records = Array.isArray(data) ? data : [data];
  const body = records
    .map((record) => renderBody(html, record))
    .join('\n<div style="break-before:page"></div>\n');
  return wrapDocument(body, css, compiledCss);
}

/**
 * Why `html` cannot be rendered with `data`, as one short line, or null if it
 * renders fine. `renderTemplate` hides the failure (it shows the raw source so
 * printing never crashes); the Designer uses this to tell the person what is
 * wrong while they are still typing.
 */
export function getTemplateError(
  html: string,
  data: Record<string, unknown>,
): string | null {
  registerHelpers();
  try {
    Handlebars.compile(html)(data);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Parse errors span several lines (the message, the source line, a caret
    // pointer, what was expected). Keep the first and last.
    const lines = message
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length <= 1) return lines[0] ?? "Unknown template error";
    return `${lines[0]} ${lines[lines.length - 1]}`;
  }
}

/** Wrap a fragment in a full document with the bundled print stylesheet. */
export function wrapWithTailwind(html: string, css: string): string {
  return renderTemplate(html, css, {});
}
