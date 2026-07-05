//! 划词助手入口与动作协调。
//!
//! 数据流（动作菜单模式）：
//!   hotkey/tray 触发 → selection::get_text() 取词 →
//!   非空：show_menu_window() 弹动作菜单 → 前端点动作 →
//!   emit("menu_action", {action,text}) → 本模块收到 →
//!   hide_menu_window() + show_result_window(action, text)
//!
//! 直连模式（showActionMenu=false）：取词后直接 show_result_window(defaultAction)。

use serde::Deserialize;
use tauri::{AppHandle, Listener};

/// 划词触发：取选中文本并弹出动作菜单（或直接执行默认动作）。
pub fn selection_translate(app: AppHandle) {
    let text = selection::get_text();
    if text.trim().is_empty() {
        return; // 没选中 → 静默退出
    }
    dispatch_text(app, text);
}

/// 文本 → 动作流程的统一入口（划词与 OCR 共用）。
/// 按配置弹动作菜单，或直连执行默认动作。
pub fn dispatch_text(app: AppHandle, text: String) {
    let show_menu = crate::config::get_field::<bool>(&app, "showActionMenu").unwrap_or(true);
    if show_menu {
        crate::window::show_menu_window(app, text);
    } else {
        // 直连模式：执行默认动作
        let action = crate::config::get_field::<String>(&app, "defaultAction")
            .unwrap_or_else(|| "translate".to_string());
        crate::window::show_result_window(app, action, text);
    }
}

/// menu_action 事件载荷。
#[derive(Deserialize)]
struct MenuActionPayload {
    action: String,
    text: String,
}

/// 注册前端 menu_action 事件监听：菜单点了动作 → 关菜单、开结果窗。
/// 在 setup 时调用一次。
pub fn setup_action_listener(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any("menu_action", move |event| {
        let payload: MenuActionPayload = match serde_json::from_str(&event.payload()) {
            Ok(p) => p,
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("解析 menu_action 失败: {}", _e);
                return;
            }
        };
        // 关菜单 → 开结果窗执行动作
        crate::window::hide_menu_window(&handle);
        crate::window::show_result_window(handle.clone(), payload.action, payload.text);
    });
}
