/**
 * 客户端复读（repetition）检测。
 *
 * 某些本地视觉/OCR 模型会陷入退化状态：流式输出无限重复同一片段（如
 * "ABCABCABC..." 或 "啊啊啊啊..."），流永不自然结束，前端一直转圈。
 * 这里在累积文本里实时检测「末尾是否存在连续重复 ≥ N 次的片段」，命中即让
 * 调用方 abort 流。
 *
 * 算法（O(windowLen × maxLoop)，windowLen 默认 800）：
 * - 只看尾部窗口；文本总长 < minLength 直接判否，避免极短输出误杀。
 * - 对候选循环长度 L（1..maxLoop）：取末尾长度 L 的片段 unit，从尾向前数 unit
 *   连续重复了多少次；≥ minRepeats 即命中。候选长度 L 下若文本不足 L×minRepeats
 *   个字符则跳过该 L（不可能达到阈值）。
 * - tail-anchored：只在末尾连续重复时命中。流式场景下复读一定在末尾（模型陷入
 *   循环后持续吐重复内容，直到被中断），故无需扫描全文。
 */

export interface RepetitionResult {
  /** 是否检测到复读 */
  repeated: boolean;
  /** 命中的循环片段（用于调试/提示） */
  snippet?: string;
  /** 重复次数 */
  count?: number;
}

export interface RepetitionOptions {
  /** 只检查末尾多少字符（性能上限） */
  window?: number;
  /** 最小文本长度（短于此不判） */
  minLength?: number;
  /** 最大候选循环长度 */
  maxLoop?: number;
  /** 命中所需的最少重复次数 */
  minRepeats?: number;
}

const DEFAULTS = {
  window: 800,
  minLength: 6,
  maxLoop: 80,
  minRepeats: 4,
};

/**
 * 检测文本末尾是否存在复读。命中返回 { repeated: true, snippet, count }。
 */
export function detectRepetition(
  text: string,
  opts: RepetitionOptions = {},
): RepetitionResult {
  const { window: win, minLength, maxLoop, minRepeats } = { ...DEFAULTS, ...opts };
  if (text.length < minLength) return { repeated: false };
  // 只看尾部窗口，减少大文本下的计算量
  const tail = text.length > win ? text.slice(text.length - win) : text;
  const len = tail.length;

  for (let L = 1; L <= Math.min(maxLoop, len); L++) {
    const unit = tail.slice(len - L);
    // 至少要重复 minRepeats 次，先快速算需要多少字符
    const need = L * minRepeats;
    if (len < need) continue; // 候选长度 L 下文本不够重复 minRepeats 次

    // 从末尾向前数 unit 连续重复次数
    let count = 0;
    let pos = len;
    while (pos >= L && tail.slice(pos - L, pos) === unit) {
      count++;
      pos -= L;
    }
    if (count >= minRepeats) {
      return { repeated: true, snippet: unit, count };
    }
  }
  return { repeated: false };
}
