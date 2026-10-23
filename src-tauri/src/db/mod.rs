use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long a statement waits for a competing writer (another process, or a
/// test's second connection) before returning SQLITE_BUSY.
const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// Owns the app's one SQLite connection. Every command reaches it through
/// `DbState = Arc<Mutex<Database>>`, so access is serialised by that mutex —
/// which is what makes a single reused connection safe, and what keeps one
/// physical print head from seeing interleaved work.
pub struct Database {
    pub url: String,
    conn: Connection,
}

/// Strip the `sqlite:` scheme recorded in `Database::url`.
/// rusqlite expects a raw filesystem path, not a URI.
pub fn strip_sqlite_prefix(url: &str) -> &str {
    url.strip_prefix("sqlite:").unwrap_or(url)
}

impl Database {
    /// Open (creating if needed) the database at `url`, configure it, and
    /// apply the schema. This is the only place a connection is opened for
    /// the app, so there is exactly one schema path: `init` below.
    pub fn open(url: &str) -> rusqlite::Result<Database> {
        let conn = Connection::open(strip_sqlite_prefix(url))?;
        // WAL lets readers (the UI) proceed while a writer holds the file,
        // and survives process crash. It is persistent once set, but is
        // applied here so it cannot be forgotten for a new database file.
        let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") && !mode.eq_ignore_ascii_case("memory") {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(1),
                Some(format!("could not enable WAL mode (got {mode})")),
            ));
        }
        conn.busy_timeout(BUSY_TIMEOUT)?;
        init(&conn)?;
        Ok(Database {
            url: url.to_string(),
            conn,
        })
    }

    pub fn path(&self) -> &str {
        strip_sqlite_prefix(&self.url)
    }

    /// Delete the database file (plus WAL/journal sidecars) and reopen it
    /// fresh through the one schema path. The old connection is closed
    /// first, so the delete works on Windows file locking too.
    ///
    /// Afterwards the file holds the current schema and nothing else:
    /// no rows, no `sqlite_sequence` counters, no freelist pages, no
    /// drift from long-ago migrations. On reopen failure `self` is left
    /// with a temporary in-memory database and the error tells the caller
    /// to restart the app (whose startup open recreates the file).
    pub fn recreate(&mut self) -> rusqlite::Result<()> {
        let old = std::mem::replace(&mut self.conn, Connection::open_in_memory()?);
        if let Err((conn, err)) = old.close() {
            self.conn = conn;
            return Err(err);
        }
        let path = self.path().to_string();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{path}{suffix}"));
        }
        match Database::open(&self.url) {
            Ok(fresh) => {
                self.conn = fresh.conn;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// The shared connection. Immutable borrow: rusqlite reads and writes
    /// take `&self`; transactions use `unchecked_transaction`, which is safe
    /// here because the `DbState` mutex serialises all access to it.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

pub type DbState = Arc<Mutex<Database>>;

/// The one schema path: v1 DDL, then the guarded additive migrations.
/// Called by `Database::open` and by tests; nothing else may apply schema.
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("schema.sql"))?;
    ensure_v2_schema(conn)?;
    ensure_sync_schema(conn)?;
    ensure_library_schema(conn)?;
    ensure_p2_checks(conn)?;
    ensure_template_content_schema(conn)
}

/// Check whether a column exists via `PRAGMA table_info` (V2.md §5.1).
/// SQLite has no `ADD COLUMN IF NOT EXISTS`, so every `ALTER` is guarded.
pub fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Apply the V2 additive schema (7 columns + 1 index). Idempotent: a
/// second call changes nothing. Must be called after the V1 `schema.sql`
/// has been applied. No backfill — development stage, existing rows keep
/// their defaults.
pub fn ensure_v2_schema(conn: &Connection) -> rusqlite::Result<()> {
    // Guarded ALTERs — each checks PRAGMA first.
    if !column_exists(conn, "templates", "readme")? {
        conn.execute(
            "ALTER TABLE templates ADD COLUMN readme TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "templates", "summary")? {
        conn.execute(
            "ALTER TABLE templates ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "templates", "remote_id")? {
        conn.execute("ALTER TABLE templates ADD COLUMN remote_id TEXT", [])?;
    }
    if !column_exists(conn, "templates", "published_at")? {
        conn.execute("ALTER TABLE templates ADD COLUMN published_at TEXT", [])?;
    }
    if !column_exists(conn, "templates", "origin")? {
        conn.execute(
            "ALTER TABLE templates ADD COLUMN origin TEXT NOT NULL DEFAULT 'own' CHECK(origin IN ('own','saved'))",
            [],
        )?;
    }
    if !column_exists(conn, "templates", "origin_owner")? {
        conn.execute("ALTER TABLE templates ADD COLUMN origin_owner TEXT", [])?;
    }
    if !column_exists(conn, "templates", "withdrawn")? {
        conn.execute(
            "ALTER TABLE templates ADD COLUMN withdrawn INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // Per-template compiled Tailwind CSS. Empty means "not compiled yet", and
    // printing falls back to the shared bundle, so old rows keep working.
    // Content now lives on `templates` (versions removed).
    for (col, ddl) in [
        (
            "html",
            "ALTER TABLE templates ADD COLUMN html TEXT NOT NULL DEFAULT ''",
        ),
        (
            "css",
            "ALTER TABLE templates ADD COLUMN css TEXT NOT NULL DEFAULT ''",
        ),
        (
            "compiled_css",
            "ALTER TABLE templates ADD COLUMN compiled_css TEXT NOT NULL DEFAULT ''",
        ),
        (
            "compiled_key",
            "ALTER TABLE templates ADD COLUMN compiled_key TEXT NOT NULL DEFAULT ''",
        ),
    ] {
        if !column_exists(conn, "templates", col)? {
            conn.execute(ddl, [])?;
        }
    }

    // The queued-print worker replays a row's input payload (Phase 0, P3):
    // batch rows store each record here and a direct print stores its data,
    // so retry/reprint can run the job again. Worker-internal: never exposed
    // through `PrintJob` (IPC/REST). Guarded on the table as well as the
    // column: a bare `ensure_v2_schema` can run on a partial schema where
    // `print_jobs` does not exist yet — `init` then creates it with the
    // column already in place.
    let has_print_jobs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'print_jobs'",
        [],
        |r| r.get(0),
    )?;
    if has_print_jobs > 0 && !column_exists(conn, "print_jobs", "data_json")? {
        conn.execute("ALTER TABLE print_jobs ADD COLUMN data_json TEXT", [])?;
    }
    // Per-stage timing breakdown shown in History. Old rows keep NULL.
    if has_print_jobs > 0 && !column_exists(conn, "print_jobs", "timings_json")? {
        conn.execute("ALTER TABLE print_jobs ADD COLUMN timings_json TEXT", [])?;
    }

    // `POST /v1/print` replays are atomic only if an idempotency key names
    // one job (P12): the job-row insert records the key before the send, and
    // this unique index is what makes two simultaneous requests with one key
    // print once — the loser hits the constraint and gets the duplicate
    // response instead of a second physical print. Old rows can hold
    // duplicates, so keep the newest per key and clear the rest first, or
    // index creation fails on an existing database.
    if has_print_jobs > 0 {
        if !column_exists(conn, "print_jobs", "idempotency_key")? {
            conn.execute("ALTER TABLE print_jobs ADD COLUMN idempotency_key TEXT", [])?;
        }
        conn.execute(
            "UPDATE print_jobs SET idempotency_key = NULL
             WHERE idempotency_key IS NOT NULL
               AND id NOT IN (SELECT MAX(id) FROM print_jobs
                              WHERE idempotency_key IS NOT NULL
                              GROUP BY idempotency_key)",
            [],
        )?;
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_idempotency
             ON print_jobs(idempotency_key)",
            [],
        )?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_templates_remote ON templates(remote_id)",
        [],
    )?;

    // Section 3 dead code: `sample_datasets` and `presets` were created
    // by the schema but no Rust code ever read or wrote them, so they
    // were always empty. New databases no longer create them; existing
    // ones are tidied here.
    conn.execute("DROP TABLE IF EXISTS sample_datasets", [])?;
    conn.execute("DROP TABLE IF EXISTS presets", [])?;
    // Local API keys are gone (keyless serving); drop the key table.
    // LAN access stays as an opt-in setting, so its keys are kept.
    conn.execute("DROP TABLE IF EXISTS api_clients", [])?;
    conn.execute("DROP INDEX IF EXISTS idx_api_clients_name", [])?;

    ensure_created_by_allows_sync(conn)?;

    Ok(())
}

/// Versions are removed: any leftover `template_versions` table from an old
/// database is dropped here (content was backfilled onto `templates` by
/// `ensure_template_content_schema`). Tolerant of fresh databases that
/// never had the table.
fn ensure_created_by_allows_sync(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DROP TABLE IF EXISTS template_versions", [])?;
    conn.execute("DROP INDEX IF EXISTS idx_versions_template", [])?;
    Ok(())
}

/// Phase 3 sync bookkeeping (REFACTORING.md section 6). Guarded ALTERs
/// plus a one-time backfill; idempotent like the rest of this file. Must
/// run after `ensure_v2_schema` (it backfills from `origin`).
///
/// - `server_id`: the sync identity, unique across PCs. Existing rows
///   copy `remote_id`; local-only rows get a fresh v4 UUID.
/// - `server_revision` / `base_revision`: NULL until the first sync.
/// - `sync_state`: synced | dirty | deleted_pending | conflict. Rows
///   that already came from the server start synced; local-only rows
///   start dirty with no server copy.
/// - `kind`: own | saved, backfilled from `origin`.
/// - `owner_handle`: backfilled from `origin_owner` for saved rows.
/// - `synced_at`: NULL until the first successful pull.
/// - `sync_state` table: one row with the account id, server URL,
///   cursor, last pull time and last error.
pub fn ensure_sync_schema(conn: &Connection) -> rusqlite::Result<()> {
    if !column_exists(conn, "templates", "server_id")? {
        conn.execute("ALTER TABLE templates ADD COLUMN server_id TEXT", [])?;
    }
    if !column_exists(conn, "templates", "server_revision")? {
        conn.execute(
            "ALTER TABLE templates ADD COLUMN server_revision INTEGER",
            [],
        )?;
    }
    if !column_exists(conn, "templates", "base_revision")? {
        conn.execute("ALTER TABLE templates ADD COLUMN base_revision INTEGER", [])?;
    }
    if !column_exists(conn, "templates", "sync_state")? {
        conn.execute(
            "ALTER TABLE templates ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'synced' \
             CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending', 'conflict'))",
            [],
        )?;
    }
    if !column_exists(conn, "templates", "kind")? {
        conn.execute(
            "ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'own' \
             CHECK(kind IN ('own', 'saved'))",
            [],
        )?;
    }
    if !column_exists(conn, "templates", "owner_handle")? {
        conn.execute("ALTER TABLE templates ADD COLUMN owner_handle TEXT", [])?;
    }
    if !column_exists(conn, "templates", "synced_at")? {
        conn.execute("ALTER TABLE templates ADD COLUMN synced_at TEXT", [])?;
    }
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_server_id ON templates(server_id)",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            account_handle TEXT,
            server_url TEXT,
            cursor TEXT,
            last_pull_at TEXT,
            last_error TEXT
        )",
        [],
    )?;

    // Backfill. Every UPDATE is conditional, so a second call is a no-op.
    conn.execute(
        "UPDATE templates SET server_id = remote_id WHERE server_id IS NULL AND remote_id IS NOT NULL",
        [],
    )?;
    // Local-only rows: fresh sync identities, dirty, no server copy.
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM templates WHERE server_id IS NULL")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<Vec<i64>>>()?
    };
    for id in ids {
        conn.execute(
            "UPDATE templates SET server_id = ?1, sync_state = 'dirty' WHERE id = ?2",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), id],
        )?;
    }
    conn.execute(
        "UPDATE templates SET kind = 'saved' WHERE origin = 'saved' AND kind <> 'saved'",
        [],
    )?;
    conn.execute(
        "UPDATE templates SET owner_handle = origin_owner \
         WHERE kind = 'saved' AND owner_handle IS NULL AND origin_owner IS NOT NULL",
        [],
    )?;
    // Whether this database predates the sync cache: any template with a
    // legacy remote_id means a migrated install, which gets the first-sync
    // adoption dialog instead of silently pushing local-only rows.
    let migrated: i64 = conn.query_row(
        "SELECT COUNT(*) FROM templates WHERE remote_id IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    if migrated > 0 {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('install_migrated', '1') ON CONFLICT(key) DO NOTHING",
            [],
        )?;
    }
    // Queued use-counts for the sync engine: the print worker increments
    // the row, the engine sends POST /use and decrements on success.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS queued_uses (
            server_template_id TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
        [],
    )?;
    Ok(())
}

/// Phase 4 library sync (REFACTORING.md Phase 4). Account-level tables
/// mirroring the server shape — datasets, profiles and the sync
/// bookkeeping on `settings` and `fonts` — plus a one-time migration of
/// pre-Phase-4 local profiles keyed by printer name (question 20,
/// answered). Idempotent like the rest of this file; runs after
/// `ensure_sync_schema` so template server ids already exist.
pub fn ensure_library_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS synced_datasets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            data_json TEXT NOT NULL DEFAULT '{}',
            server_revision INTEGER,
            base_revision INTEGER,
            sync_state TEXT NOT NULL DEFAULT 'dirty'
                CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending', 'conflict')),
            synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS synced_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT UNIQUE NOT NULL,
            template_server_id TEXT NOT NULL,
            printer_name TEXT NOT NULL,
            settings_json TEXT NOT NULL DEFAULT '{}',
            server_revision INTEGER,
            base_revision INTEGER,
            sync_state TEXT NOT NULL DEFAULT 'dirty'
                CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending', 'conflict')),
            synced_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(template_server_id, printer_name)
        );",
    )?;

    // Pre-Phase-4 profiles were keyed by local (printer_id, template_id).
    // Upload them keyed by printer name: resolve each row's printer name
    // and template server id, insert as dirty so the engine pushes them,
    // then drop the old table. Rows whose printer or template is gone (or
    // whose template never synced) cannot be keyed and are left behind
    // with the dropped table.
    let has_old: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'printer_profiles'",
        [],
        |r| r.get(0),
    )?;
    if has_old > 0 {
        let rows: Vec<(String, String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT pp.settings_json, LOWER(p.name), t.server_id
                 FROM printer_profiles pp
                 JOIN printers p ON p.id = pp.printer_id
                 JOIN templates t ON t.id = pp.template_id
                 WHERE t.server_id IS NOT NULL",
            )?;
            let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            mapped.collect::<rusqlite::Result<Vec<(String, String, String)>>>()?
        };
        for (settings_json, printer_name, template_server_id) in rows {
            conn.execute(
                "INSERT INTO synced_profiles (server_id, template_server_id, printer_name, settings_json)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(template_server_id, printer_name)
                 DO UPDATE SET settings_json = excluded.settings_json",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    template_server_id,
                    printer_name,
                    settings_json
                ],
            )?;
        }
        conn.execute("DROP TABLE printer_profiles", [])?;
    }

    // Account preferences ride in the `settings` table itself; only
    // allow-listed keys ever leave the device (the server 400s the rest).
    // Device keys keep the 'synced' default forever and are never pushed.
    if !column_exists(conn, "settings", "sync_state")? {
        conn.execute(
            "ALTER TABLE settings ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'synced'
             CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending'))",
            [],
        )?;
    }
    if !column_exists(conn, "settings", "synced_at")? {
        conn.execute("ALTER TABLE settings ADD COLUMN synced_at TEXT", [])?;
    }

    // Fonts gain the sync identity plus the server's metadata. Existing
    // rows were never pushed, so they get fresh server ids and start
    // dirty; the engine uploads their metadata and bytes.
    if !column_exists(conn, "fonts", "server_id")? {
        conn.execute("ALTER TABLE fonts ADD COLUMN server_id TEXT", [])?;
    }
    if !column_exists(conn, "fonts", "server_revision")? {
        conn.execute("ALTER TABLE fonts ADD COLUMN server_revision INTEGER", [])?;
    }
    if !column_exists(conn, "fonts", "base_revision")? {
        conn.execute("ALTER TABLE fonts ADD COLUMN base_revision INTEGER", [])?;
    }
    if !column_exists(conn, "fonts", "sync_state")? {
        conn.execute(
            "ALTER TABLE fonts ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'synced'
             CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending', 'conflict'))",
            [],
        )?;
    }
    if !column_exists(conn, "fonts", "synced_at")? {
        conn.execute("ALTER TABLE fonts ADD COLUMN synced_at TEXT", [])?;
    }
    if !column_exists(conn, "fonts", "sha256")? {
        conn.execute(
            "ALTER TABLE fonts ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "fonts", "size_bytes")? {
        conn.execute(
            "ALTER TABLE fonts ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_fonts_server_id ON fonts(server_id)",
        [],
    )?;
    let unkeyed: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM fonts WHERE server_id IS NULL")?;
        let mapped = stmt.query_map([], |r| r.get(0))?;
        mapped.collect::<rusqlite::Result<Vec<i64>>>()?
    };
    for id in unkeyed {
        conn.execute(
            "UPDATE fonts SET server_id = ?1, sync_state = 'dirty' WHERE id = ?2",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), id],
        )?;
    }
    Ok(())
}

/// Templates now carry their content directly (`html/css/compiled_*`);
/// versions are gone. Migrates old databases: adds the columns, backfills
/// from `current_version_id`, then drops `template_versions`,
/// `templates.current_version_id` and `print_jobs.template_version_id`.
/// Idempotent; fresh databases already match and do nothing.
pub fn ensure_template_content_schema(conn: &Connection) -> rusqlite::Result<()> {
    for (col, ddl) in [
        (
            "html",
            "ALTER TABLE templates ADD COLUMN html TEXT NOT NULL DEFAULT ''",
        ),
        (
            "css",
            "ALTER TABLE templates ADD COLUMN css TEXT NOT NULL DEFAULT ''",
        ),
        (
            "compiled_css",
            "ALTER TABLE templates ADD COLUMN compiled_css TEXT NOT NULL DEFAULT ''",
        ),
        (
            "compiled_key",
            "ALTER TABLE templates ADD COLUMN compiled_key TEXT NOT NULL DEFAULT ''",
        ),
    ] {
        if !column_exists(conn, "templates", col)? {
            conn.execute(ddl, [])?;
        }
    }

    let has_current = column_exists(conn, "templates", "current_version_id")?;
    let has_versions_table: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'template_versions'",
        [],
        |r| r.get(0),
    )?;
    if has_current && has_versions_table > 0 {
        // Backfill content from the pinned version; rows without a version keep defaults.
        let _ = conn.execute(
            "UPDATE templates SET
                html = COALESCE((SELECT html FROM template_versions WHERE id = templates.current_version_id), html),
                css = COALESCE((SELECT css FROM template_versions WHERE id = templates.current_version_id), css),
                compiled_css = COALESCE((SELECT compiled_css FROM template_versions WHERE id = templates.current_version_id), compiled_css),
                compiled_key = COALESCE((SELECT compiled_key FROM template_versions WHERE id = templates.current_version_id), compiled_key)
             WHERE current_version_id IS NOT NULL",
            [],
        );
    }

    let needs_templates_rebuild = has_current;
    let has_job_version_col = column_exists(conn, "print_jobs", "template_version_id")?;
    let fk_before: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    if fk_before != 0 {
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    }
    let rebuild_result: rusqlite::Result<()> = (|| {
        if needs_templates_rebuild {
            conn.execute_batch(
                "CREATE TABLE templates_new (
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
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    readme TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    remote_id TEXT,
                    published_at TEXT,
                    origin TEXT NOT NULL DEFAULT 'own' CHECK(origin IN ('own','saved')),
                    origin_owner TEXT,
                    withdrawn INTEGER NOT NULL DEFAULT 0,
                    server_id TEXT,
                    server_revision INTEGER,
                    base_revision INTEGER,
                    sync_state TEXT NOT NULL DEFAULT 'synced' CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending', 'conflict')),
                    kind TEXT NOT NULL DEFAULT 'own' CHECK(kind IN ('own', 'saved')),
                    owner_handle TEXT,
                    synced_at TEXT
                );",
            )?;
            // Copy common columns; old rows always have the sync columns after ensure_sync_schema.
            conn.execute(
                "INSERT INTO templates_new
                    (id, name, page_w_mm, page_h_mm, orientation, html, css, compiled_css, compiled_key,
                     created_at, updated_at, readme, summary, remote_id, published_at, origin, origin_owner,
                     withdrawn, server_id, server_revision, base_revision, sync_state, kind, owner_handle, synced_at)
                 SELECT id, name, page_w_mm, page_h_mm, orientation, html, css, compiled_css, compiled_key,
                     created_at, updated_at, readme, summary, remote_id, published_at, origin, origin_owner,
                     withdrawn, server_id, server_revision, base_revision, sync_state, kind, owner_handle, synced_at
                 FROM templates",
                [],
            )?;
            conn.execute("DROP TABLE templates", [])?;
            conn.execute("ALTER TABLE templates_new RENAME TO templates", [])?;
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_server_id ON templates(server_id);",
                [],
            )?;
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_templates_remote ON templates(remote_id);",
                [],
            )?;
        }
        if has_versions_table > 0 {
            conn.execute("DROP TABLE IF EXISTS template_versions", [])?;
            conn.execute("DROP INDEX IF EXISTS idx_versions_template", [])?;
        }
        if has_job_version_col {
            conn.execute_batch(
                "CREATE TABLE print_jobs_new (
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
                    data_json TEXT,
                    idempotency_key TEXT,
                    is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0, 1)),
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    started_at TEXT,
                    finished_at TEXT,
                    duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
                    timings_json TEXT
                );",
            )?;
            conn.execute(
                "INSERT INTO print_jobs_new
                    (id, batch_id, record_index, template_id, printer_id, source, source_url, status, error,
                     copies, settings_json, rendered_html, data_json, idempotency_key, is_test,
                     created_at, started_at, finished_at, duration_ms, timings_json)
                 SELECT id, batch_id, record_index, template_id, printer_id, source, source_url, status, error,
                     copies, settings_json, rendered_html, data_json, idempotency_key, is_test,
                     created_at, started_at, finished_at, duration_ms, timings_json
                 FROM print_jobs",
                [],
            )?;
            conn.execute("DROP TABLE print_jobs", [])?;
            conn.execute("ALTER TABLE print_jobs_new RENAME TO print_jobs", [])?;
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status);
                 CREATE INDEX IF NOT EXISTS idx_jobs_printer ON print_jobs(printer_id);
                 CREATE INDEX IF NOT EXISTS idx_jobs_template ON print_jobs(template_id);
                 CREATE INDEX IF NOT EXISTS idx_jobs_batch ON print_jobs(batch_id);
                 CREATE INDEX IF NOT EXISTS idx_jobs_created ON print_jobs(created_at);
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_idempotency ON print_jobs(idempotency_key);",
            )?;
        }
        Ok(())
    })();
    if fk_before != 0 {
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
    }
    rebuild_result?;
    // Sanitize content columns on old rows (kept outside the rebuild so it
    // also covers fresh rows written before this migration existed).
    conn.execute_batch(
        "UPDATE templates SET html = '' WHERE html IS NULL;
         UPDATE templates SET css = '' WHERE css IS NULL;",
    )?;
    Ok(())
}

/// P2 CHECK backfill for databases created before `schema.sql` carried
/// them. Fresh installs already satisfy every rule below; this brings
/// old files to the same constraints.
///
/// Two phases, both idempotent. First, sanitizing UPDATEs rewrite rows
/// that would violate the new CHECKs into documented safe values — the
/// fallbacks only fire on rows no current write path can produce
/// (uploads, edits, batches and sync all validate first), and they exist
/// so a legacy or hand-edited row can never wedge the upgrade. Then each
/// table missing its marker is rebuilt with the constraints.
///
/// Rebuilds copy every column explicitly (migrations added columns
/// after v1), recreate the table's indexes, and run with foreign keys
/// off and back on, like `ensure_created_by_allows_sync`.
fn ensure_p2_checks(conn: &Connection) -> rusqlite::Result<()> {
    // Sanitise first: every UPDATE is a no-op on a clean database.
    // Names fall back to a visible placeholder (never silently dropped);
    // numerics clamp to the nearest valid value; counters keep the
    // worker's invariant failed <= done <= total; rows that cannot be
    // made valid (empty setting keys, unusable API hashes) are deleted.
    conn.execute_batch(
        "UPDATE printers SET name = '(unnamed)' WHERE trim(name) = '';
         UPDATE printers SET address = '(unknown)' WHERE trim(address) = '';
         UPDATE printers SET dpi = 203 WHERE dpi IS NOT NULL AND dpi <= 0;
         UPDATE printers SET paper_width_mm = NULL
             WHERE paper_width_mm IS NOT NULL AND paper_width_mm <= 0;
         UPDATE templates SET name = '(unnamed)' WHERE trim(name) = '';
         UPDATE templates SET page_w_mm = 210 WHERE page_w_mm <= 0;
         UPDATE templates SET page_h_mm = 297 WHERE page_h_mm <= 0;
         UPDATE fonts SET family = '(unnamed)' WHERE trim(family) = '';
         UPDATE fonts SET format = 'ttf'
             WHERE format NOT IN ('ttf', 'otf', 'woff', 'woff2');
         UPDATE fonts SET size_bytes = 0 WHERE size_bytes < 0;
         UPDATE batches SET total = 0 WHERE total < 0;
         UPDATE batches SET done = 0 WHERE done < 0;
         UPDATE batches SET failed = 0 WHERE failed < 0;
         UPDATE batches SET done = total WHERE done > total;
         UPDATE batches SET failed = done WHERE failed > done;
         UPDATE print_jobs SET copies = 1 WHERE copies < 1;
         UPDATE print_jobs SET is_test = 0 WHERE is_test NOT IN (0, 1);
         UPDATE print_jobs SET duration_ms = NULL
             WHERE duration_ms IS NOT NULL AND duration_ms < 0;
         UPDATE print_jobs SET record_index = NULL
             WHERE record_index IS NOT NULL AND record_index < 0;
         DELETE FROM settings WHERE key = '';",
    )?;

    rebuild_p2(
        conn,
        "printers",
        "length(address) > 0",
        "CREATE TABLE printers_new (
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
        );",
        "id, name, type, address, language, paper_width_mm, dpi, default_settings_json, created_at, updated_at",
        &[],
    )?;
    rebuild_p2(
        conn,
        "templates",
        "page_w_mm > 0",
        "CREATE TABLE templates_new (
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
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            readme TEXT NOT NULL DEFAULT '',
            summary TEXT NOT NULL DEFAULT '',
            remote_id TEXT,
            published_at TEXT,
            origin TEXT NOT NULL DEFAULT 'own' CHECK(origin IN ('own','saved')),
            origin_owner TEXT,
            withdrawn INTEGER NOT NULL DEFAULT 0,
            server_id TEXT,
            server_revision INTEGER,
            base_revision INTEGER,
            sync_state TEXT NOT NULL DEFAULT 'synced' CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending', 'conflict')),
            kind TEXT NOT NULL DEFAULT 'own' CHECK(kind IN ('own', 'saved')),
            owner_handle TEXT,
            synced_at TEXT
        );",
        "id, name, page_w_mm, page_h_mm, orientation, html, css, compiled_css, compiled_key, created_at, updated_at, readme, summary, remote_id, published_at, origin, origin_owner, withdrawn, server_id, server_revision, base_revision, sync_state, kind, owner_handle, synced_at",
        &[
            "CREATE INDEX IF NOT EXISTS idx_templates_remote ON templates(remote_id);",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_server_id ON templates(server_id);",
        ],
    )?;
    // Versions are gone: drop any leftover table from old databases.
    conn.execute("DROP TABLE IF EXISTS template_versions", [])?;
    conn.execute("DROP INDEX IF EXISTS idx_versions_template", [])?;
    rebuild_p2(
        conn,
        "fonts",
        "length(family) > 0",
        "CREATE TABLE fonts_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family TEXT NOT NULL CHECK(length(family) > 0),
            style TEXT NOT NULL DEFAULT 'normal',
            weight TEXT NOT NULL DEFAULT '400',
            file_path TEXT NOT NULL,
            format TEXT NOT NULL CHECK(format IN ('ttf', 'otf', 'woff', 'woff2')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            server_id TEXT,
            server_revision INTEGER,
            base_revision INTEGER,
            sync_state TEXT NOT NULL DEFAULT 'synced' CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending', 'conflict')),
            synced_at TEXT,
            sha256 TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0)
        );",
        "id, family, style, weight, file_path, format, created_at, server_id, server_revision, base_revision, sync_state, synced_at, sha256, size_bytes",
        &["CREATE UNIQUE INDEX IF NOT EXISTS idx_fonts_server_id ON fonts(server_id);"],
    )?;
    rebuild_p2(
        conn,
        "batches",
        "failed <= done",
        "CREATE TABLE batches_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
            printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
            total INTEGER NOT NULL DEFAULT 0 CHECK(total >= 0),
            done INTEGER NOT NULL DEFAULT 0 CHECK(done >= 0),
            failed INTEGER NOT NULL DEFAULT 0 CHECK(failed >= 0),
            mode TEXT NOT NULL DEFAULT 'single_job' CHECK(mode IN ('single_job', 'per_record')),
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'printing', 'success', 'failed', 'cancelled')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK(failed <= done AND done <= total)
        );",
        "id, template_id, printer_id, total, done, failed, mode, status, created_at",
        &[],
    )?;
    rebuild_p2(
        conn,
        "print_jobs",
        "copies >= 1",
        "CREATE TABLE print_jobs_new (
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
            data_json TEXT,
            idempotency_key TEXT,
            is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0, 1)),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            started_at TEXT,
            finished_at TEXT,
            duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
            timings_json TEXT
        );",
        "id, batch_id, record_index, template_id, printer_id, source, source_url, status, error, copies, settings_json, rendered_html, data_json, idempotency_key, is_test, created_at, started_at, finished_at, duration_ms, timings_json",
        &[
            "CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status);",
            "CREATE INDEX IF NOT EXISTS idx_jobs_printer ON print_jobs(printer_id);",
            "CREATE INDEX IF NOT EXISTS idx_jobs_template ON print_jobs(template_id);",
            "CREATE INDEX IF NOT EXISTS idx_jobs_batch ON print_jobs(batch_id);",
            "CREATE INDEX IF NOT EXISTS idx_jobs_created ON print_jobs(created_at);",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_print_jobs_idempotency ON print_jobs(idempotency_key);",
        ],
    )?;
    rebuild_p2(
        conn,
        "settings",
        "length(key) > 0",
        "CREATE TABLE settings_new (
            key TEXT PRIMARY KEY CHECK(length(key) > 0),
            value TEXT NOT NULL,
            sync_state TEXT NOT NULL DEFAULT 'synced' CHECK(sync_state IN ('synced', 'dirty', 'deleted_pending')),
            synced_at TEXT
        );",
        "key, value, sync_state, synced_at",
        &[],
    )?;
    Ok(())
}

/// Rebuilds one table with new CHECKs when its marker is absent from the
/// stored DDL. Copies every column explicitly, recreates the table's
/// indexes, and runs atomically with foreign keys off and restored —
/// the same shape as `ensure_created_by_allows_sync`.
fn rebuild_p2(
    conn: &Connection,
    table: &str,
    marker: &str,
    create_new: &str,
    columns: &str,
    indexes: &[&str],
) -> rusqlite::Result<()> {
    let sql: Option<String> = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |r| r.get(0),
    )?;
    if sql.is_some_and(|s| s.contains(marker)) {
        return Ok(());
    }
    let fk_before: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;

    let mut script = format!(
        "BEGIN;
         {create_new}
         INSERT INTO {table}_new ({columns}) SELECT {columns} FROM {table};
         DROP TABLE {table};
         ALTER TABLE {table}_new RENAME TO {table};"
    );
    for index in indexes {
        script.push_str(index);
    }
    script.push_str("COMMIT;");
    let result = conn.execute_batch(&script);
    if fk_before != 0 {
        // Best effort, as in `ensure_created_by_allows_sync`.
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
    }
    result?;
    Ok(())
}
