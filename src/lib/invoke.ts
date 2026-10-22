import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";

/**
 * Argument keys whose values never reach the console: credentials,
 * tokens and session material. Matched case-insensitively against
 * the full key path segment.
 */
const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|api[_-]?key|authorization|auth\b|credential|private[_-]?key|seed|mnemonic/i;

/** Payload keys that can be kilobytes of template/data: summarized. */
const BULKY_KEY_PATTERN =
  /^(html|data|data_url|data_json|rendered_html|body|css|content|payload|file|bytes)$/i;

/** Longest string kept verbatim in the log; the rest is summarized. */
const MAX_STRING_PREVIEW = 200;

function redactValue(
  key: string | null,
  value: unknown,
  depth: number,
): unknown {
  if (key !== null && SECRET_KEY_PATTERN.test(key)) {
    return value === undefined || value === null ? value : "[redacted]";
  }
  if (typeof value === "string") {
    if (key !== null && BULKY_KEY_PATTERN.test(key)) {
      return `[${value.length} chars]`;
    }
    if (value.length > MAX_STRING_PREVIEW) {
      return `${value.slice(0, MAX_STRING_PREVIEW)}…[${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > 4) return `[array(${value.length})]`;
    return value.map((v) => redactValue(null, v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth > 4) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(k, v, depth + 1);
    }
    return out;
  }
  return value;
}

/** A console-safe copy of IPC args: secrets redacted, bulk summarized. */
export function redactInvokeArgs(args?: InvokeArgs): unknown {
  return redactValue(null, args, 0);
}

/**
 * Drop-in replacement for `invoke` from @tauri-apps/api/core that logs every
 * IPC call (name, redacted args, duration) and every failure to the webview
 * console. Args are redacted first: an open devtools window must never show
 * tokens, API keys or full document payloads.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: InvokeArgs,
): Promise<T> {
  const t0 = performance.now();
  const logged = redactInvokeArgs(args);
  try {
    const res = await tauriInvoke<T>(cmd, args);
    console.debug(
      `[invoke] ${cmd} ok ${(performance.now() - t0).toFixed(0)}ms`,
      logged,
    );
    return res;
  } catch (e) {
    console.error(`[invoke] ${cmd} FAILED`, logged, e);
    throw e;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) =>
    console.error("[unhandled]", e.reason),
  );
  window.addEventListener("error", (e) =>
    console.error("[error]", e.error ?? e.message),
  );
}
