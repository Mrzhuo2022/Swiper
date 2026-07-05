//! 待处理数据 + 窗口就绪握手。
//!
//! 解决"Rust 显示窗口后立即 emit，但前端组件还没 mount、listen 没注册"
//! 导致首帧事件丢失的竞态（菜单弹出却空白）。
//!
//! 机制：
//! - 前端 onMount 注册完 listener 后，emit("window_ready", label) 告知 Rust；
//! - Rust 用 managed state 记录每个窗口是否就绪 + 待发送的 payload；
//! - 显示窗口时：先缓存 payload，若该窗口已就绪则立即 emit（否则等就绪信号再补发）；
//! - 收到 window_ready 时：若有缓存的 payload，立即补发并清空。

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager};

/// 缓存的待发送 payload（JSON 字符串）。每个窗口标签一个。
#[derive(Default)]
pub struct PendingState {
    /// 窗口已就绪（前端 mount 完成）。
    pub ready: Mutex<std::collections::HashSet<String>>,
    /// 待发送的 (事件名, JSON payload)。
    pub pending: Mutex<std::collections::HashMap<String, (String, serde_json::Value)>>,
}

/// 发送数据到指定窗口：缓存 +（若已就绪）立即 emit。
pub fn deliver(app: &AppHandle, label: &str, event: &str, payload: serde_json::Value) {
    // 缓存，供"就绪后补发"或"前端主动拉取"用
    if let Some(state) = app.try_state::<PendingState>() {
        state
            .pending
            .lock()
            .unwrap()
            .insert(label.to_string(), (event.to_string(), payload.clone()));
    }
    // 立即尝试 emit（已就绪则前端能收到）
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.emit(event, payload);
    }
}

/// 注册 window_ready 监听：前端就绪后补发缓存的 payload。
pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any("window_ready", move |event| {
        // event.payload() 形如 "\"menu\""（JSON 字符串）
        let label = event.payload().trim_matches('"').to_string();
        let Some(state) = handle.try_state::<PendingState>() else {
            return;
        };
        // 标记就绪
        state.ready.lock().unwrap().insert(label.clone());
        // 补发缓存的 payload（若有）
        let removed = state.pending.lock().unwrap().remove(&label);
        if let Some((event_name, payload)) = removed {
            if let Some(win) = handle.get_webview_window(&label) {
                let _ = win.emit(&event_name, payload);
            }
        }
    });
}

/// 前端兜底主动拉取（onMount 时调）：若已有缓存就返回，并清空。
/// 返回 Option<{event, payload}>。正常情况下 window_ready 已处理，这是双保险。
#[tauri::command]
pub fn take_pending(app: AppHandle, label: String) -> Option<serde_json::Value> {
    let state = app.state::<PendingState>();
    let removed = state.pending.lock().unwrap().remove(&label);
    removed.map(|(event, payload)| serde_json::json!({ "event": event, "payload": payload }))
}
