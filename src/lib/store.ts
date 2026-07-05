/**
 * 配置读写封装（基于 tauri-plugin-store）。
 *
 * 配置存储在 <配置目录>/com.swiper.translator/config.json，单文件、透明、易备份。
 * 改配置即时生效（快捷键改动会触发 Rust 重新注册）。
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import type { EngineInfo } from "$services/translate/types";
import type { ActionKey } from "./actions";
import { invoke } from "@tauri-apps/api/core";
import { genId } from "./utils";

const STORE_FILE = "config.json";

/** LLM 端点协议格式。决定请求体结构与 SSE 解析方式。 */
export type LlmFormat = "openai-chat" | "openai-responses" | "claude";

/** 生成参数（每个 provider / OCR provider 独立配置）。
 *  null = 不下发该字段，用 API 默认值。 */
export interface GenParams {
  /** 温度 (0~2)。越高越随机，复读时可调低 */
  temperature: number | null;
  /** Top-P 核采样 (0~1) */
  topP: number | null;
  /** 最大输出 token 数 */
  maxTokens: number | null;
  /** 重复惩罚：OpenAI frequency_penalty / Ollama repeat_penalty (0~2) */
  frequencyPenalty: number | null;
}

/** 全空的生成参数（默认值）。 */
export function emptyGenParams(): GenParams {
  return { temperature: null, topP: null, maxTokens: null, frequencyPenalty: null };
}

/** 单个 LLM 提供商配置。 */
export interface LlmProvider {
  /** 唯一 id */
  id: string;
  /** 显示名（如 "OpenAI"、"DeepSeek"） */
  name: string;
  /** 端点协议格式 */
  format: LlmFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 生成参数（温度等）。各 provider 独立，缺省字段自动补 null。 */
  genParams?: GenParams;
}

/** 单个动作的配置：是否启用 + 可选的自定义 prompt 覆盖。 */
export interface ActionConfig {
  enabled: boolean;
  /** 留空 = 用内置默认 prompt；填了则覆盖。支持 {targetLang} 占位符。 */
  customPrompt?: string;
}

/** 完整配置模型。 */
export interface AppConfig {
  /** 当前激活的翻译/LLM 引擎 key：'deeplx' | 'google' | 'llm' */
  activeEngine: string;
  /** LLM 提供商列表（可多个）。 */
  providers: LlmProvider[];
  /** 当前选用的 LLM 提供商 id（activeEngine==='llm' 时生效）。 */
  activeProviderId: string;
  /** 翻译类引擎配置。 */
  deeplx: { endpoint: string };
  google: { endpoint: string };
  /** 目标语言（规范小写代码，翻译动作用） */
  targetLang: string;
  /** 源语言（'auto' 为自动检测） */
  sourceLang: string;
  /** 悬浮窗尺寸（逻辑像素） */
  window: { width: number; height: number };
  /** 快捷键字符串（如 "Alt+D"） */
  hotkey: string;
  /** OCR 截图快捷键（如 "Alt+S"） */
  ocrHotkey: string;
  /** OCR 引擎：system（Windows WinRT）/ llm（视觉模型） */
  ocrEngine: "system" | "llm";
  /** LLM OCR 专用提供商配置（独立于对话/翻译用的 provider）。
   *  按 baseUrl 自动识别端点：本地 Ollama 原生 或 OpenAI 兼容云端（…/v1）。 */
  ocrProvider: {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 识别提示词。非空 → 随图附该文本作识别指令（通用多模态模型如 GPT-4o/Qwen-VL 需要，
     *  否则会去描述图片而非转录）；清空 → 纯透传图片零文本（专用 OCR 模型如 glm-ocr 推荐）。 */
    ocrPrompt: string;
    /** 生成参数（温度等），独立配置。缺省字段自动补 null。 */
    genParams?: GenParams;
  };
  /** 开机自启 */
  autoStart: boolean;
  /** 主题：跟随系统 / 浅色 / 深色 */
  theme: "system" | "light" | "dark";
  /** 是否开启思维链显示（关闭则不解析/不显示 reasoning） */
  enableThinking: boolean;
  /** 默认动作（直接执行模式用，或菜单的首选项） */
  defaultAction: ActionKey;
  /** true=划词后先弹动作菜单；false=直接执行 defaultAction */
  showActionMenu: boolean;
  /** 各动作的开关与可选自定义 prompt */
  actions: Record<ActionKey, ActionConfig>;
}

// genId 从 $lib/utils 复用（下方 import）

/** 默认配置。 */
export function defaultConfig(): AppConfig {
  return {
    activeEngine: "llm",
    providers: [
      {
        id: genId(),
        name: "OpenAI",
        format: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
      },
    ],
    activeProviderId: "",
    deeplx: { endpoint: "http://localhost:1188/translate" },
    google: {
      endpoint: "https://translate.googleapis.com/translate_a/single",
    },
    targetLang: "zh",
    sourceLang: "auto",
    window: { width: 400, height: 480 },
    hotkey: "Alt+D",
    ocrHotkey: "Alt+S",
    ocrEngine: "system",
    ocrProvider: {
      baseUrl: "http://localhost:11434",
      apiKey: "",
      model: "",
      ocrPrompt:
        "识别并只输出图片中的文字内容，保持原有换行和排版，不要添加任何解释或标记。如果没有文字，输出空。",
      genParams: emptyGenParams(),
    },
    autoStart: false,
    theme: "system",
    enableThinking: true,
    defaultAction: "translate",
    showActionMenu: true,
    actions: {
      translate: { enabled: true },
      summarize: { enabled: true },
      polish: { enabled: true },
      explain: { enabled: true },
      chat: { enabled: true },
      ocr: { enabled: true },
    },
  };
}

let storeInstance: LazyStore | null = null;

function store(): LazyStore {
  if (!storeInstance) {
    storeInstance = new LazyStore(STORE_FILE);
  }
  return storeInstance;
}

/** 加载完整配置：读取已存值并合并默认值（保证新增字段不丢失）。
 *  兼容旧版：把旧的 engines.openai 自动迁移成 providers[0]。 */
export async function loadConfig(): Promise<AppConfig> {
  const def = defaultConfig();
  // 保证默认 providers 有 id 且 activeProviderId 指向第一个
  if (def.providers.length && !def.activeProviderId) {
    def.activeProviderId = def.providers[0].id;
  }
  try {
    const raw = await store().get<any>("config");
    if (raw) {
      const merged: AppConfig = {
        ...def,
        ...raw,
        providers: Array.isArray(raw.providers) && raw.providers.length
          ? raw.providers
          : def.providers,
        deeplx: { ...def.deeplx, ...(raw.deeplx ?? raw.engines?.deeplx ?? {}) },
        google: { ...def.google, ...(raw.google ?? raw.engines?.google ?? {}) },
        window: { ...def.window, ...(raw.window ?? {}) },
        actions: { ...def.actions, ...(raw.actions ?? {}) },
        ocrProvider: { ...def.ocrProvider, ...(raw.ocrProvider ?? {}) },
      };
      // 迁移：旧版 engines.openai → providers
      if (
        (!raw.providers || !raw.providers.length) &&
        raw.engines?.openai
      ) {
        const o = raw.engines.openai;
        merged.providers = [
          {
            id: genId(),
            name: "OpenAI",
            format: "openai-chat",
            baseUrl: o.baseUrl ?? "https://api.openai.com/v1",
            apiKey: o.apiKey ?? "",
            model: o.model ?? "gpt-4o-mini",
          },
        ];
      }
      // 兼容：老 providers 没有 format 字段，补默认 openai-chat；补全 genParams
      merged.providers = merged.providers.map((p) => ({
        ...p,
        format: (p.format ?? "openai-chat") as LlmProvider["format"],
        genParams: normalizeGenParams(p.genParams ?? emptyGenParams()),
      }));
      // ocrProvider 同样补全 genParams（老配置没有该字段）
      merged.ocrProvider.genParams = normalizeGenParams(
        merged.ocrProvider.genParams ?? emptyGenParams(),
      );
      // 旧版 activeEngine 可能是 'openai'，统一映射到 'llm'
      if (merged.activeEngine === "openai") merged.activeEngine = "llm";
      // activeProviderId 兜底指向第一个
      if (
        !merged.activeProviderId &&
        merged.providers.length
      ) {
        merged.activeProviderId = merged.providers[0].id;
      }
      // 校验 activeProviderId 仍存在
      if (
        merged.activeProviderId &&
        !merged.providers.find((p) => p.id === merged.activeProviderId)
      ) {
        merged.activeProviderId = merged.providers[0]?.id ?? "";
      }
      return merged;
    }
  } catch (e) {
    console.warn("读取配置失败，使用默认值:", e);
  }
  return def;
}

/** 保存完整配置。 */
export async function saveConfig(cfg: AppConfig): Promise<void> {
  try {
    await store().set("config", cfg);
    await store().save();
  } catch (e) {
    console.error("保存配置失败:", e);
    throw e;
  }
}

/** 取当前激活的 LLM 提供商（无则 null）。 */
export function getActiveProvider(cfg: AppConfig): LlmProvider | null {
  return (
    cfg.providers.find((p) => p.id === cfg.activeProviderId) ??
    cfg.providers[0] ??
    null
  );
}

/** 归一化生成参数：number input 空值/非法值会变成 NaN，落库前统一转成 null。
 *  返回新对象，不改原 cfg（调用方自行赋值）。 */
export function normalizeGenParams(p: GenParams): GenParams {
  const clean = (v: any): number | null => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  return {
    temperature: clean(p.temperature),
    topP: clean(p.topP),
    maxTokens: clean(p.maxTokens),
    frequencyPenalty: clean(p.frequencyPenalty),
  };
}

/** 保存配置并同步副作用：快捷键若变更，调用 Rust 命令即时重新注册。 */
export async function saveConfigWithSideEffects(
  cfg: AppConfig,
  prevHotkey?: string,
): Promise<{ hotkeyError?: string }> {
  await saveConfig(cfg);
  const result: { hotkeyError?: string } = {};
  if (prevHotkey && prevHotkey !== cfg.hotkey) {
    try {
      await invoke("update_hotkey", { newHotkey: cfg.hotkey });
    } catch (e: any) {
      result.hotkeyError = e?.message ?? String(e);
    }
  }
  // OCR 快捷键也即时生效
  try {
    await invoke("update_ocr_hotkey", { newHotkey: cfg.ocrHotkey });
  } catch {
    /* 忽略 */
  }
  return result;
}
