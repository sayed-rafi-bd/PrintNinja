import { getSetting, seedPrinters, setSetting } from "./store.js";
import { createFakeCache, type SyncChangeIn } from "./cache.js";

// In-memory implementation of the IPC commands. Phase 1 implements the
// commands the sign-in and shell screens need; every other command the
// Rust backend offers is registered as an acknowledged stub (warn and
// null) so the agent contract test pins the full surface and drift is
// visible. Real behavior lands here with the screen that calls it,
// never ahead of it — the F-series specs prove each phase's behavior.
//
// The sync cache is the exception: one module holds the whole behavior
// so the shared cache_cases.json runs identically here and in Rust.

// In-memory batch store. Mirrors the Rust validation in
// commands/batch.rs (mode, JSON array, non-empty, 5k records) and the
// cancel/retry state rules. There is no worker here: rows stay queued
// until cancelled, and retry re-queues — the worker drain itself is
// covered by src-tauri worker tests, and the virtual-printer suite
// covers the device half.
interface FakeBatchRow {
  id: number;
  total: number;
  done: number;
  failed: number;
  mode: string;
  status: "queued" | "printing" | "success" | "failed" | "cancelled";
}

const batches = new Map<number, FakeBatchRow>();
let nextBatchId = 1;

function getBatchOrThrow(id: number): FakeBatchRow {
  const row = batches.get(id);
  if (!row) {
    throw new Error(`Batch ${id} not found`);
  }
  return row;
}

const batchHandlers: Record<string, Handler> = {
  create_batch: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    const mode = String(req["mode"] ?? "");
    if (mode !== "single_job" && mode !== "per_record") {
      throw new Error(
        `Invalid mode '${mode}'. Expected one of ["single_job", "per_record"]`,
      );
    }
    const data = req["data"];
    if (!Array.isArray(data)) {
      throw new Error("Batch data must be a JSON array");
    }
    if (data.length === 0) {
      throw new Error("Batch contains no records");
    }
    if (data.length > 5000) {
      throw new Error(`Batch too large: ${data.length} records (max 5000)`);
    }
    const id = nextBatchId++;
    const row: FakeBatchRow = {
      id,
      total: data.length,
      done: 0,
      failed: 0,
      mode,
      status: "queued",
    };
    batches.set(id, row);
    return { ...row };
  },
  list_batches: () => [...batches.values()].map((row) => ({ ...row })),
  get_batch: (args) => ({ ...getBatchOrThrow(Number(args["id"] ?? 0)) }),
  cancel_batch: (args) => {
    const row = getBatchOrThrow(Number(args["id"] ?? 0));
    if (row.status === "queued" || row.status === "printing") {
      row.status = "cancelled";
    }
    return null;
  },
  retry_batch: (args) => {
    const row = getBatchOrThrow(Number(args["id"] ?? 0));
    row.status = "queued";
    row.failed = 0;
    row.done = 0;
    return null;
  },
};

/**
 * Mirrors parse_deep_link in src-tauri/src/deeplink.rs: same actions,
 * same defaults (confirm unless 0/false, test only on 1/true, copies
 * parsed or dropped), same unknown-action error. Serde's externally
 * tagged enum shape is reproduced ({ Print: {...} } etc.) so specs
 * assert the exact wire the app would get.
 */
function parseDeepLink(url: string): unknown {
  const rest = url.startsWith("printninja://")
    ? url.slice("printninja://".length)
    : url;
  const queryIndex = rest.indexOf("?");
  const path = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : rest.slice(queryIndex + 1);
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals !== -1) {
      params.set(
        decodeQueryComponent(pair.slice(0, equals)),
        decodeQueryComponent(pair.slice(equals + 1)),
      );
    }
  }
  if (path === "print") {
    // Rust parses copies as u32: digits only, in range, else dropped.
    const copiesRaw = params.get("copies");
    const copiesNum =
      copiesRaw !== undefined && /^\d+$/.test(copiesRaw)
        ? Number.parseInt(copiesRaw, 10)
        : NaN;
    const testFlag = params.get("test");
    const confirmFlag = params.get("confirm");
    return {
      Print: {
        preset: params.get("preset") ?? null,
        template: params.get("template") ?? null,
        printer: params.get("printer") ?? null,
        url: params.get("url") ?? null,
        copies:
          Number.isInteger(copiesNum) && copiesNum <= 4294967295
            ? copiesNum
            : null,
        orientation: params.get("orientation") ?? null,
        fit: params.get("fit") ?? null,
        test: testFlag === "1" || testFlag === "true",
        confirm: !(confirmFlag === "0" || confirmFlag === "false"),
        callback: params.get("callback") ?? null,
      },
    };
  }
  if (path.startsWith("open/")) {
    return { Open: path.slice("open/".length) };
  }
  if (path.startsWith("template/")) {
    return { Template: path.slice("template/".length) };
  }
  throw new Error(`Unknown deep link action: ${path}`);
}

function decodeQueryComponent(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s.replace(/\+/g, " ");
  }
}

type Handler = (args: Record<string, unknown>) => unknown;

// One cache per browser context (module scope = the injected page).
const cache = createFakeCache();

// Printers are snapshotted at bundle evaluation, when the one-shot
// seed is still present (index.ts consumes it after every module has
// evaluated). Unit tests that seed after importing get nothing from
// the snapshot, so enumerate also merges a live read — empty in the
// browser, since the key is already consumed there.
const seededPrinters = seedPrinters();
function allSeededPrinters(): Array<Record<string, unknown>> {
  const live = seedPrinters().filter(
    (p) => !seededPrinters.some((s) => s["name"] === p["name"]),
  );
  return [...seededPrinters, ...live];
}

const implemented: Record<string, Handler> = {
  get_setting: (args) => getSetting(String(args.key ?? "")),
  set_setting: (args) => {
    const value = args.value;
    const key = String(args.key ?? "");
    setSetting(key, typeof value === "string" ? value : null);
    // Mirror Rust: account keys go dirty (or tombstoned when reset);
    // device keys never leave the PC.
    cache.library.markSettingDirty(key, typeof value === "string" ? value : "");
    return null;
  },
  reset_database: () => {
    const report = cache.resetDatabase() as Record<string, number>;
    // The fake runs no worker, so there are no print-job rows — but
    // batches are real here, unlike print_jobs. Report their count so
    // the wipe path is pinned instead of masked as zero.
    report["batches"] = batches.size;
    batches.clear();
    nextBatchId = 1;
    return report;
  },
  ping: () => null,
  enumerate_system_printers: () =>
    allSeededPrinters().map((p, i) => ({
      id: `printer-${i + 1}`,
      name: String(p["name"] ?? `E2E Printer ${i + 1}`),
      address: String(p["address"] ?? "usb:e2e"),
      printer_type: String(p["printer_type"] ?? "label"),
      language: String(p["language"] ?? "zpl"),
      status: "idle",
    })),
  cache_apply_changes: (args) =>
    cache.applyChanges(
      (args["changes"] as SyncChangeIn[] | undefined) ?? [],
      String(args["new_cursor"] ?? ""),
    ),
  cache_get_sync_state: () => cache.getSyncState(),
  cache_list_dirty: () => cache.listDirty(),
  cache_mark_pushed: (args) => {
    cache.markPushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_mark_conflicted: (args) => {
    cache.markConflicted(String(args["server_id"] ?? ""));
    return null;
  },
  cache_resolve_conflict: (args) => {
    const resolution = args["resolution"];
    if (resolution !== "theirs" && resolution !== "mine") {
      throw new Error(`unknown resolution: ${String(resolution)}`);
    }
    cache.resolveConflict(
      String(args["server_id"] ?? ""),
      resolution,
      args["server_copy"] as Record<string, unknown> | undefined,
      args["rebase_to"] === undefined ? undefined : Number(args["rebase_to"]),
    );
    return null;
  },
  cache_queue_use: (args) => {
    return cache.queueUse(
      String(args["server_id"] ?? ""),
      Number(args["delta"] ?? 0),
    );
  },
  cache_list_queued_uses: () => cache.listQueuedUses(),
  cache_clear_account: () => cache.clearAccount(),
  cache_list_tombstoned: () => cache.listTombstoned(),
  cache_list_synced: () => cache.listSynced(),
  cache_forget_template: (args) => {
    return cache.forgetTemplate(String(args["server_id"] ?? ""));
  },
  cache_list_conflicted: () => cache.listConflicted(),
  // Template reads/writes over the same cache rows (dirty-write rules
  // mirror the Rust commands; tombstones stay hidden from lists).
  list_templates: () => cache.listTemplates(),
  get_template: (args) => cache.getTemplate(Number(args["id"] ?? 0)),
  create_template: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    const row = cache.createTemplate(req);
    return cache.listTemplates().find((t) => t["id"] === row.id);
  },
  update_template_meta: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    cache.updateTemplateMeta(Number(req["id"] ?? 0), req);
    return cache
      .listTemplates()
      .find((t) => t["id"] === Number(req["id"] ?? 0));
  },
  update_readme: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    cache.updateReadme(Number(req["id"] ?? 0), String(req["readme"] ?? ""));
    return cache
      .listTemplates()
      .find((t) => t["id"] === Number(req["id"] ?? 0));
  },
  list_versions: (args) => cache.listVersions(Number(args["template_id"] ?? 0)),
  create_version: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    return cache.createVersion(Number(req["template_id"] ?? 0), req);
  },
  delete_template: (args) => {
    cache.deleteTemplate(Number(args["id"] ?? 0));
    return null;
  },
  update_template_origin: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    cache.updateTemplateOrigin(Number(req["id"] ?? 0), req);
    return cache
      .listTemplates()
      .find((t) => t["id"] === Number(req["id"] ?? 0));
  },
  // Printers are device-local rows (never synced); profiles resolve
  // them by current name, so renames and deletes leave dormancy.
  list_printers: () => cache.library.listPrinters(),
  add_printer: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    return cache.library.addPrinter({
      name: String(req["name"] ?? "Printer"),
      printer_type:
        req["printer_type"] === undefined
          ? undefined
          : String(req["printer_type"]),
      address:
        req["address"] === undefined ? undefined : String(req["address"]),
      language:
        req["language"] === undefined ? undefined : String(req["language"]),
    });
  },
  delete_printer: (args) => {
    cache.library.deletePrinter(Number(args["id"] ?? 0));
    return null;
  },
  get_printer: (args) => {
    const row = cache.library
      .listPrinters()
      .find((p) => p.id === Number(args["id"] ?? 0));
    if (!row) throw new Error(`Printer ${String(args["id"])} not found`);
    return row;
  },
  // Sample datasets: the Designer's panel persists through these.
  list_datasets: () =>
    cache.library
      .listDatasets()
      .map((r) => ({ ...r, created_at: r.updated_at })),
  save_dataset: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    const row = cache.library.saveDataset({
      id:
        req["id"] === undefined || req["id"] === null
          ? null
          : Number(req["id"]),
      name: String(req["name"] ?? ""),
      data_json: String(req["data_json"] ?? "{}"),
    });
    return { ...row, created_at: row.updated_at };
  },
  delete_dataset: (args) => {
    cache.library.deleteDataset(Number(args["id"] ?? 0));
    return null;
  },
  cache_list_dirty_datasets: () => cache.library.listDirtyDatasets(),
  cache_mark_dataset_pushed: (args) => {
    cache.library.markDatasetPushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_list_tombstoned_datasets: () => cache.library.listTombstonedDatasets(),
  cache_list_synced_datasets: () => cache.library.listSyncedDatasets(),
  cache_forget_dataset: (args) =>
    cache.library.forgetDataset(String(args["server_id"] ?? "")),
  // Printer profiles, keyed by template and printer name on the wire.
  list_profiles: (args) =>
    cache.library
      .listProfiles({
        printer_id:
          args["printer_id"] === undefined || args["printer_id"] === null
            ? null
            : Number(args["printer_id"]),
        template_id:
          args["template_id"] === undefined || args["template_id"] === null
            ? null
            : Number(args["template_id"]),
      })
      .map((r) => ({ ...r, created_at: r.updated_at })),
  save_profile: (args) => {
    const req = (args["req"] ?? args) as Record<string, unknown>;
    const row = cache.library.saveProfile({
      printer_id: Number(req["printer_id"] ?? 0),
      template_id: Number(req["template_id"] ?? 0),
      settings_json: String(req["settings_json"] ?? "{}"),
    });
    return { ...row, created_at: row.updated_at };
  },
  delete_profile: (args) => {
    cache.library.deleteProfile(Number(args["id"] ?? 0));
    return null;
  },
  cache_list_dirty_profiles: () => cache.library.listDirtyProfiles(),
  cache_mark_profile_pushed: (args) => {
    cache.library.markProfilePushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_list_tombstoned_profiles: () => cache.library.listTombstonedProfiles(),
  cache_list_synced_profiles: () => cache.library.listSyncedProfiles(),
  cache_forget_profile: (args) =>
    cache.library.forgetProfile(String(args["server_id"] ?? "")),
  // Fonts: metadata plus in-memory bytes (test files are tiny).
  list_fonts: () =>
    cache.library.listFonts().map((r) => ({
      id: r.id,
      family: r.family,
      style: "normal",
      weight: "400",
      file_path: "",
      format: r.format,
      created_at: r.updated_at,
      server_id: r.server_id,
      sync_state: r.sync_state,
      sha256: r.sha256,
      size_bytes: r.size_bytes,
      state: r.state,
    })),
  upload_font: (args) =>
    cache.library.uploadFont({
      file_name: String(args["file_name"] ?? ""),
      file_data: (args["file_data"] as number[] | undefined) ?? [],
      family: (args["family"] as string | null | undefined) ?? null,
    }),
  delete_font: (args) => {
    cache.library.deleteFont(Number(args["id"] ?? 0));
    return null;
  },
  cache_list_dirty_fonts: () => cache.library.listDirtyFonts(),
  cache_mark_font_pushed: (args) => {
    cache.library.markFontPushed(
      String(args["server_id"] ?? ""),
      Number(args["revision"] ?? 0),
    );
    return null;
  },
  cache_list_tombstoned_fonts: () => cache.library.listTombstonedFonts(),
  cache_list_synced_fonts: () => cache.library.listSyncedFonts(),
  cache_forget_font: (args) =>
    cache.library.forgetFont(String(args["server_id"] ?? "")),
  cache_read_font_file: (args) =>
    cache.library.readFontFile(String(args["server_id"] ?? "")),
  cache_download_pending_fonts: () => cache.library.downloadPendingFonts(),
  // Account preferences: the allow-list syncs, device keys never do.
  cache_list_dirty_settings: () => cache.library.listDirtySettings(),
  cache_mark_setting_pushed: (args) => {
    cache.library.markSettingPushed(String(args["key"] ?? ""));
    return null;
  },
  cache_list_tombstoned_settings: () => cache.library.listTombstonedSettings(),
  cache_list_synced_settings: () => cache.library.listSyncedSettings(),
  cache_forget_setting: (args) =>
    cache.library.forgetSetting(String(args["key"] ?? "")),
};

/** Every Rust command without real behavior yet (src-tauri/src/lib.rs).
 * Keep this list in sync with generate_handler! — the contract test
 * fails when a Rust command is neither implemented nor acknowledged. */
const acknowledgedStubs: string[] = [
  "test_printer",
  "set_publish_info",
  "clear_publish_info",
  "list_jobs",
  "get_job",
  "reprint_job",
  "retry_job",
  "delete_job",
  "get_trusted_sources",
  "set_trusted_sources",
  "print_html",
  "spike_test_print",
  "delete_version",
  "restore_version",
  "diff_versions",
  "start_api_server",
  "stop_api_server",
  "get_api_status",
  "regenerate_api_key",
  "refresh_background",
];

const commands: Record<string, Handler> = {
  ...implemented,
  ...batchHandlers,
  parse_deeplink: (args) => parseDeepLink(String(args["url"] ?? "")),
};
for (const name of acknowledgedStubs) {
  commands[name] = () => {
    console.warn(`[fake-agent] ${name} has no behavior yet (Phase 1 stub)`);
    return null;
  };
}

export function commandNames(): string[] {
  return Object.keys(commands);
}

export function handleCommand(cmd: string, args: unknown): unknown {
  const handler = commands[cmd];
  if (!handler) {
    console.warn("[fake-agent] unhandled command", cmd, args);
    return null;
  }
  const record =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  return handler(record);
}
