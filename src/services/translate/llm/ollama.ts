/**
 * Ollama 原生 /api/chat 执行器。
 *
 * 端点：POST {baseUrl}/api/chat
 * 鉴权：通常无；填了 apiKey 才加 Authorization: Bearer（兼容加了网关鉴权的情况）。
 * 请求体：{ model, stream:true, messages:[{role,content,images?}] }
 *   —— Ollama 的 system 也是 messages 里的一条（role:"system"）；
 *      多模态图片用 images 字段（纯 base64 字符串数组，不含 data: 前缀）。
 * 流式响应：NDJSON（每行一个 JSON 对象，不是 SSE）。
 *   每行 { message:{role,content}, done:false, ... } 增量累加 content；
 *   思维链：部分模型把思考放进 message.thinking 或顶层 think 字段；
 *   最后一行 { done:true, ... }。
 *
 * 用于 LLM 视觉 OCR（默认 baseUrl=http://localhost:11434）及任何指向
 * Ollama 原生端点的 provider。
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { ChatMessage, ContentPart, EngineContext } from "../types";
import { ollamaParams } from "./params";

/** 把 data:image/png;base64,xxxx 形式剥离成纯 base64；已是纯 base64 则原样返回。 */
function stripDataUrl(s: string): string {
  const i = s.indexOf(",");
  if (i >= 0 && /^data:/i.test(s.slice(0, i + 1))) {
    return s.slice(i + 1);
  }
  return s;
}

/** 把 OpenAI 风格的多模态消息转成 Ollama 风格（text → content，image_url → images）。 */
function toOllamaMessage(m: ChatMessage): {
  role: string;
  content: string;
  images?: string[];
} {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }
  // 数组：拼接 text 块，收集 image_url 块
  let text = "";
  const images: string[] = [];
  for (const part of m.content as ContentPart[]) {
    if (part.type === "text") {
      text += part.text;
    } else if (part.type === "image_url") {
      images.push(stripDataUrl(part.image_url.url));
    }
  }
  const out: { role: string; content: string; images?: string[] } = {
    role: m.role,
    content: text,
  };
  if (images.length) out.images = images;
  return out;
}

export async function run(
  messages: ChatMessage[],
  { config, setResult, setReasoning, signal }: EngineContext,
): Promise<string> {
  const baseUrl = (config.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
  const apiKey: string = config.apiKey || "";
  const model: string = config.model || "";
  const wantReasoning = config.enableThinking !== false;

  // Ollama 采样参数走 options 字段（temperature/top_p/num_predict/repeat_penalty）
  const opts = ollamaParams(config);
  const body = JSON.stringify({
    model,
    stream: true,
    messages: messages.map(toOllamaMessage),
    // think:true 让支持思考的模型（如 qwen3、gpt-oss）输出 message.thinking
    ...(wantReasoning ? { think: true } : {}),
    ...(Object.keys(opts).length ? { options: opts } : {}),
  });

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 强制覆盖 Origin：Tauri2 在 Windows 上 WebView Origin 是
      // http://tauri.localhost，部分 Ollama 版本未放行 → 报 403。
      // 走 Rust 网络栈(@tauri-apps/plugin-http)可自由设头，这里钉死一个
      // 在 Ollama 默认白名单内的 Origin（http://localhost），一劳永逸。
      Origin: "http://localhost",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`请求失败: ${res.status} ${res.statusText} ${detail}`.trim());
  }
  if (!res.body) throw new Error("无响应体");

  // Ollama 流式是 NDJSON：每行一个 JSON。按行缓冲解析。
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";
  let reasoningAcc = "";

  /** 解析一行 NDJSON，累加正文/思维链。 */
  function handleLine(line: string) {
    const s = line.trim();
    if (!s) return;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      return; // 单行解析失败静默跳过
    }
    // 正文：message.content（标准字段）
    const content = obj?.message?.content;
    if (typeof content === "string" && content) {
      acc += content;
      setResult(acc);
    }
    // 思维链：message.thinking / message.think / 顶层 think（兼容不同模型）
    if (wantReasoning && setReasoning) {
      const r = obj?.message?.thinking ?? obj?.message?.think ?? obj?.think;
      if (typeof r === "string" && r) {
        reasoningAcc += r;
        setReasoning(reasoningAcc);
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    }
    // 流末残留的最后一行
    if (buffer.trim()) handleLine(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!acc) setResult("");
  return acc;
}
