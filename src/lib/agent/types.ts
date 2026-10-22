/**
 * Canonical IPC row shapes (REFACTORING.md P18). These mirror the Rust
 * structs in src-tauri/src/commands/ field for field — one definition
 * instead of a copy per screen — and the fake agent speaks them too.
 * Server data is NOT here: that comes from the generated OpenAPI types
 * in src/lib/api/schema.d.ts.
 */

export interface TemplateRow {
  id: number;
  name: string;
  current_version_id: number | null;
  page_w_mm: number;
  page_h_mm: number;
  orientation: string;
  readme: string;
  summary: string;
  remote_id: string | null;
  /** The sync identity; the only id pushes may use. */
  server_id: string | null;
  published_at: string | null;
  origin: string;
  origin_owner: string | null;
  withdrawn: boolean;
  created_at: string;
  updated_at: string;
}

export interface TemplateVersionRow {
  id: number;
  template_id: number;
  version_no: number;
  html: string;
  css: string;
  label: string | null;
  note: string | null;
  created_at: string;
  created_by: string;
  compiled_css?: string;
  compiled_key?: string;
}

export interface DirtyRow {
  id: number;
  server_id: string | null;
  name: string;
  summary: string;
  page_w_mm: number;
  page_h_mm: number;
  readme: string;
  html: string;
  css: string;
  base_revision: number | null;
}

export interface SystemPrinterRow {
  id: string;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  status?: string;
}

export interface SyncStateRow {
  account_handle: string | null;
  server_url: string | null;
  cursor: string;
  last_pull_at: string | null;
  last_error: string | null;
}

export interface ConflictedRow {
  id: number;
  server_id: string | null;
  name: string;
}

export interface QueuedUseRow {
  server_template_id: string;
  count: number;
}

export interface HistoryJob {
  id: number;
  batch_id: number | null;
  record_index: number | null;
  template_id: number | null;
  template_version_id: number | null;
  printer_id: number | null;
  source: "ui" | "api" | "deeplink" | "batch" | "test";
  source_url: string | null;
  status: "queued" | "printing" | "success" | "failed" | "cancelled";
  error: string | null;
  copies: number;
  settings_json: string | null;
  rendered_html: string | null;
  idempotency_key: string | null;
  is_test: boolean;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  /** JSON of `StageTimings`; null for a job that has not run or predates timings. */
  timings_json: string | null;
}

export interface ApplyReport {
  applied_upserts: number;
  applied_deletes: number;
  skipped_dirty: number;
}

export interface PrinterRow {
  id: number;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  paper_width_mm?: number | null;
  dpi?: number | null;
  /** UI-only: last test-print outcome, not stored server-side. */
  status?: string;
}

export interface AddPrinterReq {
  name: string;
  printer_type: string;
  address: string;
  language: string;
  paper_width_mm?: number;
  dpi?: number;
}

export interface SystemPrinterRow {
  id: string;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  status?: string;
}

export interface PrintHtmlReq {
  printer_name: string;
  html: string;
  page_width_mm?: number | null;
  page_height_mm?: number | null;
  orientation?: string | null;
  copies?: number | null;
  margin_top?: number | null;
  margin_right?: number | null;
  margin_bottom?: number | null;
  margin_left?: number | null;
  fit_mode?: string | null;
  page_range?: string | null;
  grayscale?: boolean | null;
  template_id?: number | null;
  template_version_id?: number | null;
  data?: unknown;
  data_url?: string | null;
  http_method?: string | null;
  test?: boolean | null;
  source?: string | null;
  idempotency_key?: string | null;
}

/** Where one print job's time went, in ms per pipeline stage (0 = not reached). */
export interface StageTimings {
  fetch_ms: number;
  template_ms: number;
  layout_ms: number;
  render_ms: number;
  send_ms: number;
  history_ms: number;
  total_ms: number;
}

export interface PrintResponse {
  success: boolean;
  job_id: string;
  duration_ms: number;
  error: string | null;
  /** Null when the job failed before any stage ran. */
  timings?: StageTimings | null;
}

export interface FontRow {
  id: number;
  family: string;
  style: string;
  weight: string;
  file_path: string;
  format: string;
  created_at: string;
  /** The sync identity; every row has one. */
  server_id: string;
  sync_state: string;
  /** Hex SHA-256 of the stored bytes; empty until bytes land. */
  sha256: string;
  size_bytes: number;
  /** Download state: pending | ready | error. */
  state: string;
}

export interface UploadFontReq {
  file_name: string;
  file_data: number[];
  family?: string | null;
}

export interface ProfileRow {
  id: number;
  /** Local linkage, resolved from the server key. Null when this PC
   * has no such printer or template: the row is dormant, not broken. */
  printer_id: number | null;
  template_id: number | null;
  /** The sync identity; every row has one. */
  server_id: string;
  template_server_id: string;
  /** Lowercase printer name: the server key. */
  printer_name: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface SyncedDatasetRow {
  id: number;
  /** The sync identity; every row has one. */
  server_id: string;
  name: string;
  data_json: string;
  server_revision: number | null;
  base_revision: number | null;
  sync_state: string;
  created_at: string;
  updated_at: string;
}

export interface SaveDatasetReq {
  id?: number | null;
  name: string;
  data_json: string;
}

export interface DirtyDatasetRow {
  server_id: string;
  name: string;
  data_json: string;
  base_revision: number | null;
}

export interface DirtyProfileRow {
  server_id: string;
  template_id: string;
  printer_name: string;
  settings_json: string;
  base_revision: number | null;
}

export interface DirtySettingRow {
  key: string;
  value: string;
  tombstone: boolean;
}

export interface DirtyFontRow {
  server_id: string;
  name: string;
  base_revision: number | null;
}

export interface FontDownloadReport {
  downloaded: number;
  failed: number;
}

/** Counts from a full local wipe: everything the app owned on this PC. */
export interface ResetReport {
  templates: number;
  template_versions: number;
  print_jobs: number;
  fonts: number;
  datasets: number;
  profiles: number;
  printers: number;
  batches: number;
}

export interface SaveProfileReq {
  printer_id: number;
  template_id: number;
  settings_json: string;
}

export interface BatchRow {
  id: number;
  name: string;
  status: string;
  mode: string;
  total: number;
  done: number;
  failed: number;
}

export interface CreateBatchReq {
  template_id: number;
  printer_id: number;
  data: unknown;
  mode: string;
  settings_json?: string | null;
  stop_on_error?: boolean | null;
}

export interface ApiStatus {
  running: boolean;
  address: string;
  port: number;
  lan_access: boolean;
}

export interface DeeplinkResult {
  action: string;
  [key: string]: unknown;
}

export interface VersionDiff {
  from_version_no: number;
  to_version_no: number;
  html_from: string;
  html_to: string;
  css_from: string;
  css_to: string;
  html_changed: boolean;
  css_changed: boolean;
}
