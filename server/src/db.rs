use rusqlite::Connection;

pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,
            handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS templates (
            id          TEXT PRIMARY KEY,
            owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            summary     TEXT NOT NULL DEFAULT '',
            page_w_mm   REAL NOT NULL,
            page_h_mm   REAL NOT NULL,
            language    TEXT NOT NULL,
            body        TEXT NOT NULL,
            readme      TEXT NOT NULL DEFAULT '',
            css         TEXT NOT NULL DEFAULT '',
            use_count   INTEGER NOT NULL DEFAULT 0,
            published_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tpl_owner   ON templates(owner_id);
        CREATE INDEX IF NOT EXISTS idx_tpl_updated ON templates(updated_at);

        CREATE TABLE IF NOT EXISTS saved_templates (
            user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
            added_at    TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, template_id)
        );
        "#,
    )?;
    Ok(())
}

pub fn open_db(path: &str) -> rusqlite::Result<Connection> {
    let conn = if path == ":memory:" {
        Connection::open_in_memory()?
    } else {
        Connection::open(path)?
    };
    init_db(&conn)?;
    // Enable foreign keys
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}
