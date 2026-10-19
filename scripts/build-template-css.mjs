#!/usr/bin/env node
/**
 * Build the bundled print stylesheet used by every rendered template.
 *
 *   pnpm build:templates:css
 *
 * Compiles `src/styles/templates.src.css` with the Tailwind CLI (using the
 * safelist in `tailwind.templates.config.ts`) and emits
 * `src/lib/templates/templates.generated.ts` containing the CSS as a plain
 * string module.
 *
 * Why a `.ts` module and not a `.css` file imported with `?raw`:
 *   - `?raw` is resolved by the bundler, so the string came back empty under
 *     Vitest and could not be asserted on;
 *   - a generated `.ts` module is type-checked by `tsc`, imported identically
 *     by Vite and Vitest, and never depends on CSS-plugin configuration.
 *
 * The output is committed so that `pnpm build`, `pnpm test` and offline
 * installs never need the Tailwind toolchain.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = resolve(ROOT, "src/styles/templates.src.css");
const CONFIG = resolve(ROOT, "tailwind.templates.config.ts");
const OUT = resolve(ROOT, "src/lib/templates/templates.generated.ts");

// The Rust print pipeline embeds the same stylesheet (include_str!), so the
// PDF is styled identically to the preview.
const CSS_OUT = resolve(ROOT, "src-tauri/assets/template-print.css");

const RAW = `${OUT}.raw`;

process.stdout.write("[templates:css] compiling Tailwind print bundle...\n");
// Windows: node_modules/.bin/tailwindcss is a .cmd shim, not a JS file —
// execFileSync without shell fails with ENOENT. Use pnpm exec which is
// cross-platform and already available in CI (pnpm/action-setup).
try {
  execFileSync("pnpm", ["exec", "tailwindcss", "-c", CONFIG, "-i", INPUT, "-o", RAW, "--minify"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
} catch (e) {
  // Fallback for environments without pnpm exec (e.g. npx)
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npx, ["tailwindcss", "-c", CONFIG, "-i", INPUT, "-o", RAW, "--minify"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    shell: process.platform === "win32",
  });
}

const css = readFileSync(RAW, "utf8").trim();
rmSync(RAW, { force: true });

// A stylesheet that references the network defeats the whole point: rendered
// documents must work offline, on an air-gapped LAN, and under our CSP.
if (/cdn\.tailwindcss\.com/.test(css)) {
  throw new Error("generated print CSS still references the Tailwind CDN");
}
if (/url\(\s*['"]?https?:/i.test(css) || /@import/.test(css)) {
  throw new Error("generated print CSS contains an external resource");
}

// Inline as a template literal so the bundle keeps its own quotes/backticks
// readable. Escape only what would terminate the literal.
const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

writeFileSync(
  OUT,
  `/* eslint-disable */
/**
 * AUTO-GENERATED — do not edit.
 *
 * Source:     src/styles/templates.src.css
 * Config:     tailwind.templates.config.ts
 * Regenerate: pnpm build:templates:css
 *
 * A minified Tailwind build used by every rendered template. It replaces the
 * runtime \`https://cdn.tailwindcss.com\` script, which was a DEV-ONLY artifact
 * that broke offline printing, violated our CSP, and recompiled Tailwind on
 * every print job.
 */

/** The bundled print stylesheet, ${css.length} bytes minified. */
export const TEMPLATE_PRINT_CSS = \`${escaped}\`;

export default TEMPLATE_PRINT_CSS;
`,
  "utf8",
);

mkdirSync(dirname(CSS_OUT), { recursive: true });
writeFileSync(CSS_OUT, `${css}\n`, "utf8");

process.stdout.write(
  `[templates:css] wrote ${OUT.replace(ROOT + "/", "")} (${css.length} bytes)\n`,
);
