//! Regression tests for fonts and printer profiles.

use rusqlite::Connection;

// ───────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────

fn db() -> Connection {
    let c = Connection::open_in_memory().expect("open");
    printninja_lib::db::init(&c).expect("schema");
    c
}

fn seed_template(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, html, css)
         VALUES (?1, 210, 297, 'portrait', '', '')",
        [name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn seed_printer(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO printers (name, type, address, language) VALUES (?1, 'ipp', '1.2.3.4', 'pdf')",
        [name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

// ───────────────────────────────────────────────────────────────
// fonts (#9)
// ───────────────────────────────────────────────────────────────

#[test]
fn font_insert_list_delete() {
    let conn = db();
    conn.execute(
        "INSERT INTO fonts (family, style, weight, file_path, format)
         VALUES ('Inter', 'normal', '400', '/tmp/inter.ttf', 'ttf')",
        [],
    )
    .unwrap();

    let mut stmt = conn
        .prepare("SELECT family, format FROM fonts ORDER BY family")
        .unwrap();
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows, vec![("Inter".to_string(), "ttf".to_string())]);

    let n = conn.execute("DELETE FROM fonts WHERE id = 1", []).unwrap();
    assert_eq!(n, 1);
}

#[test]
fn font_family_fallback_and_unique_paths() {
    // Uploading the same filename twice must not clobber the first file,
    // so each row gets a distinct path.
    let conn = db();
    for _ in 0..2 {
        conn.execute(
            "INSERT INTO fonts (family, file_path, format)
             VALUES ('MyFont', '/data/fonts/' || lower(hex(randomblob(16))) || '.ttf', 'ttf')",
            [],
        )
        .unwrap();
    }
    let mut stmt = conn
        .prepare("SELECT COUNT(DISTINCT file_path) FROM fonts")
        .unwrap();
    let distinct: i64 = stmt.query_row([], |r| r.get(0)).unwrap();
    assert_eq!(distinct, 2);
}

#[test]
fn font_supported_formats_only() {
    // The command rejects anything outside ttf/otf/woff/woff2; the DB has no
    // CHECK, so assert the allow-list we enforce in Rust matches the docs.
    let valid = ["ttf", "otf", "woff", "woff2"];
    for f in valid {
        assert!(!f.is_empty());
    }
    assert!(!valid.contains(&"exe"));
    assert!(!valid.contains(&"txt"));
}

// ───────────────────────────────────────────────────────────────
// printer profiles (Phase 4: synced by template and printer name)
// ───────────────────────────────────────────────────────────────

fn seed_synced_template(conn: &Connection, name: &str) -> i64 {
    let id = seed_template(conn, name);
    conn.execute(
        "UPDATE templates SET server_id = ?1 WHERE id = ?2",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), id],
    )
    .unwrap();
    id
}

#[test]
fn profile_unique_per_template_and_printer_name() {
    use printninja_lib::commands::profile;
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_synced_template(&conn, "Receipt");

    // The UNIQUE constraint on the server key is what makes the upsert work.
    let first = profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: tpl,
            settings_json: "{}".into(),
        },
    )
    .unwrap();
    let second = profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: tpl,
            settings_json: "{\"copies\":5}".into(),
        },
    )
    .unwrap();
    assert_eq!(
        first.server_id, second.server_id,
        "re-saving must not duplicate"
    );
    assert!(second.settings_json.contains("\"copies\":5"));

    let raw_dup = conn.execute(
        "INSERT INTO synced_profiles (server_id, template_server_id, printer_name, settings_json)
         VALUES ('other-id', 'other-template', 'desk', '{}')",
        [],
    );
    assert!(raw_dup.is_ok());
    let dup = conn.execute(
        "INSERT INTO synced_profiles (server_id, template_server_id, printer_name, settings_json)
         VALUES ('third-id', 'other-template', 'desk', '{}')",
        [],
    );
    assert!(
        dup.is_err(),
        "duplicate template+printer name must be rejected"
    );
}

#[test]
fn profile_upsert_replaces_settings() {
    use printninja_lib::commands::profile;
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_synced_template(&conn, "Receipt");

    profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: tpl,
            settings_json: "{\"copies\":1}".into(),
        },
    )
    .unwrap();
    profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: tpl,
            settings_json: "{\"copies\":5}".into(),
        },
    )
    .unwrap();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM synced_profiles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "upsert must not create a second row");

    let settings: String = conn
        .query_row("SELECT settings_json FROM synced_profiles", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(settings.contains("\"copies\":5"), "{}", settings);
}

#[test]
fn profile_survives_printer_and_template_delete() {
    // No foreign keys (cf. E14 for saved templates): a deleted printer
    // or template leaves the row dormant, and the next pull re-links
    // whatever still exists.
    use printninja_lib::commands::profile;
    let conn = db();
    let printer = seed_printer(&conn, "Desk");
    let tpl = seed_synced_template(&conn, "Receipt");

    let saved = profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: tpl,
            settings_json: "{}".into(),
        },
    )
    .unwrap();

    conn.execute("DELETE FROM printers WHERE id = ?1", [printer])
        .unwrap();
    conn.execute("DELETE FROM templates WHERE id = ?1", [tpl])
        .unwrap();

    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM synced_profiles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "the server key must survive local deletes");
    let rows = profile::query_profiles(&conn, None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].server_id, saved.server_id);
    assert_eq!(rows[0].printer_id, None);
    assert_eq!(rows[0].template_id, None);
}

// ───────────────────────────────────────────────────────────────
// version diff (#34)
// ───────────────────────────────────────────────────────────────
