//! 开机自启管理（tauri-plugin-autostart）。
//!
//! 在 setup 时根据配置同步自启状态。

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// 根据配置启用/禁用开机自启。
pub fn sync(app: &AppHandle, enable: bool) {
    let manager = app.autolaunch();
    match enable {
        true => {
            if !manager.is_enabled().unwrap_or(false) {
                let _ = manager.enable();
            }
        }
        false => {
            if manager.is_enabled().unwrap_or(false) {
                let _ = manager.disable();
            }
        }
    }
}
