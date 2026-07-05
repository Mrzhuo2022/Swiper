/**
 * OpenAI Responses 格式执行器。
 *
 * 端点：POST {baseUrl}/responses
 * 鉴权：Authorization: Bearer <key>
 * 请求体：{ model, input: [{role, content:[{type:text,text}]}], stream:true }
 *   —— Responses 用 input 而非 messages，content 是数组结构。
 *   为兼容统一 messages 契约，这里把 ChatMessage[] 转成 input。
 * 流式事件：
 *   response.output_text.delta → 正文增量（json.delta）
 *   response.reasoning_summary_text.delta → 思维链增量（json.delta）
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { ChatMessage, EngineContext } from "../types";
import { parseSSEStream } from "$lib/sse";
import { openaiParams } from "./params";

/** 把 ChatMessage[] 转成 Responses 的 input 结构。 */
function toInput(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : m.role === "system" ? "developer" : "user",
    content: [{ type: "input_text" as const, text: m.content }],
  }));
}

export async function run(
  messages: ChatMessage[],
  { config, setResult, setReasoning, signal }: EngineContext,
): Promise<string> {
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey: string = config.apiKey || "";
  const model: string = config.model || "gpt-4o-mini";
  const wantReasoning = config.enableThinking !== false;

  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      input: toInput(messages),
      stream: true,
      ...openaiParams(config),
    }),
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
    try {
      const evt = JSON.parse(jsonStr);
      const type: string = evt.type ?? "";
      // 正文增量
      if (type === "response.output_text.delta" && typeof evt.delta === "string") {
        acc += evt.delta;
        setResult(acc);
      }
      // 思维链增量
      if (
        wantReasoning &&
        setReasoning &&
        type === "response.reasoning_summary_text.delta" &&
        typeof evt.delta === "string"
      ) {
        reasoningAcc += evt.delta;
        setReasoning(reasoningAcc);
      }
    } catch {
      /* 单块解析失败静默跳过 */
    }
  });
  if (!acc) setResult("");
  return acc;
}
