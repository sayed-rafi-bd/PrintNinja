//! Sync-cache contract tests (REFACTORING.md section 11, Phase 3).
//!
//! The cases live in `tests/fixtures/cache_cases.json` and run here and
//! against the TypeScript fake agent, so the two implementations cannot
//! drift apart. Each case seeds local rows, applies one page through
//! `cache_apply_changes`, and asserts the rows, the cursor and the report.

use printninja_lib::commands::cache::{apply_changes, get_sync_state, SyncChangeIn};
use printninja_lib::db;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashMap;

fn load_cases() -> Vec<Value> {
    let text =
        std::fs::read_to_string("tests/fixtures/cache_cases.json").expect("read cache_cases.json");
    let doc: Value = serde_json::from_str(&text).expect("parse cache_cases.json");
    doc["cases"].as_array().expect("cases array").clone()
}

fn seed_template(conn: &Connection, fields: &HashMap<String, Value>) -> i64 {
    let name = fields.get("name").and_then(Value::as_str).unwrap_or("T");
    let server_id = fields
        .get("server_id")
        .and_then(Value::as_str)
        .expect("fixture template needs server_id");
    let sync_state = fields
        .get("sync_state")
        .and_then(Value::as_str)
        .unwrap_or("synced");
    let revision = fields
        .get("server_revision")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let html = fields
        .get("html")
        .and_then(Value::as_str)
        .unwrap_or("<p></p>");
    let css = fields.get("css").and_then(Value::as_str).unwrap_or("");
    let published_at = fields.get("published_at").and_then(Value::as_str);

    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, readme, summary,
                published_at, server_id, server_revision, base_revision, sync_state, kind, synced_at)
         VALUES (?1, 210, 297, 'portrait', '', '', ?2, ?3, ?4, ?4, ?5, 'own', NULL)",
        rusqlite::params![name, published_at, server_id, revision, sync_state],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    let version_id: i64 = conn
        .query_row(
            "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
             VALUES (?1, 1, ?2, ?3, 'manual') RETURNING id",
            rusqlite::params![id, html, css],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
        rusqlite::params![version_id, id],
    )
    .unwrap();
    id
}

fn row_by_server_id(conn: &Connection, server_id: &str) -> Option<HashMap<String, Value>> {
    let mut stmt = conn
        .prepare(
            "SELECT t.name, t.sync_state, t.server_revision, v.html, t.published_at,
                    t.kind, t.owner_handle
             FROM templates t LEFT JOIN template_versions v ON v.id = t.current_version_id
             WHERE t.server_id = ?1",
        )
        .unwrap();
    let mut rows = stmt.query([server_id]).unwrap();
    rows.next().unwrap().map(|row| {
        let mut map = HashMap::new();
        let name: String = row.get(0).unwrap();
        let state: String = row.get(1).unwrap();
        let revision: Option<i64> = row.get(2).unwrap();
        let html: Option<String> = row.get(3).unwrap();
        let published: Option<String> = row.get(4).unwrap();
        let kind: String = row.get(5).unwrap();
        let owner: Option<String> = row.get(6).unwrap();
        map.insert("name".to_string(), Value::String(name));
        map.insert("sync_state".to_string(), Value::String(state));
        if let Some(r) = revision {
            map.insert("server_revision".to_string(), Value::from(r));
        }
        if let Some(h) = html {
            map.insert("html".to_string(), Value::String(h));
        }
        map.insert(
            "published_at".to_string(),
            published.map_or(Value::Null, Value::String),
        );
        map.insert("kind".to_string(), Value::String(kind));
        map.insert(
            "owner_handle".to_string(),
            owner.map_or(Value::Null, Value::String),
        );
        map
    })
}

#[test]
fn cache_cases_match_rust_behavior() {
    for case in load_cases() {
        let name = case["name"].as_str().unwrap_or("?");
        let conn = Connection::open_in_memory().expect("memory db");
        db::init(&conn).expect("schema");

        // Seed.
        for template in case["given"]["templates"].as_array().unwrap() {
            let fields: HashMap<String, Value> = template
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            seed_template(&conn, &fields);
        }
        for dataset in case
            .get("given")
            .and_then(|g| g.get("datasets"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            seed_dataset(&conn, &dataset);
        }
        for profile in case
            .get("given")
            .and_then(|g| g.get("profiles"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            seed_profile(&conn, &profile);
        }
        for setting in case
            .get("given")
            .and_then(|g| g.get("settings"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            seed_setting(&conn, &setting);
        }
        for font in case
            .get("given")
            .and_then(|g| g.get("fonts"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            seed_font(&conn, &font);
        }
        if let Some(cursor) = case["given"]["sync_state"]["cursor"].as_str() {
            if !cursor.is_empty() {
                conn.execute(
                    "INSERT INTO sync_state (id, cursor) VALUES (1, ?1)",
                    [cursor],
                )
                .unwrap();
            }
        }

        // Apply.
        let changes: Vec<SyncChangeIn> =
            serde_json::from_value(case["changes"].clone()).expect("valid changes");
        let new_cursor = case["new_cursor"].as_str().unwrap();
        let result = apply_changes(&conn, &changes, new_cursor);
        let expect = &case["expect"];

        if expect
            .get("error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            assert!(result.is_err(), "case '{name}' must fail");
            // Atomicity: the cursor never moved and nothing was written.
            let state = get_sync_state(&conn).unwrap();
            let expected_cursor = case["given"]["sync_state"]["cursor"].as_str().unwrap_or("");
            assert_eq!(
                state.cursor, expected_cursor,
                "case '{name}': cursor moved on error"
            );
            for gone in expect["gone"].as_array().unwrap() {
                let id = gone.as_str().unwrap();
                assert!(
                    row_by_server_id(&conn, id).is_none(),
                    "case '{name}': {id} was written despite the error"
                );
            }
            for (key, check) in [
                (
                    "gone_datasets",
                    row_by_dataset as fn(&Connection, &str) -> Option<HashMap<String, Value>>,
                ),
                (
                    "gone_profiles",
                    row_by_profile as fn(&Connection, &str) -> Option<HashMap<String, Value>>,
                ),
                (
                    "gone_fonts",
                    row_by_font as fn(&Connection, &str) -> Option<HashMap<String, Value>>,
                ),
            ] {
                for gone in expect
                    .get(key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    let id = gone.as_str().unwrap();
                    assert!(
                        check(&conn, id).is_none(),
                        "case '{name}': {key} {id} was written despite the error"
                    );
                }
            }
            continue;
        }

        let report = result.unwrap_or_else(|e| panic!("case '{name}' failed: {e:?}"));
        let want = &expect["report"];
        assert_eq!(
            report.applied_upserts as u64,
            want["applied_upserts"].as_u64().unwrap(),
            "case '{name}' upserts"
        );
        assert_eq!(
            report.applied_deletes as u64,
            want["applied_deletes"].as_u64().unwrap(),
            "case '{name}' deletes"
        );
        assert_eq!(
            report.skipped_dirty as u64,
            want["skipped_dirty"].as_u64().unwrap(),
            "case '{name}' skipped"
        );

        for wanted in expect["templates"].as_array().unwrap() {
            let id = wanted["server_id"].as_str().unwrap();
            let actual = row_by_server_id(&conn, id)
                .unwrap_or_else(|| panic!("case '{name}': missing row {id}"));
            for (key, value) in wanted.as_object().unwrap() {
                if key == "server_id" {
                    continue;
                }
                assert_eq!(&actual[key], value, "case '{name}' field {key} of {id}");
            }
        }
        for wanted in expect
            .get("datasets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let id = wanted["server_id"].as_str().unwrap();
            let actual = row_by_dataset(&conn, id)
                .unwrap_or_else(|| panic!("case '{name}': missing dataset {id}"));
            for (key, value) in wanted.as_object().unwrap() {
                if key == "server_id" {
                    continue;
                }
                assert_eq!(
                    &actual[key], value,
                    "case '{name}' dataset field {key} of {id}"
                );
            }
        }
        for wanted in expect
            .get("profiles")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let id = wanted["server_id"].as_str().unwrap();
            let actual = row_by_profile(&conn, id)
                .unwrap_or_else(|| panic!("case '{name}': missing profile {id}"));
            for (key, value) in wanted.as_object().unwrap() {
                if key == "server_id" {
                    continue;
                }
                assert_eq!(
                    &actual[key], value,
                    "case '{name}' profile field {key} of {id}"
                );
            }
        }
        for wanted in expect
            .get("settings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let key = wanted["key"].as_str().unwrap();
            let actual = value_of_setting(&conn, key)
                .unwrap_or_else(|| panic!("case '{name}': missing setting {key}"));
            if let Some(value) = wanted.get("value") {
                assert_eq!(&actual, value, "case '{name}' setting {key}");
            }
        }
        for wanted in expect
            .get("fonts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let id = wanted["server_id"].as_str().unwrap();
            let actual = row_by_font(&conn, id)
                .unwrap_or_else(|| panic!("case '{name}': missing font {id}"));
            for (key, value) in wanted.as_object().unwrap() {
                if key == "server_id" {
                    continue;
                }
                assert_eq!(
                    &actual[key], value,
                    "case '{name}' font field {key} of {id}"
                );
            }
        }
        for gone in expect["gone"].as_array().unwrap() {
            let id = gone.as_str().unwrap();
            assert!(
                row_by_server_id(&conn, id).is_none(),
                "case '{name}': {id} still present"
            );
        }
        for (key, check) in [
            (
                "gone_datasets",
                row_by_dataset as fn(&Connection, &str) -> Option<HashMap<String, Value>>,
            ),
            (
                "gone_profiles",
                row_by_profile as fn(&Connection, &str) -> Option<HashMap<String, Value>>,
            ),
            (
                "gone_fonts",
                row_by_font as fn(&Connection, &str) -> Option<HashMap<String, Value>>,
            ),
        ] {
            for gone in expect
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let id = gone.as_str().unwrap();
                assert!(
                    check(&conn, id).is_none(),
                    "case '{name}': {key} {id} still present"
                );
            }
        }
        for gone in expect
            .get("gone_settings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let key = gone.as_str().unwrap();
            assert!(
                value_of_setting(&conn, key).is_none(),
                "case '{name}': setting {key} still present"
            );
        }
        let cursor = get_sync_state(&conn).unwrap().cursor;
        assert_eq!(
            cursor,
            expect["sync_cursor"].as_str().unwrap(),
            "case '{name}' cursor"
        );
    }
}

fn seed_dataset(conn: &Connection, fields: &Value) {
    let server_id = fields["server_id"]
        .as_str()
        .expect("fixture dataset needs server_id");
    let name = fields.get("name").and_then(Value::as_str).unwrap_or("D");
    let data_json = fields
        .get("data_json")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let sync_state = fields
        .get("sync_state")
        .and_then(Value::as_str)
        .unwrap_or("synced");
    let revision = fields
        .get("server_revision")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO synced_datasets (server_id, name, data_json, server_revision, base_revision, sync_state)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        rusqlite::params![server_id, name, data_json, revision, sync_state],
    )
    .unwrap();
}

fn seed_profile(conn: &Connection, fields: &Value) {
    let server_id = fields["server_id"]
        .as_str()
        .expect("fixture profile needs server_id");
    let template_server_id = fields
        .get("template_server_id")
        .and_then(Value::as_str)
        .unwrap_or("tpl-1");
    let printer_name = fields
        .get("printer_name")
        .and_then(Value::as_str)
        .unwrap_or("e2e");
    let settings_json = fields
        .get("settings_json")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let sync_state = fields
        .get("sync_state")
        .and_then(Value::as_str)
        .unwrap_or("synced");
    let revision = fields
        .get("server_revision")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO synced_profiles (server_id, template_server_id, printer_name, settings_json,
                server_revision, base_revision, sync_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
        rusqlite::params![
            server_id,
            template_server_id,
            printer_name,
            settings_json,
            revision,
            sync_state
        ],
    )
    .unwrap();
}

fn seed_setting(conn: &Connection, fields: &Value) {
    let key = fields["key"].as_str().expect("fixture setting needs key");
    let value = fields.get("value").and_then(Value::as_str).unwrap_or("");
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .unwrap();
    if let Some(dirty) = fields.get("dirty").and_then(Value::as_str) {
        conn.execute(
            "UPDATE settings SET sync_state = ?1 WHERE key = ?2",
            rusqlite::params![dirty, key],
        )
        .unwrap();
    }
}

fn seed_font(conn: &Connection, fields: &Value) {
    let server_id = fields["server_id"]
        .as_str()
        .expect("fixture font needs server_id");
    let family = fields
        .get("family")
        .and_then(Value::as_str)
        .unwrap_or("Body");
    let sha256 = fields.get("sha256").and_then(Value::as_str).unwrap_or("");
    let sync_state = fields
        .get("sync_state")
        .and_then(Value::as_str)
        .unwrap_or("synced");
    let revision = fields
        .get("server_revision")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO fonts (family, style, weight, file_path, format, server_id,
                server_revision, base_revision, sync_state, sha256, size_bytes)
         VALUES (?1, 'normal', '400', '', 'ttf', ?2, ?3, ?3, ?4, ?5, 0)",
        rusqlite::params![family, server_id, revision, sync_state, sha256],
    )
    .unwrap();
}

fn row_by_dataset(conn: &Connection, server_id: &str) -> Option<HashMap<String, Value>> {
    let mut stmt = conn
        .prepare(
            "SELECT name, sync_state, server_revision, data_json
             FROM synced_datasets WHERE server_id = ?1",
        )
        .unwrap();
    let mut rows = stmt.query([server_id]).unwrap();
    rows.next().unwrap().map(|row| {
        let mut map = HashMap::new();
        let name: String = row.get(0).unwrap();
        let state: String = row.get(1).unwrap();
        let revision: Option<i64> = row.get(2).unwrap();
        let data_json: String = row.get(3).unwrap();
        map.insert("name".to_string(), Value::String(name));
        map.insert("sync_state".to_string(), Value::String(state));
        if let Some(r) = revision {
            map.insert("server_revision".to_string(), Value::from(r));
        }
        map.insert("data_json".to_string(), Value::String(data_json));
        map
    })
}

fn row_by_profile(conn: &Connection, server_id: &str) -> Option<HashMap<String, Value>> {
    let mut stmt = conn
        .prepare(
            "SELECT printer_name, sync_state, server_revision, settings_json
             FROM synced_profiles WHERE server_id = ?1",
        )
        .unwrap();
    let mut rows = stmt.query([server_id]).unwrap();
    rows.next().unwrap().map(|row| {
        let mut map = HashMap::new();
        let printer_name: String = row.get(0).unwrap();
        let state: String = row.get(1).unwrap();
        let revision: Option<i64> = row.get(2).unwrap();
        let settings_json: String = row.get(3).unwrap();
        map.insert("printer_name".to_string(), Value::String(printer_name));
        map.insert("sync_state".to_string(), Value::String(state));
        if let Some(r) = revision {
            map.insert("server_revision".to_string(), Value::from(r));
        }
        map.insert("settings_json".to_string(), Value::String(settings_json));
        map
    })
}

fn value_of_setting(conn: &Connection, key: &str) -> Option<Value> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .ok();
    value.map(Value::String)
}

fn row_by_font(conn: &Connection, server_id: &str) -> Option<HashMap<String, Value>> {
    let mut stmt = conn
        .prepare(
            "SELECT family, sync_state, server_revision, sha256
             FROM fonts WHERE server_id = ?1",
        )
        .unwrap();
    let mut rows = stmt.query([server_id]).unwrap();
    rows.next().unwrap().map(|row| {
        let mut map = HashMap::new();
        let family: String = row.get(0).unwrap();
        let state: String = row.get(1).unwrap();
        let revision: Option<i64> = row.get(2).unwrap();
        let sha256: String = row.get(3).unwrap();
        map.insert("family".to_string(), Value::String(family));
        map.insert("sync_state".to_string(), Value::String(state));
        if let Some(r) = revision {
            map.insert("server_revision".to_string(), Value::from(r));
        }
        map.insert("sha256".to_string(), Value::String(sha256));
        map
    })
}

fn seed_synced(conn: &Connection, server_id: &str, revision: i64) {
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, readme, summary, server_id, server_revision, base_revision, sync_state, kind)
         VALUES ('T', 210, 297, 'portrait', '', '', ?1, ?2, ?2, 'synced', 'own')",
        rusqlite::params![server_id, revision],
    )
    .unwrap();
    let id: i64 = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by) VALUES (?1, 1, '<p></p>', '', 'manual')",
        [id],
    )
    .unwrap();
    let vid: i64 = conn.last_insert_rowid();
    conn.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
        rusqlite::params![vid, id],
    )
    .unwrap();
}

fn sync_state_of(conn: &Connection, server_id: &str) -> String {
    conn.query_row(
        "SELECT sync_state FROM templates WHERE server_id = ?1",
        [server_id],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn conflict_marks_and_resolves_both_ways() {
    use printninja_lib::commands::cache::{
        mark_conflicted, resolve_conflict, ConflictResolution, TemplateDataIn,
    };
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_synced(&conn, "srv-c", 5);
    mark_conflicted(&conn, "srv-c").unwrap();
    assert_eq!(sync_state_of(&conn, "srv-c"), "conflict");

    // Unknown rows cannot be marked.
    assert!(mark_conflicted(&conn, "srv-nope").is_err());

    // Only conflicted rows resolve.
    let data = TemplateDataIn {
        id: "srv-c".to_string(),
        name: "C".to_string(),
        summary: String::new(),
        page_w_mm: 210.0,
        page_h_mm: 297.0,
        body: "<p>server</p>".to_string(),
        css: String::new(),
        readme: String::new(),
        revision: 6,
        published_at: None,
        updated_at: "2026-10-20T00:00:00Z".to_string(),
    };
    // "mine" puts it back to dirty for the next push.
    resolve_conflict(&conn, "srv-c", ConflictResolution::Mine, None, None).unwrap();
    assert_eq!(sync_state_of(&conn, "srv-c"), "dirty");

    // Back to conflict, then take theirs.
    mark_conflicted(&conn, "srv-c").unwrap();
    resolve_conflict(
        &conn,
        "srv-c",
        ConflictResolution::Theirs,
        Some(&data),
        None,
    )
    .unwrap();
    let (state, rev, html): (String, i64, String) = conn
        .query_row(
            "SELECT t.sync_state, t.server_revision, v.html FROM templates t
             JOIN template_versions v ON v.id = t.current_version_id
             WHERE t.server_id = 'srv-c'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(state, "synced");
    assert_eq!(rev, 6);
    assert_eq!(html, "<p>server</p>");

    // Non-conflicted rows refuse to resolve.
    let err = resolve_conflict(&conn, "srv-c", ConflictResolution::Mine, None, None).unwrap_err();
    assert!(format!("{err}").contains("not conflicted"));
}

#[test]
fn queued_uses_accumulate_drain_and_clear() {
    use printninja_lib::commands::cache::{clear_account, list_queued_uses, queue_use};
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_synced(&conn, "srv-q", 1);

    assert_eq!(queue_use(&conn, "srv-q", 3).unwrap(), 3);
    assert_eq!(queue_use(&conn, "srv-q", 2).unwrap(), 5);
    assert_eq!(queue_use(&conn, "srv-other", 1).unwrap(), 1);
    let queued = list_queued_uses(&conn).unwrap();
    assert_eq!(queued.len(), 2);

    // A successful POST drains by the same amount.
    assert_eq!(queue_use(&conn, "srv-q", -5).unwrap(), 0);
    assert_eq!(list_queued_uses(&conn).unwrap().len(), 1);

    // Clearing the account wipes templates and the queue.
    assert_eq!(clear_account(&conn).unwrap(), 1);
    assert_eq!(list_queued_uses(&conn).unwrap().len(), 0);
    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM templates", [], |r| r.get(0))
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn tombstoned_synced_lists_and_forget() {
    use printninja_lib::commands::cache::{forget_template, list_synced, list_tombstoned};
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_synced(&conn, "srv-keep", 1);
    seed_synced(&conn, "srv-gone", 1);
    conn.execute(
        "UPDATE templates SET sync_state = 'deleted_pending' WHERE server_id = 'srv-gone'",
        [],
    )
    .unwrap();

    let mut tomb = list_tombstoned(&conn).unwrap();
    tomb.sort();
    assert_eq!(tomb, vec!["srv-gone".to_string()]);
    assert_eq!(list_synced(&conn).unwrap(), vec!["srv-keep".to_string()]);

    // Forgetting a tombstone removes it; forgetting again is a no-op.
    assert!(forget_template(&conn, "srv-gone").unwrap());
    assert!(!forget_template(&conn, "srv-gone").unwrap());
    assert!(list_tombstoned(&conn).unwrap().is_empty());
}

#[test]
fn non_synced_rows_skip_pulls() {
    use printninja_lib::commands::cache::{apply_changes, SyncChangeIn};
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_synced(&conn, "srv-k", 1);
    for state in ["conflict", "deleted_pending"] {
        conn.execute(
            "UPDATE templates SET sync_state = ?1 WHERE server_id = 'srv-k'",
            [state],
        )
        .unwrap();
        let changes: Vec<SyncChangeIn> = serde_json::from_value(serde_json::json!([{
            "seq": 1, "entity": "template", "op": "upsert",
            "data": { "id": "srv-k", "name": "K", "page_w_mm": 210.0, "page_h_mm": 297.0,
                      "body": "<p>x</p>", "revision": 2, "updated_at": "2026-10-20T00:00:00Z" }
        }]))
        .unwrap();
        let report = apply_changes(&conn, &changes, "MQ==").unwrap();
        assert_eq!(report.skipped_dirty, 1, "state {state} must skip");
        assert_eq!(report.applied_upserts, 0, "state {state} must not apply");
        assert_eq!(sync_state_of(&conn, "srv-k"), state);
    }
}

#[test]
fn conflicted_lists_only_conflicted_rows_in_id_order() {
    use printninja_lib::commands::cache::{list_conflicted, mark_conflicted};
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_synced(&conn, "srv-a", 1);
    seed_synced(&conn, "srv-b", 1);
    seed_synced(&conn, "srv-c", 1);
    mark_conflicted(&conn, "srv-c").unwrap();
    mark_conflicted(&conn, "srv-a").unwrap();

    let listed = list_conflicted(&conn).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].server_id.as_deref(), Some("srv-a"));
    assert_eq!(listed[1].server_id.as_deref(), Some("srv-c"));
    assert!(listed.iter().all(|r| r.id > 0 && !r.name.is_empty()));
}

#[test]
fn mine_with_rebase_retries_cleanly() {
    use printninja_lib::commands::cache::{mark_conflicted, resolve_conflict, ConflictResolution};
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_synced(&conn, "srv-r", 5);
    mark_conflicted(&conn, "srv-r").unwrap();

    // Rebasing to the server's current revision keeps the row dirty but
    // moves both revisions forward, so the next push matches.
    resolve_conflict(&conn, "srv-r", ConflictResolution::Mine, None, Some(7)).unwrap();
    let (state, server_rev, base_rev): (String, i64, i64) = conn
        .query_row(
            "SELECT sync_state, server_revision, base_revision FROM templates WHERE server_id = 'srv-r'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(state, "dirty");
    assert_eq!((server_rev, base_rev), (7, 7));
}

fn seed_migrated(conn: &Connection, server_id: &str, html: &str, revision: i64) {
    // A pre-Phase-3 row: linked to the server (server_id) but never
    // confirmed (base_revision NULL), with local content.
    conn.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, readme, summary, server_id, server_revision, base_revision, sync_state, kind)
         VALUES ('M', 210, 297, 'portrait', '', '', ?1, ?2, NULL, 'synced', 'own')",
        rusqlite::params![server_id, revision],
    )
    .unwrap();
    let id: i64 = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by) VALUES (?1, 1, ?2, '', 'manual')",
        rusqlite::params![id, html],
    )
    .unwrap();
    let vid: i64 = conn.last_insert_rowid();
    conn.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
        rusqlite::params![vid, id],
    )
    .unwrap();
}

fn apply_one(
    conn: &Connection,
    data: serde_json::Value,
) -> printninja_lib::commands::cache::ApplyReport {
    use printninja_lib::commands::cache::{apply_changes, SyncChangeIn};
    let changes: Vec<SyncChangeIn> = serde_json::from_value(serde_json::json!([{
        "seq": 1, "entity": "template", "op": "upsert", "data": data
    }]))
    .unwrap();
    apply_changes(conn, &changes, "MQ==").unwrap()
}

fn server_data(id: &str, body: &str, revision: i64) -> serde_json::Value {
    serde_json::json!({
        "id": id, "name": "M", "summary": "", "page_w_mm": 210.0, "page_h_mm": 297.0,
        "body": body, "css": "", "readme": "", "revision": revision,
        "published_at": null, "updated_at": "2026-10-21T00:00:00Z"
    })
}

#[test]
fn first_pull_adopts_matching_content_without_a_new_version() {
    use printninja_lib::commands::cache::get_sync_state;
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_migrated(&conn, "srv-m", "<p>same</p>", 1);

    let report = apply_one(&conn, server_data("srv-m", "<p>same</p>", 2));
    assert_eq!(report.applied_upserts, 1);
    assert_eq!(report.skipped_dirty, 0);
    assert_eq!(sync_state_of(&conn, "srv-m"), "synced");
    // Revisions adopted, but no new local version appended.
    let (server_rev, base_rev, versions): (i64, i64, i64) = conn
        .query_row(
            "SELECT t.server_revision, t.base_revision, (SELECT COUNT(*) FROM template_versions v WHERE v.template_id = t.id)
             FROM templates t WHERE t.server_id = 'srv-m'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((server_rev, base_rev, versions), (2, 2, 1));
    let _ = get_sync_state(&conn).unwrap();
}

#[test]
fn first_pull_conflicts_instead_of_overwriting_differences() {
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_migrated(&conn, "srv-m", "<p>local</p>", 1);

    let report = apply_one(&conn, server_data("srv-m", "<p>server</p>", 2));
    assert_eq!(report.applied_upserts, 0);
    assert_eq!(report.skipped_dirty, 1);
    assert_eq!(sync_state_of(&conn, "srv-m"), "conflict");
    // The local content is untouched and no version was appended.
    let html: String = conn
        .query_row(
            "SELECT v.html FROM template_versions v JOIN templates t ON v.id = t.current_version_id WHERE t.server_id = 'srv-m'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(html, "<p>local</p>");
}

#[test]
fn confirmed_rows_still_overwrite_normally() {
    let conn = Connection::open_in_memory().unwrap();
    printninja_lib::db::init(&conn).unwrap();
    seed_synced(&conn, "srv-k", 1);

    let report = apply_one(&conn, server_data("srv-k", "<p>new</p>", 2));
    assert_eq!(report.applied_upserts, 1);
    assert_eq!(sync_state_of(&conn, "srv-k"), "synced");
}
