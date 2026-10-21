use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::AndroidPrint;
#[cfg(mobile)]
use mobile::AndroidPrint;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`]
/// to access the android-print APIs.
pub trait AndroidPrintExt<R: Runtime> {
    fn android_print(&self) -> &AndroidPrint<R>;
}

impl<R: Runtime, T: Manager<R>> crate::AndroidPrintExt<R> for T {
    fn android_print(&self) -> &AndroidPrint<R> {
        self.state::<AndroidPrint<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-print")
        .invoke_handler(tauri::generate_handler![
            commands::html_to_pdf,
            commands::enumerate_usb_printers,
            commands::test_printer,
            commands::start_background_service,
            commands::stop_background_service,
            commands::is_background_service_running,
            commands::request_battery_exemption,
            commands::is_battery_exemption_granted,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let android_print = mobile::init(app, api)?;
            #[cfg(desktop)]
            let android_print = desktop::init(app, api)?;
            app.manage(android_print);
            Ok(())
        })
        .build()
}
