/**
 * Print stylesheets for user templates.
 *
 * Rendered documents used to pull `https://cdn.tailwindcss.com` at print time,
 * and later inlined one shared, safelisted Tailwind build. Both are gone: each
 * template version now carries its own stylesheet, compiled from the classes
 * it actually uses (`compileTemplateCss`, stored as `compiled_css`). That
 * keeps every print job self-contained and CSP-clean, and lets templates use
 * any Tailwind class, including arbitrary values like `w-[37mm]`.
 *
 * What is left here is the small base layer every document gets.
 */

/**
 * Tailwind's base reset must be present, otherwise unclassed template markup
 * keeps the browser's default 8px body margin and preflight is missing.
 */
export const TEMPLATE_BASE_CSS = `@page{margin:0}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Segoe UI",Roboto,"Noto Sans",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#0f172a;line-height:1.4;print-color-adjust:exact;-webkit-print-color-adjust:exact}
table{border-collapse:collapse;width:100%}
img,svg{max-width:100%}
svg{shape-rendering:crispEdges}
.barcode{text-align:center;margin:2mm 0}
.barcode svg{display:inline-block;vertical-align:middle}
.page-break-before{break-before:page;page-break-before:always}
.page-break-after{break-after:page;page-break-after:always}
.page-break-inside-avoid{break-inside:avoid;page-break-inside:avoid}
.no-print{display:none!important}
.print-only{display:none}
@media print{.print-only{display:block}body{min-height:0}}`;

/**
 * Combine the base print CSS with the template's compiled Tailwind CSS.
 *
 * `compiledCss` may be blank, for a version that has not been compiled yet
 * (the startup backfill compiles those) or whose compile failed; the document
 * then has the base rules and the template's own CSS only. The Rust print path
 * assembles the same three parts in the same order (`build_template_css`), so
 * preview and print agree.
 *
 * Base rules come first so the Tailwind utilities can override them, and so
 * caller-supplied CSS (appended last) always wins.
 */
export function buildTemplateCss(
  userCss?: string | null,
  compiledCss?: string | null,
): string {
  const parts = [TEMPLATE_BASE_CSS];
  if (compiledCss && compiledCss.trim()) parts.push(compiledCss);
  if (userCss && userCss.trim()) parts.push(userCss);
  return parts.join("\n");
}

/**
 * Inject a stylesheet into a full HTML document.
 *
 * A `<style>` tag is used rather than `<link rel="stylesheet">` because the
 * rendered document is printed from a temporary file and must not depend on
 * any external resource.
 */
export function injectStyles(html: string, css: string): string {
  const styleTag = `<style data-printninja>${css}</style>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${styleTag}\n</head>`);
  }
  if (html.includes("<body")) {
    return html.replace("<body", `${styleTag}\n<body`);
  }
  if (html.includes("<html")) {
    return html.replace("<html", `<html>\n${styleTag}`);
  }
  return `${styleTag}\n${html}`;
}
