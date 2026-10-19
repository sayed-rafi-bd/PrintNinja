use crate::deeplink::{parse_deep_link, DeepLinkAction};
use crate::error::AppResult;

#[tauri::command]
pub fn parse_deeplink(url: String) -> AppResult<DeepLinkAction> {
    parse_deep_link(&url).map_err(crate::error::AppError::Validation)
}
