-- PrintNinja Database Schema v1

CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('ipp', 'raw_tcp', 'usb', 'bluetooth', 'system')),
    address TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'pdf' CHECK(language IN ('pdf', 'escpos', 'tspl', 'zpl', 'cpcl', 'raster')),
    paper_width_mm INTEGER,
    dpi INTEGER DEFAULT 203,
    default_settings_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    current_version_id INTEGER,
    page_w_mm INTEGER NOT NULL DEFAULT 210,
    page_h_mm INTEGER NOT NULL DEFAULT 297,
    orientation TEXT NOT NULL DEFAULT 'portrait' CHECK(orientation IN ('portrait', 'landscape')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    html TEXT NOT NULL,
    css TEXT NOT NULL DEFAULT '',
    label TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL DEFAULT 'manual' CHECK(created_by IN ('manual', 'autosave', 'restore', 'sync'))
);

CREATE TABLE IF NOT EXISTS sample_datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fonts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL,
    style TEXT NOT NULL DEFAULT 'normal',
    weight TEXT NOT NULL DEFAULT '400',
    file_path TEXT NOT NULL,
    format TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS printer_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- One profile per printer+template pair (PLANNING.md 7.7)
    UNIQUE (printer_id, template_id)
);

CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    url TEXT,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'single_job' CHECK(mode IN ('single_job', 'per_record')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'printing', 'success', 'failed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    record_index INTEGER,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    template_version_id INTEGER REFERENCES template_versions(id) ON DELETE SET NULL,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'ui' CHECK(source IN ('ui', 'api', 'deeplink', 'batch', 'test')),
    source_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'printing', 'success', 'failed', 'cancelled')),
    error TEXT,
    copies INTEGER NOT NULL DEFAULT 1,
    settings_json TEXT,
    rendered_html TEXT,
    -- The job's input payload, kept so a queued row can run again (retry,
    -- reprint, batch records). Run-input, not a history view: it is never
    -- selected into `PrintJob` (IPC/REST); the displayed artifact,
    -- `rendered_html`, stays secret-redacted by the pipeline.
    data_json TEXT,
    idempotency_key TEXT,
    is_test INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS api_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'print',
    allowed_ips TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_printer ON print_jobs(printer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_template ON print_jobs(template_id);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON print_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON print_jobs(created_at);
-- One row per idempotency key: this index is the atomic reservation that
-- makes two simultaneous POST /v1/print requests with one key print once
-- (P12). Multiple NULL keys are fine — SQLite unique indexes allow NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_idempotency ON print_jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_versions_template ON template_versions(template_id);
CREATE INDEX IF NOT EXISTS idx_datasets_template ON sample_datasets(template_id);
