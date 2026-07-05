/**
 * LLM 引擎入口：按 provider 的端点格式分发到对应执行器。
 *
 * 三种格式：
 * - openai-chat       → chat.ts      (POST /chat/completions)
 * - openai-responses  → responses.ts (POST /responses)
 * - claude            → claude.ts    (POST /v1/messages)
 *
 * 通用：接收完整 messages（含 system），流式输出正文 + 思维链。
 * supportedActions = 全部动作。
 *
 * 另导出 runOcr：OCR 专用 provider（baseUrl/apiKey/model，无 format 字段）
 * 按 baseUrl 自动识别端点类型 ——
 *   Ollama 原生（本地地址 + 非 /v1）→ ollama.run；
 *   其余（OpenAI 兼容，含 /v1）→ chat.run（多模态 image_url 原样透传）。
 */
import type { ActionKey } from "$lib/actions";
import type { ChatMessage, EngineContext, EngineInfo, RunFn } from "../types";
import { isOllamaNative } from "$lib/utils";
import * as chat from "./chat";
import * as responses from "./responses";
import * as claude from "./claude";
import * as ollama from "./ollama";

export const supportedActions: ActionKey[] = [
  "translate",
  "summarize",
  "polish",
  "explain",
  "chat",
  "ocr",
];

export const info: EngineInfo = {
  key: "llm",
  name: "LLM 提供商",
  online: true,
  supportedActions,
};

/** 按 config.format 选执行器；默认 openai-chat。 */
export const run: RunFn = async (messages: ChatMessage[], ctx: EngineContext) => {
  const format: string = ctx.config.format ?? "openai-chat";
  switch (format) {
    case "openai-responses":
      return responses.run(messages, ctx);
    case "claude":
      return claude.run(messages, ctx);
    case "openai-chat":
    default:
      return chat.run(messages, ctx);
  }
};

/**
 * OCR 专用执行入口。
 *
 * OCR provider 配置只有 baseUrl/apiKey/model（无 format 字段），按 baseUrl 自动分流：
 * - Ollama 原生（本地 + 非 /v1）→ ollama.run（内部把 image_url 转成 images 字段）；
 * - OpenAI 兼容（含 /v1、任意云厂商）→ chat.run（image_url 多模态原样透传，
 *   支持 GPT-4o / Qwen-VL / SiliconFlow / OpenRouter 等视觉模型）。
 *
 * messages 统一用 OpenAI 多模态结构（content 数组含 image_url 块），
 * ollama.ts 内部会自行转换，故两种格式共用同一份 messages。
 */
export async function runOcr(
  messages: ChatMessage[],
  ctx: EngineContext,
): Promise<string> {
  const base: string = ctx.config.baseUrl || "";
  return isOllamaNative(base) ? ollama.run(messages, ctx) : chat.run(messages, ctx);
}

