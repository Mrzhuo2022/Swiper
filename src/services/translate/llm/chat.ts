/**
 * OpenAI Chat Completions 格式执行器。
 *
 * 端点：POST {baseUrl}/chat/completions
 * 鉴权：Authorization: Bearer <key>
 * 流式：choices[0].delta.content（正文）/ .reasoning_content | .reasoning（思维链）
 *
 * 兼容 OpenAI / DeepSeek / Moonshot / OpenRouter / 本地 Ollama / LM Studio 等。
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { ChatMessage, EngineContext } from "../types";
import { parseSSEStream } from "$lib/sse";
import { openaiParams } from "./params";

export async function run(
  messages: ChatMessage[],
  { config, setResult, setReasoning, signal }: EngineContext,
): Promise<string> {
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey: string = config.apiKey || "";
  const model: string = config.model || "gpt-4o-mini";
  const wantReasoning = config.enableThinking !== false;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, stream: true, messages, ...openaiParams(config) }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`请求失败: ${res.status} ${res.statusText} ${detail}`);
  }
  if (!res.body) throw new Error("无响应体");

  let acc = "";
  let reasoningAcc = "";
  await parseSSEStream(res.body, (jsonStr) => {
    // Chat 流里 data: 后是 JSON；[DONE] 已被 parseSSEStream 过滤
    try {
      const delta = JSON.parse(jsonStr).choices?.[0]?.delta;
      if (!delta) return;
      const content = delta.content;
      if (typeof content === "string" && content) {
        acc += content;
        setResult(acc);
      }
      if (wantReasoning && setReasoning) {
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === "string" && r) {
          reasoningAcc += r;
          setReasoning(reasoningAcc);
        }
      }
    } catch {
      /* 单块解析失败静默跳过 */
    }
  });
  if (!acc) setResult("");
  return acc;
}
