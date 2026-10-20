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
        for gone in expect["gone"].as_array().unwrap() {
            let id = gone.as_str().unwrap();
            assert!(
                row_by_server_id(&conn, id).is_none(),
                "case '{name}': {id} still present"
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
