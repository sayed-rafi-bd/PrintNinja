//! Phase 4 library sync: datasets, profiles, account preferences and
//! fonts (REFACTORING.md Phase 4). Plain-function tests over an
//! in-memory database; the Tauri wrappers only lock and delegate.

use printninja_lib::commands::cache::{clear_account, ApplyReport};
use printninja_lib::commands::{datasets, font, profile, settings};
use printninja_lib::db;
use rusqlite::Connection;

fn db() -> Connection {
    let c = Connection::open_in_memory().expect("open");
    db::init(&c).expect("schema");
    c
}

fn report() -> ApplyReport {
    ApplyReport {
        applied_upserts: 0,
        applied_deletes: 0,
        skipped_dirty: 0,
    }
}

fn seed_template(conn: &Connection, name: &str) -> (i64, String) {
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES (?1, 210, 297, 'portrait')",
        [name],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    let server_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "UPDATE templates SET server_id = ?1 WHERE id = ?2",
        rusqlite::params![server_id, id],
    )
    .unwrap();
    (id, server_id)
}

fn seed_printer(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO printers (name, type, address, language) VALUES (?1, 'ipp', '1.2.3.4', 'pdf')",
        [name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

// ── schema ──

#[test]
fn library_tables_and_columns_exist() {
    let conn = db();
    for table in ["synced_datasets", "synced_profiles"] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{table} missing");
    }
    assert!(db::column_exists(&conn, "settings", "sync_state").unwrap());
    assert!(db::column_exists(&conn, "fonts", "server_id").unwrap());
    assert!(db::column_exists(&conn, "fonts", "sha256").unwrap());
    let old: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'printer_profiles'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old, 0, "old printer_profiles must be gone after migration");
}

#[test]
fn old_profiles_migrate_keyed_by_printer_name() {
    // Migration runs at init, so build the pre-Phase-4 shape by hand:
    // v1 DDL plus the sync columns, then the old profiles table.
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(include_str!("../src/db/schema.sql"))
        .expect("v1 ddl");
    db::ensure_v2_schema(&conn).unwrap();
    db::ensure_sync_schema(&conn).unwrap();

    conn.execute(
        "INSERT INTO printers (name, type, address, language) VALUES ('E2E Label Printer', 'ipp', 'x', 'pdf')",
        [],
    )
    .unwrap();
    let printer: i64 = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation) VALUES ('T', 210, 297, 'portrait')",
        [],
    )
    .unwrap();
    let template: i64 = conn.last_insert_rowid();
    conn.execute(
        "UPDATE templates SET server_id = ?1 WHERE id = ?2",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), template],
    )
    .unwrap();
    conn.execute(
        "CREATE TABLE printer_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            printer_id INTEGER NOT NULL, template_id INTEGER NOT NULL,
            settings_json TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE (printer_id, template_id))",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO printer_profiles (printer_id, template_id, settings_json)
         VALUES (?1, ?2, '{\"dark\":true}')",
        rusqlite::params![printer, template],
    )
    .unwrap();

    db::ensure_library_schema(&conn).unwrap();

    let (name, template_key, state): (String, String, String) = conn
        .query_row(
            "SELECT printer_name, template_server_id, sync_state FROM synced_profiles",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(name, "e2e label printer");
    assert_eq!(state, "dirty");
    let server_id: String = conn
        .query_row(
            "SELECT server_id FROM templates WHERE id = ?1",
            [template],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(template_key, server_id);
    let old: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'printer_profiles'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old, 0, "old table dropped after migration");
}

// ── datasets ──

#[test]
fn dataset_save_list_update_delete() {
    let conn = db();
    let created = datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: None,
            name: "Orders".into(),
            data_json: "{\"rows\":[]}".into(),
        },
    )
    .unwrap();
    assert_eq!(created.name, "Orders");
    assert!(!created.server_id.is_empty());

    let listed = datasets::query_datasets(&conn).unwrap();
    assert_eq!(listed.len(), 1);

    let updated = datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: Some(created.id),
            name: "Orders v2".into(),
            data_json: "{\"rows\":[1]}".into(),
        },
    )
    .unwrap();
    assert_eq!(updated.name, "Orders v2");
    assert_eq!(updated.server_id, created.server_id);

    datasets::tombstone_dataset(&conn, created.id).unwrap();
    assert_eq!(datasets::list_tombstoned_datasets(&conn).unwrap().len(), 1);
    assert!(datasets::forget_dataset(&conn, &created.server_id).unwrap());
    assert!(datasets::query_datasets(&conn).unwrap().is_empty());
}

#[test]
fn dataset_rejects_bad_writes() {
    let conn = db();
    assert!(datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: None,
            name: "  ".into(),
            data_json: "{}".into(),
        },
    )
    .is_err());
    assert!(datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: None,
            name: "X".into(),
            data_json: "{nope".into(),
        },
    )
    .is_err());
    assert!(datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: None,
            name: "X".into(),
            data_json: format!("\"{}\"", "x".repeat(300_000)),
        },
    )
    .is_err());
    assert!(datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: Some(999),
            name: "X".into(),
            data_json: "{}".into(),
        },
    )
    .is_err());
}

#[test]
fn dataset_cache_roundtrip() {
    let conn = db();
    // A local save is dirty with no base revision.
    let created = datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: None,
            name: "D".into(),
            data_json: "{}".into(),
        },
    )
    .unwrap();
    let dirty = datasets::list_dirty_datasets(&conn).unwrap();
    assert_eq!(dirty.len(), 1);
    assert_eq!(dirty[0].base_revision, None);

    datasets::mark_dataset_pushed(&conn, &created.server_id, 1).unwrap();
    assert!(datasets::list_dirty_datasets(&conn).unwrap().is_empty());
    assert_eq!(datasets::list_synced_datasets(&conn).unwrap().len(), 1);

    // The server copy applies over the synced row.
    let tx = conn.unchecked_transaction().unwrap();
    datasets::apply_dataset_upsert(
        &tx,
        &datasets::DatasetDataIn {
            id: created.server_id.clone(),
            name: "D2".into(),
            data_json: "{\"a\":1}".into(),
            revision: 2,
        },
        &mut report(),
    )
    .unwrap();
    tx.commit().unwrap();
    let after = datasets::query_datasets(&conn).unwrap();
    assert_eq!(after[0].name, "D2");

    // Dirty rows survive the pull.
    datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: Some(created.id),
            name: "Local".into(),
            data_json: "{}".into(),
        },
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let mut skipped = report();
    datasets::apply_dataset_upsert(
        &tx,
        &datasets::DatasetDataIn {
            id: created.server_id.clone(),
            name: "Server".into(),
            data_json: "{}".into(),
            revision: 3,
        },
        &mut skipped,
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(skipped.skipped_dirty, 1);
    let kept = datasets::query_datasets(&conn).unwrap();
    assert_eq!(kept[0].name, "Local");

    // A synced delete removes the row; a missing one is idempotent.
    datasets::mark_dataset_pushed(&conn, &created.server_id, 3).unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    datasets::apply_dataset_delete(&tx, &created.server_id, &mut report()).unwrap();
    tx.commit().unwrap();
    assert!(datasets::query_datasets(&conn).unwrap().is_empty());
    let tx = conn.unchecked_transaction().unwrap();
    datasets::apply_dataset_delete(&tx, &created.server_id, &mut report()).unwrap();
    tx.commit().unwrap();
}

// ── profiles ──

#[test]
fn profile_save_resolves_the_server_key() {
    let conn = db();
    let printer = seed_printer(&conn, "E2E Label Printer");
    let (template, template_server) = seed_template(&conn, "T");

    let saved = profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: template,
            settings_json: "{\"dark\":true}".into(),
        },
    )
    .unwrap();
    assert_eq!(saved.printer_name, "e2e label printer");
    assert_eq!(saved.template_server_id, template_server);
    assert_eq!(saved.printer_id, Some(printer));
    assert_eq!(saved.template_id, Some(template));

    // Re-saving the same key updates in place, keeping the server id.
    let again = profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: template,
            settings_json: "{\"dark\":false}".into(),
        },
    )
    .unwrap();
    assert_eq!(again.server_id, saved.server_id);
    assert_eq!(again.settings_json, "{\"dark\":false}");
}

#[test]
fn profile_save_rejects_bad_writes() {
    let conn = db();
    let printer = seed_printer(&conn, "P");
    let (template, _) = seed_template(&conn, "T");
    // Unknown printer or template.
    assert!(profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: 999,
            template_id: template,
            settings_json: "{}".into(),
        },
    )
    .is_err());
    assert!(profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: 999,
            settings_json: "{}".into(),
        },
    )
    .is_err());
    // Not JSON.
    assert!(profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: template,
            settings_json: "{nope".into(),
        },
    )
    .is_err());
}

#[test]
fn profile_list_filters_and_goes_dormant() {
    let conn = db();
    let printer = seed_printer(&conn, "E2E Label Printer");
    let other = seed_printer(&conn, "Office Inkjet");
    let (template, _) = seed_template(&conn, "T");
    let saved = profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: template,
            settings_json: "{}".into(),
        },
    )
    .unwrap();

    assert_eq!(
        profile::query_profiles(&conn, Some(printer), Some(template))
            .unwrap()
            .len(),
        1
    );
    assert!(profile::query_profiles(&conn, Some(other), Some(template))
        .unwrap()
        .is_empty());

    // Renaming the printer leaves the profile dormant: the key no
    // longer matches any local printer.
    conn.execute(
        "UPDATE printers SET name = 'Renamed' WHERE id = ?1",
        [printer],
    )
    .unwrap();
    assert!(
        profile::query_profiles(&conn, Some(printer), Some(template))
            .unwrap()
            .is_empty()
    );
    let dormant = profile::query_profiles(&conn, None, None).unwrap();
    assert_eq!(dormant.len(), 1);
    assert_eq!(dormant[0].printer_id, None);

    // The tombstone path works by local id.
    profile::tombstone_profile(&conn, saved.id).unwrap();
    assert_eq!(profile::list_tombstoned_profiles(&conn).unwrap().len(), 1);
    assert!(profile::forget_profile(&conn, &saved.server_id).unwrap());
}

#[test]
fn profile_cache_roundtrip() {
    let conn = db();
    let printer = seed_printer(&conn, "E2E");
    let (template, template_server) = seed_template(&conn, "T");
    let saved = profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: template,
            settings_json: "{\"a\":1}".into(),
        },
    )
    .unwrap();

    let dirty = profile::list_dirty_profiles(&conn).unwrap();
    assert_eq!(dirty.len(), 1);
    assert_eq!(dirty[0].template_id, template_server);
    profile::mark_profile_pushed(&conn, &saved.server_id, 1).unwrap();
    assert_eq!(profile::list_synced_profiles(&conn).unwrap().len(), 1);

    // A pull for an unknown printer stores the row dormant.
    let tx = conn.unchecked_transaction().unwrap();
    profile::apply_profile_upsert(
        &tx,
        &profile::ProfileDataIn {
            id: "p-remote".into(),
            template_id: template_server.clone(),
            printer_name: "ghost printer".into(),
            settings_json: "{}".into(),
            revision: 1,
        },
        &mut report(),
    )
    .unwrap();
    tx.commit().unwrap();
    let all = profile::query_profiles(&conn, None, None).unwrap();
    assert_eq!(all.len(), 2);
    let ghost = all.iter().find(|p| p.server_id == "p-remote").unwrap();
    assert_eq!(ghost.printer_id, None);
    assert_eq!(ghost.template_id, Some(template));
}

// ── settings ──

#[test]
fn settings_allow_list_drives_dirtiness() {
    let conn = db();
    // Device keys never leave: they stay synced no matter what.
    for key in [
        "api_port",
        "api_lan_access",
        "trusted_sources",
        "onboarding_done",
        "share_service_url",
        "share_session_token",
        "sync_adopted",
        "install_migrated",
        "retention_days",
    ] {
        settings::write_setting(&conn, key, "x").unwrap();
    }
    assert!(settings::list_dirty_settings(&conn).unwrap().is_empty());

    // Account keys go dirty on write...
    settings::write_setting(&conn, "ui_density", "compact").unwrap();
    settings::write_setting(&conn, "brand_name", "Acme").unwrap();
    let dirty = settings::list_dirty_settings(&conn).unwrap();
    assert_eq!(dirty.len(), 2);
    assert!(dirty.iter().all(|d| !d.tombstone));

    // ...an empty value resets instead: the engine deletes it upstream.
    settings::write_setting(&conn, "brand_name", "").unwrap();
    let dirty = settings::list_dirty_settings(&conn).unwrap();
    let reset = dirty.iter().find(|d| d.key == "brand_name").unwrap();
    assert!(reset.tombstone);

    settings::mark_setting_pushed(&conn, "ui_density").unwrap();
    let dirty = settings::list_dirty_settings(&conn).unwrap();
    assert_eq!(dirty.len(), 1);
    assert_eq!(dirty[0].key, "brand_name");
}

#[test]
fn settings_apply_roundtrip() {
    let conn = db();
    // A server value lands as synced.
    let tx = conn.unchecked_transaction().unwrap();
    settings::apply_setting_upsert(
        &tx,
        &settings::SettingDataIn {
            key: "ui_density".into(),
            value: "compact".into(),
            revision: 2,
        },
        &mut report(),
    )
    .unwrap();
    tx.commit().unwrap();
    let v: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'ui_density'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v, "compact");

    // A dirty local edit survives the pull.
    settings::write_setting(&conn, "ui_density", "comfortable").unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let mut skipped = report();
    settings::apply_setting_upsert(
        &tx,
        &settings::SettingDataIn {
            key: "ui_density".into(),
            value: "compact".into(),
            revision: 3,
        },
        &mut skipped,
    )
    .unwrap();
    tx.commit().unwrap();
    assert_eq!(skipped.skipped_dirty, 1);

    // A synced reset deletes the row; a dirty one is kept.
    settings::mark_setting_pushed(&conn, "ui_density").unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    settings::apply_setting_delete(&tx, "ui_density", &mut report()).unwrap();
    tx.commit().unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key = 'ui_density'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

// ── fonts ──

fn seed_font(conn: &Connection, family: &str, sha: &str) -> (i64, String) {
    let server_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO fonts (family, style, weight, file_path, format,
                server_id, sync_state, sha256, size_bytes)
         VALUES (?1, 'normal', '400', '', 'ttf', ?2, 'synced', ?3, 0)",
        rusqlite::params![family, server_id, sha],
    )
    .unwrap();
    (conn.last_insert_rowid(), server_id)
}

#[test]
fn font_upload_refuses_the_wrong_content() {
    // Extension alone is not enough: magic bytes must match the format.
    assert!(font::check_upload_bytes("body.ttf", &[0x00, 0x01, 0x00, 0x00, 0x01]).is_ok());
    assert!(font::check_upload_bytes("body.otf", b"OTTOjunk").is_ok());
    assert!(font::check_upload_bytes("evil.ttf", b"%PDF-1.4 nope").is_err());
    assert!(font::check_upload_bytes("evil.woff2", &[0x00, 0x01, 0x00, 0x00]).is_err());
    assert!(font::check_upload_bytes("nope.exe", &[0x00, 0x01, 0x00, 0x00]).is_err());
    assert!(font::check_upload_bytes("empty.ttf", &[]).is_err());
}

#[test]
fn sync_rejects_fonts_with_bad_format_or_size() {
    use printninja_lib::commands::font::{apply_font_upsert, FontDataIn};
    use printninja_lib::commands::cache::ApplyReport;
    let conn = db();
    let bad_format = FontDataIn {
        id: "srv-x".into(),
        name: "X".into(),
        format: "exe".into(),
        size_bytes: 10,
        sha256: "0".repeat(64),
        revision: 1,
    };
    let mut report = ApplyReport {
        applied_upserts: 0,
        applied_deletes: 0,
        skipped_dirty: 0,
    };
    // No commit: the transaction rolls back on drop, like a failed page.
    let tx = conn.unchecked_transaction().unwrap();
    let err = apply_font_upsert(&tx, &bad_format, &mut report).unwrap_err();
    assert!(
        format!("{err:?}").contains("format"),
        "bad format must fail loudly: {err:?}"
    );
    let bad_size = FontDataIn {
        size_bytes: -5,
        format: "ttf".into(),
        ..bad_format
    };
    let err = apply_font_upsert(&tx, &bad_size, &mut report).unwrap_err();
    assert!(
        format!("{err:?}").contains("size"),
        "bad size must fail loudly: {err:?}"
    );
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM fonts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "rejected rows must not be stored");
}

#[test]
fn font_upload_refuses_oversize_files() {    let mut huge = vec![0x00, 0x01, 0x00, 0x00];
    huge.resize(font::MAX_FONT_BYTES + 1, 0xAA);
    let err = font::check_upload_bytes("huge.ttf", &huge).unwrap_err();
    assert!(
        format!("{err:?}").contains("max"),
        "oversize must name the cap: {err:?}"
    );
    // Exactly at the cap is accepted.
    huge.resize(font::MAX_FONT_BYTES, 0xAA);
    assert!(font::check_upload_bytes("huge.ttf", &huge).is_ok());
}

#[test]
fn font_sweep_removes_only_unreferenced_files() {
    let conn = db();
    let dir = font::fonts_dir_for_tests();
    std::fs::create_dir_all(&dir).unwrap();
    // Referenced by absolute path (old rows) and by bare name.
    std::fs::write(dir.join("keep-abs.ttf"), b"keep").unwrap();
    std::fs::write(dir.join("keep-rel.otf"), b"keep").unwrap();
    std::fs::write(dir.join("orphan.woff"), b"drop").unwrap();
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    for (name, path) in [
        ("Abs", dir.join("keep-abs.ttf").to_string_lossy().to_string()),
        ("Rel", "keep-rel.otf".to_string()),
    ] {
        conn.execute(
            "INSERT INTO fonts (family, style, weight, file_path, format, server_id, sync_state)
             VALUES (?1, 'normal', '400', ?2, 'ttf', lower(hex(randomblob(16))), 'synced')",
            rusqlite::params![name, path],
        )
        .unwrap();
    }
    let removed = font::sweep_orphan_font_files(&conn, &dir).expect("sweep works");
    assert_eq!(removed, 1);
    assert!(dir.join("keep-abs.ttf").exists());
    assert!(dir.join("keep-rel.otf").exists());
    assert!(!dir.join("orphan.woff").exists());
    assert!(dir.join("sub").exists(), "directories are never removed");
    // Missing dir is fine (fresh install, nothing to sweep).
    let missing = dir.join("nope");
    assert_eq!(font::sweep_orphan_font_files(&conn, &missing).unwrap(), 0);
}

#[test]
fn font_store_verifies_the_hash() {
    let conn = db();
    let dir = font::fonts_dir_for_tests();
    let bytes = vec![0x00, 0x01, 0x00, 0x00, 0xAA, 0xBB];
    let sha = font::sha256_hex(&bytes);
    let (_id, server_id) = seed_font(&conn, "Body", &sha);

    // Wrong content is refused and the row stays pending (no state
    // row yet, which reads as pending).
    assert!(font::store_font_file_bytes(&conn, &dir, &server_id, &[1, 2, 3]).is_err());
    let state: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [font::font_state_key(&server_id)],
            |r| r.get(0),
        )
        .ok();
    assert_eq!(state, None);

    font::store_font_file_bytes(&conn, &dir, &server_id, &bytes).unwrap();
    let (path, size, state): (String, i64, String) = conn
        .query_row(
            "SELECT f.file_path, f.size_bytes, s.value FROM fonts f
             JOIN settings s ON s.key = ?1 WHERE f.server_id = ?2",
            rusqlite::params![font::font_state_key(&server_id), server_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(size, 6);
    assert_eq!(state, "ready");
    // Stored as a bare filename; the directory resolves at use.
    assert_eq!(path, format!("{server_id}.ttf"));
    assert_eq!(std::fs::read(dir.join(&path)).unwrap(), bytes);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn font_cache_roundtrip_and_forget_removes_the_file() {
    let conn = db();
    let dir = font::fonts_dir_for_tests();
    let bytes = vec![0x00, 0x01, 0x00, 0x00];
    let sha = font::sha256_hex(&bytes);
    let (_id, server_id) = seed_font(&conn, "Body", &sha);
    font::store_font_file_bytes(&conn, &dir, &server_id, &bytes).unwrap();

    // Synced rows are never dirty; simulate a local rename.
    conn.execute(
        "UPDATE fonts SET family = 'Body 2', sync_state = 'dirty' WHERE server_id = ?1",
        [&server_id],
    )
    .unwrap();
    let dirty = font::list_dirty_fonts(&conn).unwrap();
    assert_eq!(dirty.len(), 1);
    assert_eq!(dirty[0].name, "Body 2");
    font::mark_font_pushed(&conn, &server_id, 3).unwrap();
    assert_eq!(font::list_synced_fonts(&conn).unwrap().len(), 1);

    // Forget removes the row and its bytes.
    let stored: String = conn
        .query_row(
            "SELECT file_path FROM fonts WHERE server_id = ?1",
            [&server_id],
            |r| r.get(0),
        )
        .unwrap();
    let on_disk = dir.join(&stored);
    assert!(on_disk.exists(), "bytes must be on disk before forget");
    assert!(font::forget_font(&conn, dir.as_path(), &server_id).unwrap());
    assert!(!on_disk.exists(), "forget must remove the bytes");
    assert!(!font::forget_font(&conn, dir.as_path(), &server_id).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn font_paths_survive_a_profile_move() {
    // Old rows hold absolute paths. After a move/restore the absolute
    // location is dead, but the basename still resolves in the new dir.
    let conn = db();
    let old_dir = font::fonts_dir_for_tests();
    let new_dir = font::fonts_dir_for_tests();
    std::fs::create_dir_all(&old_dir).unwrap();
    std::fs::create_dir_all(&new_dir).unwrap();
    let bytes = vec![0x00, 0x01, 0x00, 0x00, 0xAA];
    let stale = old_dir.join("dead.ttf");
    std::fs::write(&stale, &bytes).unwrap();
    let server_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO fonts (family, style, weight, file_path, format,
                server_id, sync_state, sha256, size_bytes)
         VALUES ('Old', 'normal', '400', ?1, 'ttf', ?2, 'synced', 'x', 5)",
        rusqlite::params![stale.to_string_lossy().to_string(), server_id],
    )
    .unwrap();
    // The file also exists under the new profile dir (restored backup).
    std::fs::write(new_dir.join("dead.ttf"), &bytes).unwrap();
    let read = font::read_font_file(&conn, &new_dir, &server_id).expect("resolves by basename");
    assert_eq!(read, bytes);
    let _ = std::fs::remove_dir_all(&old_dir);
    let _ = std::fs::remove_dir_all(&new_dir);
}

#[test]
fn clear_account_wipes_the_library() {
    let conn = db();
    datasets::store_dataset(
        &conn,
        datasets::SaveDatasetRequest {
            id: None,
            name: "D".into(),
            data_json: "{}".into(),
        },
    )
    .unwrap();
    let printer = seed_printer(&conn, "P");
    let (template, _) = seed_template(&conn, "T");
    profile::store_profile(
        &conn,
        profile::SaveProfileRequest {
            printer_id: printer,
            template_id: template,
            settings_json: "{}".into(),
        },
    )
    .unwrap();
    let dir = font::fonts_dir_for_tests();
    let bytes = vec![0x00, 0x01, 0x00, 0x00];
    let (_id, server_id) = seed_font(&conn, "Body", &font::sha256_hex(&bytes));
    font::store_font_file_bytes(&conn, &dir, &server_id, &bytes).unwrap();
    settings::write_setting(&conn, "ui_density", "compact").unwrap();

    clear_account(&conn, dir.as_path()).unwrap();

    for table in ["synced_datasets", "synced_profiles", "fonts"] {
        let n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table} not wiped");
    }
    // The preference value stays for the device; only the sync flag resets.
    let (value, state): (String, String) = conn
        .query_row(
            "SELECT value, sync_state FROM settings WHERE key = 'ui_density'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(value, "compact");
    assert_eq!(state, "synced");
    let _ = std::fs::remove_dir_all(&dir);
}
