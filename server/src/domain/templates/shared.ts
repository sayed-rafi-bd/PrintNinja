import { PayloadTooLargeError } from "../errors.js";

/** Template field rules (plan sections 8/9). Caps are BYTES — JavaScript's
 * string length counts UTF-16 units, so a multibyte string can pass a
 * .length check while exceeding the cap (P16). The Zod schema checks
 * shape; these byte checks are the authoritative enforcement. */

export const TEMPLATE_NAME_MAX = 120;
export const TEMPLATE_SUMMARY_MAX = 500;
export const PAGE_MM_MIN = 0;
export const PAGE_MM_MAX = 2000;
export const BODY_MAX_BYTES = 512 * 1024;
export const CSS_MAX_BYTES = 256 * 1024;
export const README_MAX_BYTES = 64 * 1024;
export const VERSION_LABEL_MAX_BYTES = 200;
export const VERSION_NOTE_MAX_BYTES = 2000;
export const REVISION_MIN = 1;

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Names and summaries pass the schema's UTF-16 .max() check, so a
 * multibyte string within the char limit can exceed the same number in
 * bytes. The byte caps are authoritative: a 120-char CJK name is 360
 * bytes and is refused here, not truncated downstream.
 */
export function assertNameCaps(name: string, summary: string): void {
  const over =
    [
      { path: "name", bytes: byteLength(name), cap: TEMPLATE_NAME_MAX },
      {
        path: "summary",
        bytes: byteLength(summary),
        cap: TEMPLATE_SUMMARY_MAX,
      },
    ].find((field) => field.bytes > field.cap) ?? null;
  if (over) {
    throw new PayloadTooLargeError([
      {
        path: over.path,
        message: `${over.path} is ${over.bytes} bytes, limit ${over.cap}`,
      },
    ]);
  }
}

/** Version labels/notes were unbounded TEXT. Cap them like the rest. */
export function assertVersionCaps(label?: string, note?: string): void {
  const over =
    [
      {
        path: "version.label",
        bytes: byteLength(label ?? ""),
        cap: VERSION_LABEL_MAX_BYTES,
      },
      {
        path: "version.note",
        bytes: byteLength(note ?? ""),
        cap: VERSION_NOTE_MAX_BYTES,
      },
    ].find((field) => field.bytes > field.cap) ?? null;
  if (over) {
    throw new PayloadTooLargeError([
      {
        path: over.path,
        message: `${over.path} is ${over.bytes} bytes, limit ${over.cap}`,
      },
    ]);
  }
}

export function assertSizeCaps(
  body: string,
  css: string,
  readme: string,
): void {
  const over =
    [
      { path: "body", bytes: byteLength(body), cap: BODY_MAX_BYTES },
      { path: "css", bytes: byteLength(css), cap: CSS_MAX_BYTES },
      { path: "readme", bytes: byteLength(readme), cap: README_MAX_BYTES },
    ].find((field) => field.bytes > field.cap) ?? null;
  if (over) {
    throw new PayloadTooLargeError([
      {
        path: over.path,
        message: `${over.path} is ${over.bytes} bytes, limit ${over.cap}`,
      },
    ]);
  }
}

export interface RemoteRefIssue {
  part: "body" | "css";
  snippet: string;
}

/**
 * Server-side remote-reference check (closes P10). Must reject
 * everything the client's find_remote_refs rejects, plus the cases the
 * section-11 unit list names: single-quoted and unquoted url(),
 * protocol-relative //host, @import, and src/href in any letter case or
 * with spaces around =. Matching runs on the lowercased text (attribute
 * names and schemes are case-insensitive); data: and relative URLs are
 * never flagged.
 */
export function findRemoteRefs(body: string, css: string): RemoteRefIssue[] {
  const issues: RemoteRefIssue[] = [];
  const push = (part: "body" | "css", snippet: string) => {
    if (!issues.some((i) => i.part === part && i.snippet === snippet)) {
      issues.push({ part, snippet });
    }
  };

  // Layer 1: the client's exact needles, verbatim (lowercased both
  // sides, exactly as render/handlebars.rs compares).
  const lowerBody = body.toLowerCase();
  const lowerCss = css.toLowerCase();
  for (const needle of [
    'src="http',
    "src='http",
    'href="http',
    "href='http",
    'src="//',
    'href="//',
  ]) {
    if (lowerBody.includes(needle)) {
      push("body", `Remote reference in HTML: ${needle.slice(0, 20)}`);
    }
  }
  for (const needle of [
    'url("http',
    "url('http",
    "url(http",
    'url("//',
    "url('//",
    "url(//",
  ]) {
    if (lowerBody.includes(needle)) {
      push("body", `Remote url() in HTML: ${needle}`);
    }
    if (lowerCss.includes(needle)) {
      push("css", `Remote url() in CSS: ${needle}`);
    }
  }
  if (
    lowerBody.includes("@import") &&
    (lowerBody.includes("http://") ||
      lowerBody.includes("https://") ||
      lowerBody.includes("//"))
  ) {
    push("body", "@import with remote URL");
  }

  // Layer 2: attribute parsing — spaces around =, quoted or unquoted
  // values, any case (already lowered).
  const attrPattern = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of lowerBody.matchAll(attrPattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (isRemoteUrl(value)) {
      push("body", `Remote ${match[0].slice(0, 40)}`);
    }
  }
  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+?))\s*\)/g;
  for (const match of lowerBody.matchAll(urlPattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (isRemoteUrl(value)) {
      push("body", `Remote ${match[0].slice(0, 40)}`);
    }
  }
  const cssUrlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+?))\s*\)/g;
  for (const match of lowerCss.matchAll(cssUrlPattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (isRemoteUrl(value)) {
      push("css", `Remote ${match[0].slice(0, 40)}`);
    }
  }
  // @import with a remote target in either part (coarse rule kept for
  // client parity: @import plus any remote-looking URL anywhere).
  for (const [part, lower] of [
    ["body", lowerBody],
    ["css", lowerCss],
  ] as const) {
    for (const match of lower.matchAll(
      /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/g,
    )) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      if (isRemoteUrl(value)) {
        push(part, `@import of ${value.slice(0, 40)}`);
      }
    }
    if (
      lower.includes("@import") &&
      (lower.includes("http://") ||
        lower.includes("https://") ||
        lower.includes("//"))
    ) {
      push(part, "@import with remote URL");
    }
  }
  return issues;
}

function isRemoteUrl(value: string): boolean {
  const v = value.trim();
  return (
    v.startsWith("http://") || v.startsWith("https://") || v.startsWith("//")
  );
}
