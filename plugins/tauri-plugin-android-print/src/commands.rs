use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::{AndroidPrintExt, Result};

#[command]
pub(crate) async fn html_to_pdf<R: Runtime>(
    app: AppHandle<R>,
    payload: HtmlToPdfRequest,
) -> Result<HtmlToPdfResponse> {
    app.android_print().html_to_pdf(payload)
}

#[command]
pub(crate) async fn enumerate_usb_printers<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<UsbPrinter>> {
    app.android_print().enumerate_usb_printers()
}

#[command]
pub(crate) async fn test_printer<R: Runtime>(
    _app: AppHandle<R>,
    _payload: TestPrinterRequest,
) -> Result<()> {
    // Reachability is probed by the transport before a job is sent;
    // the command only confirms the plugin round-trip works.
    Ok(())
}

#[command]
pub(crate) async fn start_background_service<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().start_background_service()
}

#[command]
pub(crate) async fn stop_background_service<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    app.android_print().stop_background_service()
}

#[command]
pub(crate) async fn is_background_service_running<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().is_background_service_running()
}

#[command]
pub(crate) async fn request_battery_exemption<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().request_battery_exemption()
}

#[command]
pub(crate) async fn is_battery_exemption_granted<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool> {
    app.android_print().is_battery_exemption_granted()
}
