use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AndroidPrint<R>> {
    Ok(AndroidPrint(app.clone()))
}

/// Access to the android-print APIs. Desktop has no Android runtime,
/// so every call reports unavailable instead of panicking — callers
/// check the platform first.
pub struct AndroidPrint<R: Runtime>(AppHandle<R>);

impl<R: Runtime> AndroidPrint<R> {
    fn unavailable<T>(&self, what: &str) -> crate::Result<T> {
        Err(crate::Error::Unavailable(format!(
            "{what} is only available on Android"
        )))
    }

    pub fn html_to_pdf(&self, _payload: HtmlToPdfRequest) -> crate::Result<HtmlToPdfResponse> {
        self.unavailable("htmlToPdf")
    }

    pub fn enumerate_usb_printers(&self) -> crate::Result<Vec<UsbPrinter>> {
        self.unavailable("enumerateUsbPrinters")
    }

    pub fn start_background_service(&self) -> crate::Result<bool> {
        self.unavailable("startBackgroundService")
    }

    pub fn stop_background_service(&self) -> crate::Result<()> {
        self.unavailable("stopBackgroundService")
    }

    pub fn is_background_service_running(&self) -> crate::Result<bool> {
        self.unavailable("isBackgroundServiceRunning")
    }

    pub fn request_battery_exemption(&self) -> crate::Result<bool> {
        self.unavailable("requestBatteryExemption")
    }

    pub fn is_battery_exemption_granted(&self) -> crate::Result<bool> {
        self.unavailable("isBatteryExemptionGranted")
    }
}
