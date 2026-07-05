//! 全局快捷键注册（可配置）。
//!
//! 决策（DESIGN §3.1）：不用全局鼠标钩子，改用快捷键触发。零误触、稳定。
//! 快捷键从 config.hotkey 读取（默认 "Alt+D"），可在设置里改并即时生效。
//!
//! on_shortcut 接受 &str（global_hotkey 的 FromStr 解析 "Alt+D" 这类串）。

use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 当前已注册的快捷键字符串，便于重新注册时先 unregister。
/// 用 Tauri 的 managed state 存放。
pub struct HotkeyState(pub Mutex<String>);

/// OCR 快捷键当前值（独立的第二个全局快捷键）。
pub struct OcrHotkeyState(pub Mutex<String>);

/// 注册快捷键：先取消旧的（若有），再注册新的。
pub fn rebind(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();

    // 先取消旧快捷键
    if let Some(state) = app.try_state::<HotkeyState>() {
        if let Ok(old) = state.0.lock() {
            if !old.is_empty() && *old != hotkey {
                // unregister 接受 &str，忽略错误（可能已失效）
                let _ = gs.unregister(old.as_str());
            }
        }
    }

    // 注册新快捷键
    gs.on_shortcut(hotkey, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            crate::translate::selection_translate(app.clone());
        }
    })
    .map_err(|e| format!("注册快捷键失败: {}", e))?;

    // 记录当前快捷键
    if let Some(state) = app.try_state::<HotkeyState>() {
        if let Ok(mut cur) = state.0.lock() {
            *cur = hotkey.to_string();
        }
    }
    Ok(())
}

/// 启动时注册（读 config.hotkey，默认 Alt+D）。
pub fn register_all(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let hotkey =
        crate::config::get_field::<String>(app, "hotkey").unwrap_or_else(|| "Alt+D".to_string());
    // managed state 必须存在，rebind 才能记录
    if app.try_state::<HotkeyState>().is_none() {
        app.manage(HotkeyState(Mutex::new(String::new())));
    }
    rebind(app, &hotkey).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    Ok(())
}

/// Tauri 命令：前端改快捷键后调用，即时重新注册。
#[tauri::command]
pub fn update_hotkey(app: AppHandle, new_hotkey: String) -> Result<(), String> {
    rebind(&app, &new_hotkey)
}

/// 注册 OCR 截图快捷键（独立于翻译快捷键，默认 Alt+S）。
pub fn register_ocr(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let hotkey =
        crate::config::get_field::<String>(app, "ocrHotkey").unwrap_or_else(|| "Alt+S".to_string());
    if app.try_state::<OcrHotkeyState>().is_none() {
        app.manage(OcrHotkeyState(Mutex::new(String::new())));
    }
    rebind_ocr(app, &hotkey).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    Ok(())
}

/// 重新注册 OCR 快捷键。
pub fn rebind_ocr(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    if let Some(state) = app.try_state::<OcrHotkeyState>() {
        if let Ok(old) = state.0.lock() {
            if !old.is_empty() && *old != hotkey {
                let _ = gs.unregister(old.as_str());
            }
        }
    }
    gs.on_shortcut(hotkey, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            crate::ocr::start_snip(app);
        }
    })
    .map_err(|e| format!("注册 OCR 快捷键失败: {}", e))?;
    if let Some(state) = app.try_state::<OcrHotkeyState>() {
        if let Ok(mut cur) = state.0.lock() {
            *cur = hotkey.to_string();
        }
    }
    Ok(())
}

/// Tauri 命令：前端改 OCR 快捷键后调用，即时重新注册。
#[tauri::command]
pub fn update_ocr_hotkey(app: AppHandle, new_hotkey: String) -> Result<(), String> {
    rebind_ocr(&app, &new_hotkey)
}
