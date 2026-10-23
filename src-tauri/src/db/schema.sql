-- PrintNinja Database Schema v1

CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(name) > 0),
    type TEXT NOT NULL CHECK(type IN ('ipp', 'raw_tcp', 'usb', 'bluetooth', 'system')),
    address TEXT NOT NULL CHECK(length(address) > 0),
    language TEXT NOT NULL DEFAULT 'pdf' CHECK(language IN ('pdf', 'escpos', 'tspl', 'zpl', 'cpcl', 'raster')),
    paper_width_mm INTEGER CHECK(paper_width_mm IS NULL OR paper_width_mm > 0),
    dpi INTEGER DEFAULT 203 CHECK(dpi IS NULL OR dpi > 0),
    default_settings_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(name) > 0),
    page_w_mm INTEGER NOT NULL DEFAULT 210 CHECK(page_w_mm > 0),
    page_h_mm INTEGER NOT NULL DEFAULT 297 CHECK(page_h_mm > 0),
    orientation TEXT NOT NULL DEFAULT 'portrait' CHECK(orientation IN ('portrait', 'landscape')),
    html TEXT NOT NULL DEFAULT '',
    css TEXT NOT NULL DEFAULT '',
    compiled_css TEXT NOT NULL DEFAULT '',
    compiled_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fonts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL CHECK(length(family) > 0),
    style TEXT NOT NULL DEFAULT 'normal',
    weight TEXT NOT NULL DEFAULT '400',
    file_path TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('ttf', 'otf', 'woff', 'woff2')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    total INTEGER NOT NULL DEFAULT 0 CHECK(total >= 0),
    done INTEGER NOT NULL DEFAULT 0 CHECK(done >= 0),
    failed INTEGER NOT NULL DEFAULT 0 CHECK(failed >= 0),
    mode TEXT NOT NULL DEFAULT 'single_job' CHECK(mode IN ('single_job', 'per_record')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'printing', 'success', 'failed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- done counts finished records (success, failed and cancelled);
    -- failed is the failing subset of done.
    CHECK(failed <= done AND done <= total)
);

CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    record_index INTEGER CHECK(record_index IS NULL OR record_index >= 0),
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'ui' CHECK(source IN ('ui', 'api', 'deeplink', 'batch', 'test')),
    source_url TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'printing', 'success', 'failed', 'cancelled')),
    error TEXT,
    copies INTEGER NOT NULL DEFAULT 1 CHECK(copies >= 1),
    settings_json TEXT,
    rendered_html TEXT,
    -- The job's input payload, kept so a queued row can run again (retry,
    -- reprint, batch records). Run-input, not a history view: it is never
    -- selected into `PrintJob` (IPC/REST); the displayed artifact,
    -- `rendered_html`, stays secret-redacted by the pipeline.
    data_json TEXT,
    idempotency_key TEXT,
    is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
    -- Per-stage breakdown of duration_ms (fetch/template/layout/render/send/
    -- history, as JSON), written once the job has run. NULL for rows that
    -- never ran or predate it.
    timings_json TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY CHECK(length(key) > 0),
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
