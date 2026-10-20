pub mod api;
pub mod batch;
pub mod cache;
pub mod datasets;
pub mod deeplink_cmd;
pub mod font;
pub mod history;
pub mod print;
pub mod printer;
pub mod profile;
pub mod settings;
pub mod template;
pub mod version;

#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}
