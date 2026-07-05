/**
 * DeepLx 引擎 —— 翻译专用，自建/公共端点，无需 API key。
 *
 * 只支持翻译动作（supportedActions = ['translate']）。
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { EngineInfo, TranslateFn } from "../types";
import { toDeeplxCode } from "$lib/lang";
import type { ActionKey } from "$lib/actions";

export const supportedActions: ActionKey[] = ["translate"];

export const info: EngineInfo = {
  key: "deeplx",
  name: "DeepLx (Free)",
  online: true,
  supportedActions,
};

export const translate: TranslateFn = async (text, _from, to, { config, setResult }) => {
  const endpoint: string =
    config.endpoint || "http://localhost:1188/translate";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      source_lang: "", // 空字符串 = 自动检测
      target_lang: toDeeplxCode(to),
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepLx 请求失败: ${res.status} ${res.statusText}`);
  }

  const data: any = await res.json();
  const target: string =
    typeof data?.data === "string"
      ? data.data
      : Array.isArray(data?.alternatives) && data.alternatives.length
        ? data.alternatives[0]
        : "";

  setResult(target);
};
