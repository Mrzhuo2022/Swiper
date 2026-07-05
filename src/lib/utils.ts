/**
 * 共享工具函数（去重用）。
 *
 * 从各组件/模块抽出来的重复小工具集中在此，避免逻辑漂移。
 */

/** 生成短随机 id（带前缀）。用于 provider 等需要稳定标识的对象。 */
export function genId(prefix = "p"): string {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

/** 生成时间戳 + 随机的 id。用于历史记录等天然有序的场景。 */
export function genTimeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 判断 baseUrl 是否为 Ollama 原生端点（本地地址 + 非 /vN 兼容层）。
 * 走了 OpenAI 兼容层（…/v1）就不是原生。
 */
export function isOllamaNative(base: string): boolean {
  if (/\/v\d+\/?$/.test(base)) return false;
  return /localhost|127\.0\.0\.1|\[::1\]/i.test(base);
}

/** 从 number input 读值：空串/非法 → null（留空即「用默认」）。 */
export function readNum(e: Event): number | null {
  const v = (e.currentTarget as HTMLInputElement).value;
  if (v === "" || v === "-" || v === ".") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
