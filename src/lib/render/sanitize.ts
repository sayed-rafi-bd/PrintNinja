/**
 * Template body sanitization for B2 (V2.md §8.3).
 *
 * Two guarantees before anything is published or saved:
 * 1. No code execution or Tauri IPC access.
 * 2. No outbound data exfiltration via remote resources.
 *
 * This module is used both in preview/print rendering and in publish/save
 * validation. The server re-validates as well.
 */

/**
 * Strip <script> tags (including self-closing and case variations) and
 * event-handler attributes (on*). This is intentionally conservative:
 * previews must never execute code, even from a compromised server row.
 */
export function stripScriptsAndHandlers(html: string): string {
  let out = html;

  // Strip <script ...>...</script> (case-insensitive, multiline)
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  // Strip self-closing or unclosed script tags
  out = out.replace(/<script\b[^>]*\/?>/gi, "");

  // Strip event handler attributes: on*="...", on*='...', on*=unquoted
  // Matches:  <div onclick="..."  , <img onerror='...' , <svg onload=foo>
  // Use a loop to handle multiple handlers per tag.
  out = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/gi, "");

  // Strip javascript: URLs in href/src/action/formaction/xlink:href
  out = out.replace(
    /\s+(href|src|action|formaction|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\\s*javascript:[^']*'|[^\s>]*javascript:[^\s>]*)/gi,
    "",
  );

  return out;
}

/**
 * Detect remote references that would leak data or violate CSP.
 * Returns an array of human-readable messages, or null if clean.
 * Checks: <img src="https://...">, href, src, CSS url(http...), @import
 */
export function findRemoteRefs(html: string, css: string): string[] | null {
  const issues: string[] = [];

  // HTML src/href with remote URL
  const remoteAttr =
    /(?:src|href)\s*=\s*["']\s*(?:https?:\/\/|\/\/)[^"']*["']/gi;
  let m: RegExpExecArray | null;
  while ((m = remoteAttr.exec(html)) !== null) {
    issues.push(
      `Remote reference in HTML: ${m[0].trim().slice(0, 80)} — use data: URIs`,
    );
  }

  // CSS url(http...), url(//...), url("https:..."), @import
  const urlPattern = /url\s*\(\s*["']?\s*(?:https?:\/\/|\/\/)[^)]*\)/gi;
  while ((m = urlPattern.exec(css)) !== null) {
    issues.push(
      `Remote url() in CSS: ${m[0].trim().slice(0, 80)} — use data: URIs`,
    );
  }
  while ((m = urlPattern.exec(html)) !== null) {
    issues.push(
      `Remote url() in HTML style: ${m[0].trim().slice(0, 80)} — use data: URIs`,
    );
  }

  const importPattern = /@import\s+(?:url\s*\()?["']?\s*(?:https?:\/\/|\/\/)/gi;
  if (importPattern.test(css) || importPattern.test(html)) {
    issues.push(
      `@import with remote URL — use data: URIs or inline the resource`,
    );
  }

  return issues.length ? issues : null;
}

/**
 * Full sanitize for rendering: strip scripts/handlers and return clean HTML.
 * Does NOT reject on remote refs — CSP will block them at runtime, but
 * publish/save validation should call findRemoteRefs and reject.
 */
export function sanitizeForRender(html: string): string {
  return stripScriptsAndHandlers(html);
}
