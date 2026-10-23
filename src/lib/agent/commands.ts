import { invoke } from "@/lib/invoke";
import type {
  AddPrinterReq,
  ApiStatus,
  ApplyReport,
  ConflictedRow,
  DeeplinkResult,
  DirtyDatasetRow,
  DirtyFontRow,
  DirtyProfileRow,
  DirtyRow,
  DirtySettingRow,
  FontDownloadReport,
  FontRow,
  HistoryJob,
  PrintHtmlReq,
  PrinterRow,
  PrintResponse,
  ProfileRow,
  QueuedUseRow,
  ResetReport,
  SaveDatasetReq,
  SaveProfileReq,
  SyncStateRow,
  SyncedDatasetRow,
  SystemPrinterRow,
  TemplateRow,
  UploadFontReq,
} from "./types";

/**
 * The typed IPC surface (REFACTORING.md P18, Q11). Every Tauri command
 * the app calls is a key here with its args and result, so a renamed
 * command or a wrong payload fails the build instead of failing at
 * runtime. Thin wrappers give each call site a plain function.
 */

export interface CreateTemplateReq {
  name: string;
  page_w_mm?: number;
  page_h_mm?: number;
  orientation?: string;
  html?: string;
  css?: string;
  compiled_css?: string;
  compiled_key?: string;
  readme?: string;
  summary?: string;
  server_id?: string;
  sync_state?: string;
  kind?: string;
  owner_handle?: string | null;
  server_revision?: number;
  base_revision?: number;
}

/** Command name → [args, result]. Args are what goes after the name. */
export interface AgentCommands {
  // Templates
  list_templates: [{}, TemplateRow[]];
  get_template: [{ id: number }, TemplateRow];
  create_template: [{ req: CreateTemplateReq }, TemplateRow];
  update_template_meta: [
    {
      req: {
        id: number;
        name: string;
        page_w_mm: number;
        page_h_mm: number;
        summary?: string;
        html?: string;
        css?: string;
        compiled_css?: string;
        compiled_key?: string;
      };
    },
    TemplateRow,
  ];
  update_readme: [{ req: { id: number; readme: string } }, TemplateRow];
  update_template_origin: [
    { req: { id: number; origin: string; origin_owner?: string | null } },
    TemplateRow,
  ];
  delete_template: [{ id: number }, null];
  set_publish_info: [
    { req: { id: number; remote_id: string; published_at: string | null } },
    TemplateRow,
  ];
  clear_publish_info: [{ req: { id: number } }, TemplateRow];
  // Sync cache
  cache_apply_changes: [
    { changes: unknown[]; new_cursor: string },
    ApplyReport,
  ];
  cache_get_sync_state: [{}, SyncStateRow];
  cache_list_dirty: [{}, DirtyRow[]];
  cache_mark_pushed: [{ server_id: string; revision: number }, null];
  cache_mark_conflicted: [{ server_id: string }, null];
  cache_resolve_conflict: [
    {
      server_id: string;
      resolution: "mine" | "theirs";
      server_copy?: unknown;
      rebase_to?: number;
    },
    null,
  ];
  cache_queue_use: [{ server_id: string; delta: number }, number];
  cache_list_queued_uses: [{}, QueuedUseRow[]];
  cache_clear_account: [{}, number];
  reset_database: [{}, ResetReport];
  cache_list_tombstoned: [{}, string[]];
  cache_list_synced: [{}, string[]];
  cache_forget_template: [{ server_id: string }, boolean];
  cache_list_conflicted: [{}, ConflictedRow[]];
  // Settings
  get_setting: [{ key: string }, string | null];
  set_setting: [{ key: string; value: string }, null];
  get_trusted_sources: [{}, string[]];
  set_trusted_sources: [{ sources: string[] }, null];
  refresh_background: [{}, null];
  // Printers
  list_printers: [{}, PrinterRow[]];
  add_printer: [{ req: AddPrinterReq }, PrinterRow];
  update_printer: [{ id: number; req: AddPrinterReq }, PrinterRow];
  delete_printer: [{ id: number }, null];
  get_printer: [{ id: number }, PrinterRow];
  test_printer: [{ id: number }, null];
  enumerate_system_printers: [{}, SystemPrinterRow[]];
  // Printing
  print_html: [{ req: PrintHtmlReq }, PrintResponse];
  spike_test_print: [{}, PrintResponse];
  // Fonts
  list_fonts: [{}, FontRow[]];
  upload_font: [UploadFontReq, FontRow];
  delete_font: [{ id: number }, null];
  cache_list_dirty_fonts: [{}, DirtyFontRow[]];
  cache_mark_font_pushed: [{ server_id: string; revision: number }, null];
  cache_list_tombstoned_fonts: [{}, string[]];
  cache_list_synced_fonts: [{}, string[]];
  cache_forget_font: [{ server_id: string }, boolean];
  cache_read_font_file: [{ server_id: string }, number[]];
  cache_download_pending_fonts: [{}, FontDownloadReport];
  // Datasets
  list_datasets: [{}, SyncedDatasetRow[]];
  save_dataset: [{ req: SaveDatasetReq }, SyncedDatasetRow];
  delete_dataset: [{ id: number }, null];
  cache_list_dirty_datasets: [{}, DirtyDatasetRow[]];
  cache_mark_dataset_pushed: [{ server_id: string; revision: number }, null];
  cache_list_tombstoned_datasets: [{}, string[]];
  cache_list_synced_datasets: [{}, string[]];
  cache_forget_dataset: [{ server_id: string }, boolean];
  // Profiles
  list_profiles: [
    { printer_id?: number | null; template_id?: number | null },
    ProfileRow[],
  ];
  save_profile: [{ req: SaveProfileReq }, ProfileRow];
  delete_profile: [{ id: number }, null];
  cache_list_dirty_profiles: [{}, DirtyProfileRow[]];
  cache_mark_profile_pushed: [{ server_id: string; revision: number }, null];
  cache_list_tombstoned_profiles: [{}, string[]];
  cache_list_synced_profiles: [{}, string[]];
  cache_forget_profile: [{ server_id: string }, boolean];
  // Account preferences
  cache_list_dirty_settings: [{}, DirtySettingRow[]];
  cache_mark_setting_pushed: [{ key: string }, null];
  cache_list_tombstoned_settings: [{}, string[]];
  cache_list_synced_settings: [{}, string[]];
  cache_forget_setting: [{ key: string }, boolean];
  // History and batches
  list_jobs: [{}, HistoryJob[]];
  get_job: [{ id: number }, HistoryJob];
  reprint_job: [{ id: number }, HistoryJob];
  retry_job: [{ id: number }, HistoryJob];
  delete_job: [{ id: number }, null];
  // Local API server (loopback by default, LAN only when enabled;
  // there is no key — binding is the entire security boundary)
  start_api_server: [{ port: number; lan_access: boolean }, string];
  stop_api_server: [{}, null];
  get_api_status: [{}, ApiStatus];
  // Misc
  ping: [{}, null];
  parse_deeplink: [{ url: string }, DeeplinkResult];
}

type Args<K extends keyof AgentCommands> = AgentCommands[K][0];
type Result<K extends keyof AgentCommands> = AgentCommands[K][1];

/** One typed call to the local agent. Command names come from the table above. */
export function agent<K extends keyof AgentCommands>(
  cmd: K,
  args: Args<K> = {} as Args<K>,
): Promise<Result<K>> {
  return invoke(cmd as string, args as Record<string, unknown>) as Promise<
    Result<K>
  >;
}
