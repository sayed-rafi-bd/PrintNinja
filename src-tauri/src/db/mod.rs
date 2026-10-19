use rusqlite::Connection;
use std::sync::{Arc, Mutex};

pub struct Database {
    pub url: String,
}

impl Database {
    /// Strip the `sqlite:` scheme that tauri-plugin-sql uses.
    /// rusqlite expects a raw filesystem path, not a URI.
    pub fn path(&self) -> &str {
        self.url.strip_prefix("sqlite:").unwrap_or(&self.url)
    }

    pub fn connection(&self) -> rusqlite::Result<Connection> {
        Connection::open(self.path())
    }
}

pub type DbState = Arc<Mutex<Database>>;

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
pub fn ensure_v2_schema(conn: &mut Connection) -> rusqlite::Result<()> {
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

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_templates_remote ON templates(remote_id)",
        [],
    )?;

    Ok(())
}
