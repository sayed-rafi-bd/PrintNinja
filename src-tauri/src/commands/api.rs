use crate::api::auth::ApiKey;
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Shutdown handle so `stop_api_server` actually stops the listener.
/// `Mutex` (not `static mut`) to avoid mutable-static-reference UB.
static SHUTDOWN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiStatus {
    pub running: bool,
    pub address: String,
    pub port: u16,
    pub lan_access: bool,
}

fn port_from_settings(db: &DbState, key: &str, default: u16) -> u16 {
    db.lock()
        .ok()
        .and_then(|g| {
            let conn = g.connection();
            conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get::<_, String>(0)
            })
            .ok()?
            .parse()
            .ok()
        })
        .unwrap_or(default)
}

fn bool_from_settings(db: &DbState, key: &str, default: bool) -> bool {
    db.lock()
        .ok()
        .and_then(|g| {
            let conn = g.connection();
            conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        })
        .map(|v| v == "true" || v == "1")
        .unwrap_or(default)
}

#[tauri::command]
pub fn get_api_status(_app: AppHandle, db: State<DbState>) -> AppResult<ApiStatus> {
    let port = port_from_settings(&db, "api_port", 17717);
    let lan = bool_from_settings(&db, "api_lan_access", false);

    let address: String = db
        .lock()
        .ok()
        .and_then(|g| {
            g.connection()
                .query_row(
                    "SELECT value FROM settings WHERE key = 'api_bind'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
        })
        .unwrap_or_else(|| {
            if lan {
                "0.0.0.0".into()
            } else {
                "127.0.0.1".into()
            }
        });

    Ok(ApiStatus {
        running: RUNNING.load(Ordering::Relaxed),
        address,
        port,
        lan_access: lan,
    })
}

/// Handle stored in Tauri state so the UI can query the live bound address.
pub struct ApiServerHandle {
    pub address: String,
    pub port: u16,
}

#[tauri::command]
pub fn start_api_server(
    app: AppHandle,
    db: State<'_, DbState>,
    queue: State<'_, crate::queue::PrintQueue>,
    port: Option<u16>,
    lan_access: Option<bool>,
) -> AppResult<String> {
    if RUNNING.load(Ordering::Relaxed) {
        return Err(AppError::Validation("API server is already running".into()));
    }

    let port = port.unwrap_or_else(|| port_from_settings(&db, "api_port", 17717));
    let lan = lan_access.unwrap_or_else(|| bool_from_settings(&db, "api_lan_access", false));

    // Persist so a restart keeps the user's choice.
    {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('api_port', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [port.to_string()],
        )?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('api_lan_access', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if lan { "true" } else { "false" }],
        )?;
    }

    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let addr = format!("{}:{}", host, port);

    // Bind synchronously first so a busy port returns a clear error to the UI
    // instead of failing silently inside the spawned task.
    let listener = std::net::TcpListener::bind(&addr)
        .map_err(|e| AppError::Internal(format!("Cannot bind {}: {}", addr, e)))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| AppError::Internal(format!("Listener setup failed: {}", e)))?;

    let display_addr = host.to_string();
    app.manage(ApiServerHandle {
        address: display_addr,
        port,
    });
    {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('api_bind', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [host],
        )?;
    }

    let (tx, rx) = oneshot::channel::<()>();
    // Store the sender so stop() can trigger it.
    if let Ok(mut slot) = SHUTDOWN.lock() {
        *slot = Some(tx);
    }

    // The routes need the same queue the desktop UI uses, so an API job and
    // a UI job aimed at the same printer are serialised against each other.
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Internal(format!("No cache dir: {e}")))?;
    let state = crate::api::routes::ApiState {
        db: db.inner().clone(),
        queue: std::sync::Arc::new(queue.inner().clone()),
        cache_dir,
    };
    let router = crate::api::routes::router_with_state(state, lan);
    let app2 = app.clone();

    let log_addr = addr.clone();
    tauri::async_runtime::spawn(async move {
        RUNNING.store(true, Ordering::Relaxed);
        tracing::info!("API server listening on {}", log_addr);

        // ConnectInfo feeds the auth middleware's IP allowlist: without it
        // a non-empty `allowed_ips` has no peer to compare against (P12).
        let server = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = rx.await;
        });

        if let Err(e) = server.await {
            tracing::error!("API server error: {}", e);
        }

        RUNNING.store(false, Ordering::Relaxed);
        tracing::info!("API server stopped");

        // Clean up managed state so a restart re-registers it.
        if let Some(handle) = app2.try_state::<ApiServerHandle>() {
            handle.reset();
        }
    });

    Ok(addr)
}

#[tauri::command]
pub fn stop_api_server() -> AppResult<()> {
    if !RUNNING.load(Ordering::Relaxed) {
        return Ok(());
    }
    if let Ok(mut slot) = SHUTDOWN.lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

/// Issue a fresh API key, storing only the SHA-256 hash (PLANNING.md §11).
/// The plaintext is returned exactly once so the user can copy it.
#[tauri::command]
pub fn regenerate_api_key(db: State<DbState>) -> AppResult<String> {
    let (plaintext, hash) = ApiKey::generate();

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    conn.execute(
        "INSERT INTO api_clients (name, key_hash, scopes) VALUES ('default', ?1, 'print,read')
         ON CONFLICT(name) DO UPDATE SET key_hash = excluded.key_hash",
        [&hash],
    )?;

    Ok(plaintext)
}

/// Verify an inbound key against the stored hash (constant-time compare)
/// and return the matched row — the middleware needs its scopes and IP
/// allowlist to enforce them, and its id to stamp `last_used_at`.
pub fn verify_stored_key(conn: &rusqlite::Connection, presented: &str) -> Option<ApiKey> {
    let hash = crate::api::auth::hash_key(presented);

    let mut stmt =
        match conn.prepare("SELECT id, name, key_hash, scopes, allowed_ips FROM api_clients") {
            Ok(s) => s,
            Err(_) => return None,
        };

    let rows = match stmt.query_map([], |r| {
        Ok(ApiKey {
            id: r.get(0)?,
            name: r.get(1)?,
            key_hash: r.get(2)?,
            scopes: parse_list(r.get::<_, Option<String>>(3)?.as_deref()),
            allowed_ips: parse_list(r.get::<_, Option<String>>(4)?.as_deref()),
        })
    }) {
        Ok(r) => r,
        Err(_) => return None,
    };

    let matched = rows
        .flatten()
        .find(|stored| constant_time_eq(stored.key_hash.as_bytes(), hash.as_bytes()));
    matched
}

/// `scopes` and `allowed_ips` are TEXT columns: a comma list (`print,read`)
/// or a JSON array — both accepted, since only `print,read` has ever been
/// written. NULL and empty become an empty list.
fn parse_list(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    if raw.starts_with('[') {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(raw) {
            return list;
        }
    }
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Length-independent byte comparison to avoid leaking hash prefixes.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

impl ApiServerHandle {
    fn reset(&self) {
        // Values stay so the UI can still show the last bound address.
    }
}

/// Re-exported for integration tests so they can assert key verification
/// without reaching into private modules.
pub fn verify_api_key(conn: &rusqlite::Connection, presented: &str) -> bool {
    verify_stored_key(conn, presented).is_some()
}

/// Spawn helper kept public so tests can start an ephemeral server.
pub fn spawn_test_server(port: u16) -> std::io::Result<(tokio::net::TcpListener, String)> {
    let addr = format!("127.0.0.1:{}", port);
    let listener = std::net::TcpListener::bind(&addr)?;
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok((listener, addr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_equal() {
        assert!(constant_time_eq(b"abc", b"abc"));
    }

    #[test]
    fn constant_time_eq_rejects_different() {
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn generate_api_key_is_prefixed_and_long() {
        let (plain, hash) = ApiKey::generate();
        assert!(plain.starts_with("pn_live_"));
        // 8-char prefix + 32 random alphanumerics
        assert_eq!(plain.len(), 40, "key must be pn_live_ + 32 chars");
        assert_eq!(hash.len(), 64, "sha256 hex is 64 chars");
    }

    #[test]
    fn key_roundtrip_verifies() {
        let (plain, hash) = ApiKey::generate();
        assert_eq!(crate::api::auth::hash_key(&plain), hash);
        assert!(crate::api::auth::verify_key(&plain, &hash));
        assert!(!crate::api::auth::verify_key("pn_live_wrong", &hash));
    }
}
