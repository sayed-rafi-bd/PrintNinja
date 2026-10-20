pub mod api;
pub mod commands;
mod data;
pub mod db;
mod deeplink;
mod error;
pub mod queue;
pub mod readme;
pub mod render;
pub mod transport;
pub mod worker;

use std::sync::{Arc, Mutex};
use tauri::Manager;

pub use db::DbState;
pub use error::{AppError, AppResult};
// Re-exported so integration tests can assert API-key verification.
pub use commands::api::verify_api_key;

/// Wraps the generated command handler so every IPC call is logged.
/// A generic fn (rather than a `let`) lets the compiler infer the closure's
/// `Invoke<R>` parameter type, which `generate_handler!` leaves unannotated.
fn with_ipc_logging<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        tracing::info!(command = %invoke.message.command(), "ipc call");
        handler(invoke)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("printninja_lib=info".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let db_path = app.path().app_data_dir()?.join("printninja.db");
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // One schema path (P11): `Database::open` applies `schema.sql`
            // and the guarded migrations itself, so nothing else (plugin,
            // tests, setup) may apply schema on its own. It also enables WAL
            // and a busy timeout on the one reused connection.
            let db_url = format!("sqlite:{}", db_path.display());
            let database = db::Database::open(&db_url)?;
            let db_state: DbState = Arc::new(Mutex::new(database));
            app.manage(db_state.clone());

            // One shared print queue for the whole app, so the Tauri command
            // handlers, the REST API routes, and batch jobs all serialise
            // per printer instead of interleaving bytes on a thermal head.
            let queue = queue::PrintQueue::new();
            app.manage(queue.clone());

            // One worker consumes the queued rows reprint, retry, batch and
            // `POST /v1/print/batch` write (P3). It replaced a channel whose
            // receiver only logged what it admitted (P8): the database is
            // the queue, the worker is the consumer, and `queue.kick()`
            // wakes it the moment rows appear.
            let cache_dir = app.path().app_cache_dir()?;
            // Profiles left in the cache dir by earlier runs (a render killed
            // mid-flight) carry certificate material that looked like the app
            // wrote a `.pem` file. Nothing is in flight yet — the worker
            // spawns below — so stale ones can go now.
            render::sweep_leftover_edge_profiles(
                &cache_dir,
                std::time::Duration::from_secs(60 * 30),
            );
            worker::spawn(db_state, queue, cache_dir);
            Ok(())
        })
        .invoke_handler(with_ipc_logging(tauri::generate_handler![
            commands::ping,
            commands::printer::list_printers,
            commands::printer::add_printer,
            commands::printer::delete_printer,
            commands::printer::get_printer,
            commands::printer::test_printer,
            commands::template::list_templates,
            commands::template::create_template,
            commands::template::get_template,
            commands::template::update_readme,
            commands::template::update_template_meta,
            commands::template::set_publish_info,
            commands::template::clear_publish_info,
            commands::template::update_template_origin,
            commands::template::delete_template,
            commands::history::list_jobs,
            commands::history::get_job,
            commands::history::reprint_job,
            commands::history::retry_job,
            commands::history::delete_job,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::get_trusted_sources,
            commands::settings::set_trusted_sources,
            commands::cache::cache_apply_changes,
            commands::cache::cache_get_sync_state,
            commands::cache::cache_list_dirty,
            commands::cache::cache_mark_pushed,
            commands::print::print_html,
            commands::print::enumerate_system_printers,
            commands::print::spike_test_print,
            commands::version::list_versions,
            commands::version::create_version,
            commands::version::delete_version,
            commands::version::restore_version,
            commands::version::diff_versions,
            commands::font::list_fonts,
            commands::font::upload_font,
            commands::font::delete_font,
            commands::profile::list_profiles,
            commands::profile::save_profile,
            commands::profile::delete_profile,
            commands::batch::create_batch,
            commands::batch::list_batches,
            commands::batch::get_batch,
            commands::batch::cancel_batch,
            commands::batch::retry_batch,
            commands::api::start_api_server,
            commands::api::stop_api_server,
            commands::api::get_api_status,
            commands::api::regenerate_api_key,
            commands::deeplink_cmd::parse_deeplink,
        ]))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
