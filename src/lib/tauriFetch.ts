/**
 * 绕过 webview CORS 的 fetch 封装。
 *
 * Tauri webview 直接 fetch 第三方翻译 API 会被同源策略拦截。
 * @tauri-apps/plugin-http 的 fetch 实际由 Rust 网络栈发出请求，
 * 完全绕过 webview 的同源策略（DESIGN §3.4）。
 *
 * 这里仅做 re-export + 统一错误类型，方便后续加超时/重试。
 */
export { fetch } from "@tauri-apps/plugin-http";
