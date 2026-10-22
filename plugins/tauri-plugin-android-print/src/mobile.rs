use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_android_print);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AndroidPrint<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "com.printninja.android_print",
        "AndroidPrintPlugin",
    )?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_android_print)?;
    Ok(AndroidPrint(handle))
}

/// Access to the android-print APIs.
pub struct AndroidPrint<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AndroidPrint<R> {
    pub fn html_to_pdf(&self, payload: HtmlToPdfRequest) -> crate::Result<HtmlToPdfResponse> {
        self.0.run_mobile_plugin("htmlToPdf", payload).map_err(Into::into)
    }

    pub fn enumerate_usb_printers(&self) -> crate::Result<Vec<UsbPrinter>> {
        self.0
            .run_mobile_plugin("enumerateUsbPrinters", ())
            .map_err(Into::into)
    }

    pub fn start_background_service(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("startBackgroundService", ())
            .map_err(Into::into)
    }

    pub fn stop_background_service(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("stopBackgroundService", ())
            .map_err(Into::into)
    }

    pub fn is_background_service_running(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("isBackgroundServiceRunning", ())
            .map_err(Into::into)
    }

    pub fn request_battery_exemption(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("requestBatteryExemption", ())
            .map_err(Into::into)
    }

    pub fn is_battery_exemption_granted(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("isBatteryExemptionGranted", ())
            .map_err(Into::into)
    }
}
