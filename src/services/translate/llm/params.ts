/**
 * 生成参数提取工具。
 *
 * per-provider 的 genParams（temperature/topP/maxTokens/frequencyPenalty）在结果窗
 * 构建 engineConfig 时被展开（平铺到 config 顶层），各执行器按自己端点接受的字段名
 * 取用。null = 不下发（用 API 默认值）。
 *
 * 三类端点的字段映射：
 * - OpenAI Chat / Responses：temperature / top_p / max_tokens / frequency_penalty（标准名）
 * - Claude：temperature / top_p（标准）；max_tokens 已是必填，由调用方单独处理；无 frequency_penalty
 * - Ollama：temperature / top_p（标准）；max_tokens→num_predict；frequency_penalty→repeat_penalty
 */

/** 取一个有限数值，否则 undefined（用于「仅在非 null 时下发」）。 */
function num(v: any): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** OpenAI Chat / Responses 风格字段。 */
export function openaiParams(config: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  const t = num(config.temperature);
  if (t !== undefined) out.temperature = t;
  const p = num(config.topP);
  if (p !== undefined) out.top_p = p;
  const m = num(config.maxTokens);
  if (m !== undefined) out.max_tokens = m;
  const f = num(config.frequencyPenalty);
  if (f !== undefined) out.frequency_penalty = f;
  return out;
}

/** Claude 风格字段（无 frequency_penalty；max_tokens 由调用方单独处理）。 */
export function claudeParams(config: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  const t = num(config.temperature);
  if (t !== undefined) out.temperature = t;
  const p = num(config.topP);
  if (p !== undefined) out.top_p = p;
  return out;
}

/** Ollama 风格字段：max_tokens→num_predict，frequency_penalty→repeat_penalty。 */
export function ollamaParams(config: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  const t = num(config.temperature);
  if (t !== undefined) out.temperature = t;
  const p = num(config.topP);
  if (p !== undefined) out.top_p = p;
  const m = num(config.maxTokens);
  if (m !== undefined) out.num_predict = m;
  const f = num(config.frequencyPenalty);
  if (f !== undefined) out.repeat_penalty = f;
  return out;
}
