/**
 * Anthropic Claude Messages 格式执行器。
 *
 * 端点：POST {baseUrl}/v1/messages
 * 鉴权：x-api-key: <key>  +  anthropic-version: 2023-06-01
 * 请求体：{ model, max_tokens, system, messages:[{role,content}], stream:true }
 *   —— Claude 把 system 单独放顶层（不进 messages）；
 *      messages 里 role 只能是 user/assistant；
 *      content 是字符串或 content block 数组（这里用字符串）。
 * 流式事件（SSE event + data）：
 *   content_block_delta，delta.text → 正文增量
 *   content_block_delta，delta.type==="thinking_delta"，delta.thinking → 思维链增量
 *
 * 注：开启思维链需请求里带 thinking:{type:enabled,budget_tokens}（仅部分模型支持）。
 *      为稳妥起见，仅当 enableThinking 时附带 thinking 参数。
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { ChatMessage, EngineContext } from "../types";
import { parseSSEStream } from "$lib/sse";
import { claudeParams } from "./params";

/** 取 content 的纯文本部分（Claude 端点当前只处理文本消息）。 */
function textOf(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : "";
}

/** 拆出 system 消息（Claude 要放顶层），其余保留为 user/assistant 对话。 */
function splitSystem(messages: ChatMessage[]): {
  system: string | undefined;
  msgs: { role: "user" | "assistant"; content: string }[];
} {
  const sysMsg = messages.find((m) => m.role === "system");
  const system = sysMsg ? textOf(sysMsg.content) : undefined;
  const msgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" as const : "user" as const,
      content: textOf(m.content),
    }));
  return { system, msgs };
}

export async function run(
  messages: ChatMessage[],
  { config, setResult, setReasoning, signal }: EngineContext,
): Promise<string> {
  const baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const apiKey: string = config.apiKey || "";
  const model: string = config.model || "claude-3-5-haiku-latest";
  const wantReasoning = config.enableThinking !== false;
  const { system, msgs } = splitSystem(messages);

  const body: Record<string, any> = {
    model,
    // Claude 必填 max_tokens；用户未配则用 4096 兜底
    max_tokens: typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens)
      ? config.maxTokens
      : 4096,
    messages: msgs,
    stream: true,
    ...claudeParams(config),
  };
  if (system) body.system = system;
  // 扩展思考（仅 Claude 3.7+ / opus 等支持；不支持时服务端会忽略或报错，故保守开启）
  if (wantReasoning) {
    body.thinking = { type: "enabled", budget_tokens: 2048 };
  }

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
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
      if (evt.type !== "content_block_delta" || !evt.delta) return;
      const d = evt.delta;
      // 正文
      if (d.type === "text_delta" && typeof d.text === "string") {
        acc += d.text;
        setResult(acc);
      }
      // 思维链
      if (wantReasoning && setReasoning && d.type === "thinking_delta" && typeof d.thinking === "string") {
        reasoningAcc += d.thinking;
        setReasoning(reasoningAcc);
      }
    } catch {
      /* 单块解析失败静默跳过 */
    }
  });
  if (!acc) setResult("");
  return acc;
}
