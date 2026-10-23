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

fn port_from_conn(conn: &rusqlite::Connection, key: &str, default: u16) -> u16 {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(default)
}

fn port_from_settings(db: &DbState, key: &str, default: u16) -> u16 {
    db.lock()
        .ok()
        .map(|g| port_from_conn(g.connection(), key, default))
        .unwrap_or(default)
}

fn bool_from_conn(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .map(|v| v == "true" || v == "1")
    .unwrap_or(default)
}

fn bool_from_settings(db: &DbState, key: &str, default: bool) -> bool {
    db.lock()
        .ok()
        .map(|g| bool_from_conn(g.connection(), key, default))
        .unwrap_or(default)
}

#[tauri::command]
pub fn get_api_status(_app: AppHandle, db: State<DbState>) -> AppResult<ApiStatus> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    Ok(api_status_from_db(
        guard.connection(),
        RUNNING.load(Ordering::Relaxed),
    ))
}

/// The status the UI shows, from one connection. Split out so tests can
/// drive it against a real database without a Tauri runtime: port and
/// LAN come from settings, the bind address from the last start (or the
/// LAN default when never started).
pub fn api_status_from_db(conn: &rusqlite::Connection, running: bool) -> ApiStatus {
    let port = port_from_conn(conn, "api_port", 17717);
    let lan = bool_from_conn(conn, "api_lan_access", false);
    let address = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'api_bind'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .unwrap_or_else(|| {
            if lan {
                "0.0.0.0".into()
            } else {
                "127.0.0.1".into()
            }
        });

    ApiStatus {
        running,
        address,
        port,
        lan_access: lan,
    }
}

/// Handle stored in Tauri state so the UI can query the live bound address.
pub struct ApiServerHandle {
    pub address: String,
    pub port: u16,
}

impl ApiServerHandle {
    fn reset(&self) {
        // Values stay so the UI can still show the last bound address.
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn start_api_server(
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

    // Bound synchronously first so a busy port returns a clear error to
    // the UI instead of failing silently inside the spawned task.
    let listener = bind_addr(&addr)?;

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

        // Keep the peer address available to handlers via ConnectInfo.
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

/// Bind a TCP listener synchronously so a busy port returns a clear
/// error to the caller instead of failing silently inside a spawned
/// task. Split out so tests can pin the busy-port message without a
/// Tauri runtime.
pub fn bind_addr(addr: &str) -> AppResult<tokio::net::TcpListener> {
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|e| AppError::Internal(format!("Cannot bind {addr}: {e}")))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    tokio::net::TcpListener::from_std(listener)
        .map_err(|e| AppError::Internal(format!("Listener setup failed: {e}")))
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
