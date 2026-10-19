/**
 * Per-template Tailwind compilation, run inside the app.
 *
 * The shared print bundle (`templates.generated.ts`) can only contain classes
 * that were safelisted at build time, so anything outside the Designer's
 * palette (`w-[37mm]`, `bg-rose-500`, `grid-cols-5`) silently does nothing.
 * Here the classes a template actually uses are compiled when the template is
 * designed, and the result is stored with the template version.
 *
 * The compiler is Tailwind v4's `compile()`, which works on an in-memory
 * candidate list: no Node, no filesystem. It is installed under the alias
 * `tailwind4` so the app shell can stay on Tailwind v3.
 *
 * Output differs from a stock v4 build in three deliberate ways, so templates
 * keep the cascade and defaults they had with the v3 bundle:
 *   1. Cascade layers are flattened. Unlayered CSS (the print base stylesheet
 *      and the template's own CSS) always beats layered CSS, which would make
 *      `table{width:100%}` beat `w-1/2`. v3 emitted plain rules, so we do too.
 *   2. `dark:` follows a `.dark` ancestor, as in the v3 config, rather than the
 *      OS colour scheme.
 *   3. The print font stacks and the default border colour match the v3 build.
 */
import { compile } from "tailwind4";
import theme from "tailwind4/theme.css?raw";
import preflight from "tailwind4/preflight.css?raw";
import utilities from "tailwind4/utilities.css?raw";
import { extractClasses } from "@/lib/templates/extractClasses";

/**
 * Bump when INPUT or the post-processing changes, so stored CSS is recompiled.
 * It is part of the key saved next to every compiled stylesheet.
 */
export const COMPILER_REV = "tw4.3-r1";

export interface CompiledTemplateCss {
  /** Self-contained stylesheet: reset, theme variables and the used utilities. */
  css: string;
  /** `COMPILER_REV` plus a hash of the class set; equal keys mean equal CSS. */
  key: string;
}

const FILES: Record<string, string> = {
  "tailwindcss/theme.css": theme,
  "tailwindcss/preflight.css": preflight,
  "tailwindcss/utilities.css": utilities,
};

const INPUT = `
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css" layer(utilities);

@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: "Segoe UI", Roboto, "Noto Sans", -apple-system,
    BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  --font-mono: Consolas, "DejaVu Sans Mono", Menlo, monospace;
}

@layer base {
  *, ::after, ::before, ::backdrop, ::file-selector-button {
    border-color: var(--color-gray-200, currentcolor);
  }
}
`;

/** 32-bit FNV-1a: small, synchronous, and plenty for a change-detection key. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Key for a class set. Cheap, so callers can check it on every keystroke. */
export function classSetKey(candidates: string[]): string {
  return `${COMPILER_REV}:${fnv1a(candidates.join("\n"))}`;
}

/** Key for a template's HTML, without compiling anything. */
export function templateCssKey(html: string): string {
  return classSetKey(extractClasses(html).candidates);
}

/**
 * Replace `@layer x { ... }` with its contents and drop `@layer a, b;`
 * ordering statements. Source order is preserved, which is what the layers
 * were encoding, so the cascade among Tailwind's own rules is unchanged.
 */
export function flattenLayers(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@layer", i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, at);

    let j = at + "@layer".length;
    while (j < css.length && css[j] !== ";" && css[j] !== "{") j++;
    if (j >= css.length) {
      out += css.slice(at); // malformed: keep as is
      break;
    }
    if (css[j] === ";") {
      i = j + 1; // `@layer a, b;`
      continue;
    }

    let depth = 0;
    let quote = "";
    let k = j;
    for (; k < css.length; k++) {
      const ch = css[k];
      if (quote) {
        if (ch === "\\") k++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    out += flattenLayers(css.slice(j + 1, k));
    i = k + 1;
  }
  return out;
}

/**
 * Drop comments (the v4 banner links to tailwindcss.com, and printed
 * documents must not reference the network) and blank lines.
 */
function tidy(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const MEMO_LIMIT = 24;
const memo = new Map<string, Promise<string>>();

async function build(candidates: string[]): Promise<string> {
  // A fresh compiler per call: `build()` is incremental and would otherwise
  // leak classes from one template into the next.
  const compiler = await compile(INPUT, {
    base: "/",
    loadStylesheet: async (id: string) => {
      const content = FILES[id];
      if (content === undefined) {
        throw new Error(`Unexpected stylesheet import: ${id}`);
      }
      return { path: id, base: "/", content };
    },
  });
  return tidy(flattenLayers(compiler.build(candidates)));
}

/**
 * Compile the classes used by `html`. Never throws: on failure it returns an
 * empty result, and callers fall back to the shared v3 print bundle.
 */
export async function compileTemplateCss(
  html: string,
): Promise<CompiledTemplateCss> {
  const { candidates } = extractClasses(html);
  const key = classSetKey(candidates);

  let pending = memo.get(key);
  if (!pending) {
    pending = build(candidates);
    memo.set(key, pending);
    if (memo.size > MEMO_LIMIT) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
  }

  try {
    return { css: await pending, key };
  } catch (e) {
    memo.delete(key);
    console.warn("Template CSS compile failed; using the shared bundle:", e);
    return { css: "", key: "" };
  }
}

/**
 * The two columns stored next to a template version. Empty strings on
 * failure, which makes printing fall back to the shared bundle.
 */
export async function compiledFields(
  html: string,
): Promise<{ compiled_css: string; compiled_key: string }> {
  const { css, key } = await compileTemplateCss(html);
  return { compiled_css: css, compiled_key: key };
}
