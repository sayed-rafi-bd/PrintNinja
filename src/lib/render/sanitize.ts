/**
 * Template body sanitization for B2 (V2.md §8.3).
 *
 * Two guarantees before anything is published or saved:
 * 1. No code execution or Tauri IPC access.
 * 2. No outbound data exfiltration via remote resources.
 *
 * This module is used both in preview/print rendering and in publish/save
 * validation. The server re-validates as well.
 *
 * Implementation note: the sanitizer parses with DOMParser and walks the
 * tree instead of matching tags with regular expressions. Regexes miss
 * real bypasses (`<svg/onload=…>` has no space before the handler,
 * entities decode to `javascript:` after matching, `srcset`/`poster` /
 * `<object data>` / `<base href>` are not `src`/`href`), while the
 * parser sees exactly what the browser will execute or fetch.
 */

const AUTO_LOAD_ATTRS = new Set([
  "src",
  "srcset",
  "poster",
  "data",
  "background",
]);

const URL_ATTRS = new Set([
  "src",
  "href",
  "srcset",
  "poster",
  "data",
  "background",
  "action",
  "formaction",
  "cite",
  "longdesc",
  "profile",
  "usemap",
  "xlink:href",
]);

const AUTO_LOAD_TAGS: Record<string, readonly string[]> = {
  img: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  source: ["src", "srcset"],
  track: ["src"],
  input: ["src"],
  embed: ["src"],
  iframe: ["src"],
  object: ["data"],
  body: ["background"],
  table: ["background"],
  td: ["background"],
  th: ["background"],
};

function isJavascriptUrl(value: string): boolean {
  return /^\s*javascript\s*:/i.test(value);
}

function isRemoteUrl(value: string): boolean {
  const v = value.trim();
  return /^(https?:\/\/|\/\/)/i.test(v);
}

/** Split a srcset value into its raw candidate strings. */
function srcsetCandidates(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((url) => url.length > 0);
}

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function serializeDoc(doc: Document, hadDoctype: boolean): string {
  const html = new XMLSerializer().serializeToString(doc);
  if (hadDoctype && !/^\s*<!doctype/i.test(html)) {
    return `<!DOCTYPE html>\n${html}`;
  }
  return html;
}

/**
 * Strip <script> tags (including self-closing and case variations) and
 * event-handler attributes (on*). This is intentionally conservative:
 * previews must never execute code, even from a compromised server row.
 */
export function stripScriptsAndHandlers(html: string): string {
  const isFullDoc = /<html[\s>]/i.test(html);
  const hadDoctype = /^\s*<!doctype/i.test(html);
  const doc = docOf(html);
  // Pure text (no elements after parsing): nothing can execute or
  // fetch, so return it byte-identical. This also preserves leading
  // whitespace the HTML parser would otherwise drop from a bare
  // fragment (e.g. padded helper output like "   42").
  if (doc.body.querySelector("*") === null) {
    return html;
  }
  const elements = Array.from(doc.querySelectorAll("*"));

  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (tag === "script") {
      el.remove();
      continue;
    }
    if (tag === "meta") {
      const httpEquiv = el.getAttribute("http-equiv");
      if (httpEquiv !== null && httpEquiv.toLowerCase() === "refresh") {
        // <meta http-equiv="refresh" content="0;url=..."> navigates away.
        el.remove();
        continue;
      }
    }
    if (tag === "base") {
      // A base href hijacks every relative URL in the document.
      el.removeAttribute("href");
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        // Event handlers in any case, quoted or not, slash-separated
        // or not: the parser has already normalized them into attributes.
        el.removeAttribute(attr.name);
        continue;
      }
      if (!URL_ATTRS.has(name)) continue;
      const value = attr.value;
      if (isJavascriptUrl(value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "srcset") {
        const kept = srcsetCandidates(value).filter(
          (url) => !isJavascriptUrl(url) && !isRemoteUrl(url),
        );
        if (kept.length === 0) {
          el.removeAttribute(attr.name);
        } else if (kept.join(", ") !== value) {
          el.setAttribute(attr.name, kept.join(", "));
        }
        continue;
      }
      if (
        AUTO_LOAD_ATTRS.has(name) &&
        (AUTO_LOAD_TAGS[tag]?.includes(name) ?? false) &&
        isRemoteUrl(value)
      ) {
        // Auto-fetched remote content leaks the render: the PDF engine
        // would fetch it while printing. Relative and data: URIs stay,
        // and plain links (<a href>) are report-only via findRemoteRefs.
        el.removeAttribute(attr.name);
      }
    }
    if (el.hasAttribute("style")) {
      const cleaned = scrubCssUrls(el.getAttribute("style") ?? "");
      if (cleaned === null) {
        el.removeAttribute("style");
      } else if (cleaned !== el.getAttribute("style")) {
        el.setAttribute("style", cleaned);
      }
    }
    if (tag === "style") {
      const cleaned = scrubCssBlock(el.textContent ?? "");
      if (cleaned !== el.textContent) {
        el.textContent = cleaned;
      }
    }
  }

  if (isFullDoc) {
    return serializeDoc(doc, hadDoctype);
  }
  return doc.body.innerHTML;
}

/**
 * Scrub a CSS declaration block or stylesheet: drop remote @imports
 * (they fetch on parse) and blank remote url() targets. Returns null
 * when the whole block was a lone javascript: payload.
 */
function scrubCssUrls(css: string): string | null {
  if (isJavascriptUrl(css)) {
    return null;
  }
  let out = css.replace(
    /@import\s+(?:url\s*\([^)]*\)|["'][^"']*["'])\s*;?/gi,
    (rule) => (/(https?:\/\/|\/\/)/i.test(rule) ? "" : rule),
  );
  out = out.replace(/url\(\s*([^)]*?)\s*\)/gi, (whole, inner: string) => {
    const target = inner.replace(/^["']|["']$/g, "");
    if (isJavascriptUrl(target)) {
      return "url()";
    }
    if (isRemoteUrl(target) && !/^["']?data:/i.test(target.trim())) {
      return "url()";
    }
    return whole;
  });
  return out;
}

function scrubCssBlock(css: string): string {
  return scrubCssUrls(css) ?? "";
}

/**
 * Detect remote references that would leak data or violate CSP.
 * Returns an array of human-readable messages, or null if clean.
 * Walks the parsed tree, so slash-separated handlers, entities and
 * non-src/href attributes (srcset, poster, object data, base href)
 * are all seen — plus remote @import/url() in style blocks.
 */
export function findRemoteRefs(html: string, css: string): string[] | null {
  const issues: string[] = [];
  const push = (issue: string) => {
    if (!issues.includes(issue)) issues.push(issue);
  };

  const doc = docOf(html);
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!URL_ATTRS.has(name)) continue;
      const candidates =
        name === "srcset" ? srcsetCandidates(attr.value) : [attr.value.trim()];
      for (const url of candidates) {
        if (isRemoteUrl(url)) {
          push(
            `Remote reference in HTML: <${tag} ${name}="${url.slice(0, 60)}"> — use data: URIs`,
          );
        }
      }
      if (isJavascriptUrl(attr.value)) {
        push(`Script URL in HTML: <${tag} ${name}> — use data: URIs`);
      }
    }
    if (tag === "style") {
      for (const issue of cssRemoteIssues(el.textContent ?? "")) {
        push(issue);
      }
    }
    if (el.hasAttribute("style")) {
      for (const issue of cssRemoteIssues(el.getAttribute("style") ?? "")) {
        push(issue.replace("CSS", "inline style"));
      }
    }
  }

  for (const issue of cssRemoteIssues(css)) {
    push(issue);
  }

  return issues.length ? issues : null;
}

function cssRemoteIssues(css: string): string[] {
  const issues: string[] = [];
  const urlPattern = /url\s*\(\s*["']?\s*(?:https?:\/\/|\/\/)[^)]*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlPattern.exec(css)) !== null) {
    issues.push(
      `Remote url() in CSS: ${m[0].trim().slice(0, 80)} — use data: URIs`,
    );
  }
  const importPattern = /@import\s+(?:url\s*\([^)]*\)|["'][^"']*["'])\s*;?/gi;
  while ((m = importPattern.exec(css)) !== null) {
    if (/(https?:\/\/|\/\/)/i.test(m[0])) {
      issues.push(
        "@import with remote URL — use data: URIs or inline the resource",
      );
    }
  }
  return issues;
}

/**
 * Full sanitize for rendering: strip scripts/handlers and return clean HTML.
 * Does NOT reject on remote refs — CSP will block them at runtime, but
 * publish/save validation should call findRemoteRefs and reject.
 */
export function sanitizeForRender(html: string): string {
  return stripScriptsAndHandlers(html);
}
