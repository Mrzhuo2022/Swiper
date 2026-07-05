/**
 * 语言代码映射表 + 下拉选项。
 *
 * 各引擎对目标语言代码要求不一（DeepLx 要大写如 ZH/EN，Google 要小写 zh/en）。
 * 这里维护统一的规范代码（BCP-47 小写），引擎实现内部再按需转换。
 */

export interface LanguageOption {
  code: string; // 规范代码（小写，如 zh、en、ja）
  name: string; // 显示名
}

/** 常用目标语言。 */
export const LANGUAGES: LanguageOption[] = [
  { code: "zh", name: "中文" },
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية" },
  { code: "pt", name: "Português" },
  { code: "it", name: "Italiano" },
  { code: "th", name: "ไทย" },
  { code: "vi", name: "Tiếng Việt" },
];

/** DeepL/DeepLx 要求大写语言代码（ZH/EN）。 */
export function toDeeplxCode(code: string): string {
  return code.toUpperCase();
}
