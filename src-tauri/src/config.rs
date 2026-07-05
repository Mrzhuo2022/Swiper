//! 配置读取（Rust 侧）。
//!
//! 前端是配置的主存储方（tauri-plugin-store），Rust 侧仅在需要时读取
//! 个别字段（如 autoStart 用于同步开机自启状态）。为避免重复定义整套模型，
//! 这里只提供按需读取的薄封装。

use tauri_plugin_store::StoreExt;

/// 配置文件名（与前端 store.ts 一致）。
const STORE_FILE: &str = "config.json";

/// 从配置里读取 `config` 对象的某个字段。
pub fn get_field<T>(app: &tauri::AppHandle, field: &str) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    let store = app.store(STORE_FILE).ok()?;
    let raw = store.get("config")?;
    raw.get(field)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
}
