/**
 * 动作系统：把"翻译"泛化为可插拔的动作集。
 *
 * 每个动作描述：菜单怎么显示、是否需要目标语言、是否多轮对话、
 * 以及如何把"选中文本 + 选项"拼成 LLM 的系统提示词。
 *
 * 翻译类引擎(DeepLx/Google)只支持 translate；LLM 引擎支持全部。
 */

export type ActionKey =
  | "translate"
  | "summarize"
  | "polish"
  | "explain"
  | "chat"
  | "ocr";

export interface ActionDef {
  /** 动作唯一 key */
  key: ActionKey;
  /** 菜单/标题显示名 */
  name: string;
  /** 图标（单字） */
  icon: string;
  /** 翻译动作需要目标语言；其余不需要 */
  needsTargetLang: boolean;
  /** chat 动作带输入框、多轮对话 */
  isChat: boolean;
  /** 是否在划词菜单里显示（ocr 不进菜单，只在结果窗动作栏出现） */
  inMenu: boolean;
  /**
   * 构造系统提示词（system message）。
   * 对翻译，opts.targetLang 是目标语言代码；其余忽略。
   */
  buildSystemPrompt: (opts: { targetLang: string }) => string;
}

/** 语言代码 → 中文名（用于 prompt 里让模型输出可读语言名） */
function langName(code: string): string {
  const map: Record<string, string> = {
    zh: "中文",
    en: "English",
    ja: "日本語",
    ko: "한국어",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    ru: "Русский",
    ar: "العربية",
    pt: "Português",
    it: "Italiano",
    th: "ภาษาไทย",
    vi: "Tiếng Việt",
  };
  return map[code] ?? code;
}

/**
 * 构造系统提示词：优先用自定义 prompt（覆盖），否则用内置默认。
 * 自定义 prompt 支持 {targetLang} 占位符（翻译动作用）。
 */
export function buildPrompt(
  action: ActionDef,
  opts: { targetLang: string },
  customPrompt?: string,
): string {
  if (customPrompt && customPrompt.trim()) {
    return customPrompt.replace(/\{targetLang\}/g, langName(opts.targetLang));
  }
  return action.buildSystemPrompt(opts);
}

/** 全部内置动作（顺序即菜单顺序）。 */
export const ACTIONS: ActionDef[] = [
  {
    key: "translate",
    name: "翻译",
    icon: "译",
    needsTargetLang: true,
    isChat: false,
    inMenu: true,
    buildSystemPrompt: ({ targetLang }) =>
      `You are a professional translator. Translate the user's text into ${langName(
        targetLang,
      )}. ` +
      `Detect the source language automatically. ` +
      `Reply with ONLY the translation — no explanation, no quotes, no notes. ` +
      `Preserve formatting, code blocks, and punctuation style.`,
  },
  {
    key: "summarize",
    name: "总结",
    icon: "总",
    needsTargetLang: false,
    isChat: false,
    inMenu: true,
    buildSystemPrompt: () =>
      `You are an expert at concise summarization. Summarize the user's text in 3-5 bullet points. ` +
      `Reply in the SAME language as the source text unless asked otherwise. ` +
      `Use Markdown bullet points (•). Be precise and faithful — do not invent information.`,
  },
  {
    key: "polish",
    name: "润色",
    icon: "润",
    needsTargetLang: false,
    isChat: false,
    inMenu: true,
    buildSystemPrompt: () =>
      `You are a professional editor. Improve the user's text: fix grammar, ` +
      `smooth awkward phrasing, and enhance clarity — while keeping the original ` +
      `meaning and tone. Keep the SAME language as the source. ` +
      `Reply with ONLY the polished text, no explanation.`,
  },
  {
    key: "explain",
    name: "解释",
    icon: "释",
    needsTargetLang: false,
    isChat: false,
    inMenu: true,
    buildSystemPrompt: () =>
      `You are a patient, knowledgeable teacher. Explain the user's text clearly. ` +
      `Reply in 中文 by default. If it's code, explain what it does and key points. ` +
      `If it's a concept, give a concise explanation with an example if helpful.`,
  },
  {
    key: "chat",
    name: "提问",
    icon: "问",
    needsTargetLang: false,
    isChat: true,
    inMenu: true,
    buildSystemPrompt: () =>
      `You are Swiper, a helpful AI assistant. The user has selected some text ` +
      `and wants to discuss it. Answer based on the provided text and general knowledge. ` +
      `Reply in the user's language (default 中文). Be concise and useful.`,
  },
  {
    // ocr 不进划词菜单（inMenu:false），仅在 OCR 截图后作为结果窗的初始动作。
    // 系统 OCR：Rust 已得文本，直接显示；LLM OCR：前端纯透传图片给视觉模型，无 prompt。
    key: "ocr",
    name: "识别",
    icon: "识",
    needsTargetLang: false,
    isChat: false,
    inMenu: false,
    // OCR 不发任何提示词 —— 只把图片丢给视觉模型。保留空实现仅为满足 ActionDef 类型。
    buildSystemPrompt: () => "",
  },
];

/** 按 key 取动作定义。 */
export function getAction(key: ActionKey): ActionDef {
  const a = ACTIONS.find((x) => x.key === key);
  if (!a) throw new Error(`未知动作: ${key}`);
  return a;
}
