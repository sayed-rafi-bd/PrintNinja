/**
 * Handlebars-aware class extraction for per-template Tailwind compilation.
 *
 * The class compiler only understands literal class names, but template
 * authors write Handlebars, so a class attribute can look like:
 *
 *     class="p-2 {{#if urgent}}bg-red-600{{else}}bg-green-600{{/if}}"
 *     class="p-2 {{cls urgent "bg-red-600" "bg-green-600"}}"
 *
 * The rule templates follow is: write the FULL class name in every branch.
 * Both literals are then visible to this scanner and both get compiled.
 *
 * What cannot work is a class name assembled from data at render time:
 *
 *     class="bg-{{color}}-500"      (compiler sees `bg-` and `-500`)
 *     class="w-[{{width}}mm]"       (compiler sees `w-[` and `mm]`)
 *
 * Those are silent failures (no error, no styling), so `extractClasses` also
 * reports them as warnings for the Designer to surface while the author types.
 */

export interface ClassWarning {
  /** Offset into the scanned HTML where the offending fragment starts. */
  index: number;
  /** 1-based line of `index`. */
  line: number;
  /** The fragment as written, e.g. `bg-{{color}}-500`. */
  snippet: string;
  /** i18n key for the explanation, rendered by the caller with t(). */
  messageKey: string;
}

export interface ClassScan {
  /** Unique, sorted class names to hand to the compiler as candidates. */
  candidates: string[];
  warnings: ClassWarning[];
}

type PartKind = "text" | "value" | "block" | "comment";

interface Part {
  kind: PartKind;
  text: string;
  /** Absolute offset of this part in the HTML. */
  start: number;
}

/** Index just past the closing braces of the mustache at `i`, or -1. */
function mustacheEnd(s: string, i: number): number {
  let close = "}}";
  if (s.startsWith("{{{", i)) close = "}}}";
  else if (s.startsWith("{{!--", i)) close = "--}}";
  const j = s.indexOf(close, i + 2);
  return j === -1 ? -1 : j + close.length;
}

/**
 * `block`   {{#if}} {{else}} {{/if}} {{^x}}: structure, acts as a boundary.
 * `comment` {{! … }}: ignored.
 * `value`   everything else: outputs something unknown at design time.
 */
function classify(raw: string): PartKind {
  const inner = raw
    .replace(/^\{\{\{?~?/, "")
    .replace(/~?\}\}\}?$/, "")
    .trim();
  if (inner.startsWith("!")) return "comment";
  if (/^[#/^]/.test(inner) || /^else(\s|$)/.test(inner)) return "block";
  return "value";
}

/**
 * Split a quoted attribute value into literal text and mustache parts.
 * Mustaches are skipped as a unit, so quotes inside them
 * (`{{cls x "bg-red-600"}}`) do not terminate the attribute.
 * Returns null for an unterminated value.
 */
function parseValue(
  s: string,
  from: number,
  quote: string,
): { parts: Part[]; end: number } | null {
  const parts: Part[] = [];
  let text = "";
  let textStart = from;
  const flush = () => {
    if (text) parts.push({ kind: "text", text, start: textStart });
    text = "";
  };

  let i = from;
  while (i < s.length) {
    if (s.startsWith("{{", i)) {
      const end = mustacheEnd(s, i);
      if (end === -1) return null;
      flush();
      const raw = s.slice(i, end);
      parts.push({ kind: classify(raw), text: raw, start: i });
      i = end;
      continue;
    }
    if (s[i] === quote) {
      flush();
      return { parts, end: i + 1 };
    }
    if (!text) textStart = i;
    text += s[i];
    i++;
  }
  return null;
}

/** Quoted string arguments of a helper call, e.g. `{{cls x "a b" 'c'}}`. */
function stringLiterals(mustache: string): string[] {
  const out: string[] = [];
  for (const m of mustache.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

/** A class name never ends in `-`, `:` or `/`, and never has open brackets. */
function isIncomplete(token: string): boolean {
  if (/[-:/]$/.test(token)) return true;
  const count = (c: string) => token.split(c).length - 1;
  return count("[") !== count("]") || count("(") !== count(")");
}

const WHITESPACE_END = /\s$/;
const WHITESPACE_START = /^\s/;

function lineOf(html: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < html.length; i++) {
    if (html.charCodeAt(i) === 10) line++;
  }
  return line;
}

const GLUE_MESSAGE_KEY = "designer.glue_message";

export function extractClasses(html: string): ClassScan {
  const candidates = new Set<string>();
  const warnings: ClassWarning[] = [];
  const warned = new Set<number>();

  const warn = (index: number, snippet: string) => {
    if (warned.has(index)) return;
    warned.add(index);
    warnings.push({
      index,
      line: lineOf(html, index),
      snippet,
      messageKey: GLUE_MESSAGE_KEY,
    });
  };

  // `(^|[^\w-])` rather than a lookbehind (older WebViews) and so that
  // `data-class=` and `className=` are not mistaken for `class=`.
  const attr = /(^|[^\w-])class\s*=\s*(?=["'])/gi;
  let m: RegExpExecArray | null;

  while ((m = attr.exec(html))) {
    const quoteAt = m.index + m[0].length;
    const parsed = parseValue(html, quoteAt + 1, html[quoteAt]);
    if (!parsed) continue;
    attr.lastIndex = parsed.end;

    const { parts } = parsed;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const prev = parts[p - 1];
      const next = parts[p + 1];

      if (part.kind === "text") {
        for (const t of part.text.matchAll(/\S+/g)) {
          const token = t[0];
          const from = t.index ?? 0;
          const to = from + token.length;
          const atStart = from === 0;
          const atEnd = to === part.text.length;

          // A token touching a value mustache is a fragment of whatever the
          // mustache renders; the mustache branch below reports it.
          const glued =
            (atStart && prev?.kind === "value") ||
            (atEnd && next?.kind === "value");
          if (glued) continue;

          if (isIncomplete(token)) {
            // `bg-{{#if x}}red{{/if}}`: the fragment touches a block tag.
            if (atEnd && next?.kind === "block") {
              warn(part.start + from, token + next.text);
            } else if (atStart && prev?.kind === "block") {
              warn(prev.start, prev.text + token);
            }
            continue;
          }
          candidates.add(token);
        }
        continue;
      }

      if (part.kind !== "value") continue;

      // Whole-token expressions (`{{cls}} p-4`) are fine; only expressions
      // that touch other text or expressions build a class from fragments.
      const left =
        prev?.kind === "text" && !WHITESPACE_END.test(prev.text)
          ? (prev.text.match(/\S+$/)?.[0] ?? "")
          : prev?.kind === "value"
            ? prev.text
            : "";
      const right =
        next?.kind === "text" && !WHITESPACE_START.test(next.text)
          ? (next.text.match(/^\S+/)?.[0] ?? "")
          : "";
      if (left || right) {
        warn(part.start - left.length, left + part.text + right);
      }

      // String arguments of helper calls are class names written as literals.
      for (const lit of stringLiterals(part.text)) {
        for (const token of lit.split(/\s+/)) {
          if (token && !isIncomplete(token)) candidates.add(token);
        }
      }
    }
  }

  return {
    candidates: [...candidates].sort(),
    warnings: warnings.sort((a, b) => a.index - b.index),
  };
}
