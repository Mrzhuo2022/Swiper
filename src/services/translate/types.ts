/**
 * 引擎统一契约（动作系统版）。
 *
 * 核心改造：从"翻译专用"泛化为"执行动作"。
 * - LLM 引擎实现通用 `run`（接收完整 messages 数组，流式输出）；
 * - 翻译类引擎(DeepLx/Google)实现 `translate`（只认翻译动作）；
 * - 引擎声明 `supportedActions` 决定菜单里哪些动作可用。
 *
 * 加引擎仍零 Rust 重编译，纯前端 JS。
 */
import type { ActionKey } from "$lib/actions";

/** 多模态内容块（OpenAI vision 格式）。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** 聊天消息（OpenAI messages 格式）。content 可为纯文本或多模态数组。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** 词典释义项（可选，用于 Bing Dict / ECDICT 等结果展示）。 */
export interface DictItem {
  pos?: string;
  terms: string[];
}

/** 引擎产出的结果。只有 target 是必须的。 */
export interface ResultPayload {
  /** 主体输出文本（译文/总结/润色/回答…） */
  target: string;
  /** 识别出的原文（可选回显） */
  source?: string;
  /** 词典释义（可选） */
  dict?: DictItem[];
}

/** 引擎运行时上下文：拿到该引擎的配置，并通过回调流式回填结果。 */
export interface EngineContext {
  /** 该引擎的配置对象（API key / endpoint 等），来自全局配置的 engines[<key>] */
  config: Record<string, any>;
  /** 流式回填主体结果（译文/回答）。LLM 可多次调用实现打字机效果。 */
  setResult: (target: string) => void;
  /** 流式回填思维链/思考过程（DeepSeek reasoner / o1 等的 reasoning_content）。
   *  传入当前累积的完整思考文本。无思维链的引擎可不调用。 */
  setReasoning?: (reasoning: string) => void;
  /** 中止信号：传给 fetch，abort 时请求取消、流中断。 */
  signal?: AbortSignal;
}

/**
 * 通用执行函数（LLM 引擎）：接收完整 messages（含系统 prompt + 多轮历史），
 * 流式输出。翻译/总结/润色/提问全走这条路径，只是 messages 不同。
 * 返回完整的输出文本（供调用方累积进多轮对话历史）。
 */
export type RunFn = (
  messages: ChatMessage[],
  ctx: EngineContext,
) => Promise<string>;

/**
 * 翻译专用函数（翻译类引擎）：text + from + to。
 * 仅 DeepLx/Google 等非 LLM 引擎实现。
 */
export type TranslateFn = (
  text: string,
  from: string,
  to: string,
  ctx: EngineContext,
) => Promise<void>;

/** 引擎元信息。 */
export interface EngineInfo {
  /** 引擎唯一 key，与目录名、配置 key 一致 */
  key: string;
  /** 显示名 */
  name: string;
  /** 是否需要联网 */
  online?: boolean;
  /** 该引擎支持的动作列表（决定菜单里哪些动作可用）。 */
  supportedActions: ActionKey[];
}

/** 引擎入口：info + 至少一种执行函数。 */
export interface EngineEntry {
  info: EngineInfo;
  /** LLM 通用执行；翻译类引擎为 null。 */
  run?: RunFn;
  /** 翻译专用执行；LLM 引擎为 null（走 run）。 */
  translate?: TranslateFn;
}
