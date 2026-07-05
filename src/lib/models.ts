/**
 * 拉取模型列表。自动适配两种端点：
 * - Ollama 原生（baseUrl 指向 localhost/127.0.0.1，且非 /v1 兼容层）
 *   → GET {base}/api/tags，结构 { models:[{name}] }
 * - 其余（OpenAI 及任何 OpenAI 兼容云厂商，含 /v1、/v4 等）
 *   → GET {base}/models，结构 { data:[{id}] }
 *
 * 统一走 @tauri-apps/plugin-http，由 Rust 网络栈发出，绕过 webview CORS。
 */
import { fetch } from "@tauri-apps/plugin-http";
import { isOllamaNative } from "./utils";

export interface RemoteModel {
  id: string;
  ownedBy?: string;
}

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
): Promise<RemoteModel[]> {
  const base = baseUrl.replace(/\/+$/, "");
  // Ollama 原生：/api/tags；OpenAI 系（含任意 /vN）：/models
  const ollama = isOllamaNative(base);
  const url = ollama ? `${base}/api/tags` : `${base}/models`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      // 钉死 Origin 为 http://localhost（在 Ollama 默认白名单内）。
      // Tauri2 Win 上 WebView Origin 是 http://tauri.localhost，Ollama 会返回 403。
      // 依赖 tauri-plugin-http 的 unsafe-headers feature 才能让此头真正发出。
      Origin: "http://localhost",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`.trim());
  }
  const data: any = await res.json();
  // OpenAI: { data: [{id, owned_by}, ...] }
  // Ollama /api/tags: { models: [{name, ...}] }；/models 也可能返回 { models }
  let list: any[] = [];
  if (Array.isArray(data?.data)) list = data.data;
  else if (Array.isArray(data?.models)) list = data.models;

  return list
    .map((m) => ({
      id: m.id ?? m.name ?? "",
      ownedBy: m.owned_by,
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}
