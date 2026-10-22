const COMMANDS: &[&str] = &[
    "html_to_pdf",
    "enumerate_usb_printers",
    "test_printer",
    "start_background_service",
    "stop_background_service",
    "is_background_service_running",
    "request_battery_exemption",
    "is_battery_exemption_granted",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
