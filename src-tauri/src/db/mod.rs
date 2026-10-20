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
    ensure_sync_schema(conn)
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
    if !column_exists(conn, "template_versions", "compiled_css")? {
        conn.execute(
            "ALTER TABLE template_versions ADD COLUMN compiled_css TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "template_versions", "compiled_key")? {
        conn.execute(
            "ALTER TABLE template_versions ADD COLUMN compiled_key TEXT NOT NULL DEFAULT ''",
            [],
        )?;
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

    // `regenerate_api_key` upserts with ON CONFLICT(name), which SQLite only
    // accepts when `name` has a UNIQUE constraint/index.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_clients_name ON api_clients(name)",
        [],
    )?;

    // Section 3 dead code: `sample_datasets` and `presets` were created
    // by the schema but no Rust code ever read or wrote them, so they
    // were always empty. New databases no longer create them; existing
    // ones are tidied here.
    conn.execute("DROP TABLE IF EXISTS sample_datasets", [])?;
    conn.execute("DROP TABLE IF EXISTS presets", [])?;

    ensure_created_by_allows_sync(conn)?;

    Ok(())
}

/// `template_versions.created_by` originally had a CHECK without 'sync', and
/// SQLite cannot ALTER a CHECK constraint — only rebuild the table. A fresh
/// database gets the current DDL from `schema.sql`; an existing one is
/// rebuilt here, keeping every row (Phase 0, P2).
fn ensure_created_by_allows_sync(conn: &Connection) -> rusqlite::Result<()> {
    let sql: Option<String> = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'template_versions'",
        [],
        |r| r.get(0),
    )?;
    // Already current: the new CHECK lists 'sync'.
    if sql.is_some_and(|s| s.contains("'sync'")) {
        return Ok(());
    }

    // Foreign keys off for the rebuild: `print_jobs.template_version_id`
    // references this table, and renaming a table with FKs on rewrites the
    // child's REFERENCES clause. `foreign_keys` is off by default in rusqlite,
    // but restore whatever it was so the pragma choice is not ours to change.
    let fk_before: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;

    let rebuild = "
        BEGIN;
        CREATE TABLE template_versions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
            version_no INTEGER NOT NULL,
            html TEXT NOT NULL,
            css TEXT NOT NULL DEFAULT '',
            label TEXT,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            created_by TEXT NOT NULL DEFAULT 'manual'
                CHECK(created_by IN ('manual', 'autosave', 'restore', 'sync')),
            compiled_css TEXT NOT NULL DEFAULT '',
            compiled_key TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO template_versions_new
            (id, template_id, version_no, html, css, label, note,
             created_at, created_by, compiled_css, compiled_key)
        SELECT id, template_id, version_no, html, css, label, note,
               created_at, created_by,
               COALESCE(compiled_css, ''), COALESCE(compiled_key, '')
        FROM template_versions;
        DROP TABLE template_versions;
        ALTER TABLE template_versions_new RENAME TO template_versions;
        CREATE INDEX IF NOT EXISTS idx_versions_template ON template_versions(template_id);
        COMMIT;";
    let result = conn.execute_batch(rebuild);
    if fk_before != 0 {
        // Put back what we found; best effort — a failure here would mean the
        // pragma did not take originally either.
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
    }
    result?;
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
    Ok(())
}
