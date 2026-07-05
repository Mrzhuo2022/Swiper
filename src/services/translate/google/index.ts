/**
 * Google Translate 免费端点引擎 —— 翻译专用，无需 key。
 *
 * 只支持翻译动作（supportedActions = ['translate']）。
 * 返回结构为嵌套数组，[0][0][0] 是逐句译文，拼接即可。
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { EngineInfo, TranslateFn } from "../types";
import type { ActionKey } from "$lib/actions";

export const supportedActions: ActionKey[] = ["translate"];

export const info: EngineInfo = {
  key: "google",
  name: "Google (Free)",
  online: true,
  supportedActions,
};

export const translate: TranslateFn = async (text, from, to, { config, setResult }) => {
  const endpoint: string =
    config.endpoint || "https://translate.googleapis.com/translate_a/single";
  const sourceLang = from && from !== "auto" ? from : "auto";

  const url =
    `${endpoint}?client=gtx` +
    `&sl=${encodeURIComponent(sourceLang)}` +
    `&tl=${encodeURIComponent(to)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Google 请求失败: ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json();

  const segments: any[] = Array.isArray(data?.[0]) ? data[0] : [];
  const target = segments.map((seg) => seg?.[0] ?? "").join("");

  setResult(target);
};
