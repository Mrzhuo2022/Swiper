import { mount } from "svelte";
import "./app.css";
import MenuApp from "./windows/Menu/App.svelte";
import ResultApp from "./windows/Result/App.svelte";
import ChatApp from "./windows/Chat/App.svelte";
import ConfigApp from "./windows/Config/App.svelte";
import SnipApp from "./windows/Snip/App.svelte";
import { loadConfig } from "$lib/store";
import { applyTheme, watchTheme } from "$lib/theme";

/**
 * 多窗口入口路由。
 *
 * 每个 Tauri 窗口都加载同一个 index.html，但通过 URL 查询参数 `?window=<label>`
 * 区分要挂载哪个组件。
 *
 * 关键：先立即挂载组件（保证窗口不卡死/空白），主题异步应用（带超时兜底，
 * 避免读取配置 hang 住导致整窗不渲染）。
 */
function getTargetWindow(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("window") ?? "result").toLowerCase();
}

const target = getTargetWindow();
const el = document.getElementById("app")!;

// 立即挂载，不阻塞
if (target === "config") {
  mount(ConfigApp, { target: el });
} else if (target === "menu") {
  mount(MenuApp, { target: el });
} else if (target === "chat") {
  mount(ChatApp, { target: el });
} else if (target === "snip") {
  mount(SnipApp, { target: el });
} else {
  mount(ResultApp, { target: el });
}

// 异步应用主题（不阻塞挂载；带 1s 超时兜底，防止读取配置 hang 住）
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}
withTimeout(loadConfig(), 1000)
  .then((cfg) => {
    if (cfg) applyTheme(cfg.theme);
  })
  .catch(() => {});

// 监听其它窗口的主题变更，本窗口同步（Chat/Result 等已开着的窗口切主题时生效）
watchTheme().catch(() => {});
