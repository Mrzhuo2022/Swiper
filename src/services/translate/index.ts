/**
 * 引擎注册表。
 *
 * 新增引擎步骤：
 *   1. 在 services/translate/<key>/ 下实现 index.ts，导出 `info` + (`run` 或 `translate`)；
 *   2. 在此处把 key → 模块 加入 registry。
 * 全部在前端完成，无需改 Rust。
 *
 * 约定：
 * - LLM 类引擎实现 `run`（通用 chat），supportedActions 可含全部动作；
 * - 翻译类引擎实现 `translate`，supportedActions 只含 'translate'。
 */
import type { EngineInfo, EngineEntry } from "./types";
import type { ActionKey } from "$lib/actions";
import * as deeplx from "./deeplx";
import * as llm from "./llm";
import * as google from "./google";

export const registry: Record<string, EngineEntry> = {
  [deeplx.info.key]: {
    info: deeplx.info,
    translate: deeplx.translate,
  },
  // 统一 LLM 引擎：按 provider 的 format 分发到 chat/responses/claude 执行器。
  // baseUrl/key/model/format 由 Result 窗传入（取自当前选中的 provider）。
  [llm.info.key]: {
    info: llm.info,
    run: llm.run,
  },
  [google.info.key]: {
    info: google.info,
    translate: google.translate,
  },
};

/** 取所有引擎信息，供设置面板列出。 */
export function listEngines(): EngineInfo[] {
  return Object.values(registry).map((e) => e.info);
}

/** 按 key 取引擎入口；找不到抛错（调用方应保证 key 合法）。 */
export function getEngine(key: string): EngineEntry {
  const entry = registry[key];
  if (!entry) {
    throw new Error(`未知翻译引擎: ${key}`);
  }
  return entry;
}

/**
 * 在指定引擎上执行一个动作。
 *
 * - 翻译动作：LLM 引擎走 run（拼 system prompt），翻译类引擎走 translate；
 * - 其余动作：只 LLM 引擎可执行（翻译类引擎会抛错）。
 *
 * messages 已是完整的对话历史（含 system），由调用方拼好。
 * 对翻译类引擎，从 messages 里取第一条 user 消息的 content 当 text。
 *
 * onTarget / onReasoning 是流式回填回调（累积的完整文本）。
 */
export async function runAction(
  engineKey: string,
  action: ActionKey,
  messages: import("./types").ChatMessage[],
  engineConfig: Record<string, any>,
  opts: { targetLang: string },
  onTarget: (text: string) => void,
  onReasoning?: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const entry = getEngine(engineKey);
  const ctx = { config: engineConfig, setResult: onTarget, setReasoning: onReasoning, signal };

  // 翻译类引擎：只有 translate 动作
  if (entry.translate && !entry.run) {
    if (action !== "translate") {
      throw new Error(`${entry.info.name} 不支持「${action}」动作，请切换到 LLM 引擎`);
    }
    const raw = messages.find((m) => m.role === "user")?.content;
    const text = typeof raw === "string" ? raw : "";
    await entry.translate(text, "auto", opts.targetLang, ctx);
    return "";
  }

  // LLM 引擎：通用 chat
  if (entry.run) {
    return await entry.run(messages, ctx);
  }

  throw new Error(`${entry.info.name} 没有实现任何执行函数`);
}

/** 判断引擎是否支持某动作。 */
export function engineSupports(engineKey: string, action: ActionKey): boolean {
  const entry = registry[engineKey];
  if (!entry) return false;
  return entry.info.supportedActions.includes(action);
}
