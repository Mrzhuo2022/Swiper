/**
 * 主题应用 + 跨窗口同步。
 *
 * - applyTheme: 在 <html> 上设置 data-theme，控制深浅色。
 * - 广播: 应用主题时 emit 一个全局事件，其它窗口监听后同步应用。
 *   （每个 Tauri 窗口是独立 webview，data-theme 不共享，必须靠事件同步。）
 */
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ThemePref = "system" | "light" | "dark";

const THEME_EVENT = "swiper:theme-changed";

/** 在本窗口应用主题。 */
export function applyTheme(pref: ThemePref): void {
  const html = document.documentElement;
  if (pref === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", pref);
  }
}

/** 应用主题并广播给所有窗口（设置页改主题时调用）。 */
export async function applyThemeEverywhere(pref: ThemePref): Promise<void> {
  applyTheme(pref);
  try {
    await emit(THEME_EVENT, pref);
  } catch {
    /* 非 Tauri 环境忽略 */
  }
}

/** 监听其它窗口的主题变更，本窗口同步应用。返回取消监听函数。 */
export async function watchTheme(): Promise<UnlistenFn> {
  return listen<ThemePref>(THEME_EVENT, (e) => {
    applyTheme(e.payload);
  });
}
