import i18n from "@/lib/i18n";

/**
 * Turn whatever a failed call threw into text in the current UI language.
 *
 * Rust commands fail with `AppError`, which serde serializes as an externally
 * tagged object (`{ "NotFound": "Template 3 not found" }`, `{ "DuplicateJob": 7 }`),
 * or with a plain string. Neither is translated at the source, so this maps
 * each known message to an `errors.*` key and falls back to the variant label
 * plus the raw detail. Anything unrecognized is shown as-is, never hidden.
 *
 * To translate a new Rust message: add a row to PATTERNS and the key to both
 * locale files. The wording in Rust does not need to change.
 */

type Params = Record<string, string | number>;

/** [message regex, i18n key, names for each capture group in order] */
const PATTERNS: Array<[RegExp, string, string[]]> = [
  [/^Template (\d+) not found$/, "errors.template_not_found", ["id"]],
  [/^Template '(.+)' not found$/, "errors.template_named_not_found", ["name"]],
  [/^Printer (\d+) not found$/, "errors.printer_not_found", ["id"]],
  [/^Job (\d+) not found$/, "errors.job_not_found", ["id"]],
  [/^Font (.+) not found$/, "errors.font_not_found", ["id"]],
  [/^Dataset (.+) not found$/, "errors.dataset_not_found", ["id"]],
  [/^Profile (.+) not found$/, "errors.profile_not_found", ["id"]],
  [/^Setting '(.+)' not found$/, "errors.setting_not_found", ["key"]],
  [/^Template name required$/, "errors.template_name_required", []],
  [/^Printer name required$/, "errors.printer_name_required", []],
  [/^Dataset name required$/, "errors.dataset_name_required", []],
  [/^Font file name required$/, "errors.font_name_required", []],
  [/^Font file is empty$/, "errors.font_empty", []],
  [/^Setting key required$/, "errors.setting_key_required", []],
  [/^Select a printer first$/, "errors.select_printer_first", []],
  [/^API server is already running$/, "errors.api_already_running", []],
  [
    /^A printer named '(.+)' already exists$/,
    "errors.printer_exists",
    ["name"],
  ],
  [
    /^A template named '(.+)' already exists$/,
    "errors.template_exists",
    ["name"],
  ],
  [/^Invalid kind '(.+)'$/, "errors.invalid_kind", ["kind"]],
  [/^Invalid settings JSON: (.+)$/, "errors.invalid_settings_json", ["detail"]],
  [
    /^Dataset is not valid JSON: (.+)$/,
    "errors.dataset_invalid_json",
    ["detail"],
  ],
  [/^Unknown deep link action: (.+)$/, "errors.unknown_deeplink", ["action"]],
  [/^bad sync record: (.+)$/, "errors.bad_sync_record", ["detail"]],
  [/^sync delete without id$/, "errors.sync_delete_no_id", []],
  [/^sync upsert without data$/, "errors.sync_upsert_no_data", []],
  [
    /^resolving to theirs needs the server copy$/,
    "errors.resolve_needs_server",
    [],
  ],
  [/^DB lock poisoned$/, "errors.db_lock", []],
  [/^USB device not found$/, "errors.usb_not_found", []],
  [
    /^Windows spooler not available on this platform$/,
    "errors.spooler_unavailable",
    [],
  ],
  [
    /^Could not reach (.+?): (.+)$/,
    "errors.printer_unreachable",
    ["at", "detail"],
  ],
  [/^CUPS returned HTTP (\d+)$/, "errors.cups_http", ["status"]],
  [/^IPP server returned HTTP (\d+)$/, "errors.ipp_http", ["status"]],
  [
    /^CUPS refused the request: status (.+)$/,
    "errors.cups_refused",
    ["status"],
  ],
  [/^Unknown printer type `(.+)`$/, "errors.unknown_printer_type", ["type"]],
  [/^PDF render timed out after (\d+)s$/, "errors.pdf_timeout", ["seconds"]],
];

/** Variant → key used when the payload matches no known message. */
const KIND_KEYS: Record<string, string> = {
  Database: "errors.kind_database",
  NotFound: "errors.kind_not_found",
  Validation: "errors.kind_validation",
  Internal: "errors.kind_internal",
};

type Normalized = { kind?: string; message: string; id?: number };

function normalize(e: unknown): Normalized {
  if (typeof e === "string") return { message: e };
  if (e instanceof Error) return { message: e.message };
  if (e && typeof e === "object") {
    const entries = Object.entries(e as Record<string, unknown>);
    if (entries.length === 1) {
      const [kind, payload] = entries[0];
      if (kind === "DuplicateJob" && typeof payload === "number") {
        return { kind, message: "", id: payload };
      }
      if (kind in KIND_KEYS && typeof payload === "string") {
        return { kind, message: payload };
      }
    }
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return { message };
    try {
      return { message: JSON.stringify(e) };
    } catch {
      return { message: String(e) };
    }
  }
  return { message: String(e) };
}

/** Translate a known message; null when no pattern matches. */
function translateMessage(message: string): string | null {
  for (const [re, key, names] of PATTERNS) {
    const m = re.exec(message);
    if (!m) continue;
    const params: Params = {};
    names.forEach((n, i) => {
      params[n] = m[i + 1];
    });
    return i18n.t(key, params);
  }
  return null;
}

export function describeError(e: unknown): string {
  const n = normalize(e);
  if (n.kind === "DuplicateJob") {
    return i18n.t("errors.duplicate_job", { id: n.id });
  }
  const known = translateMessage(n.message);
  if (known) return known;
  if (n.kind) {
    return i18n.t(KIND_KEYS[n.kind], { detail: n.message });
  }
  return n.message;
}

/** True when the error is the "already exists" conflict from add/rename. */
export function isAlreadyExists(e: unknown): boolean {
  return /already exists/.test(normalize(e).message);
}
