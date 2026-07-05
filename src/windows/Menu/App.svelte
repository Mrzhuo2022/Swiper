<script lang="ts">
  /**
   * 动作菜单窗。
   *
   * 划词后 Rust 取到选中文本，deliver("new_text", text) 并显示此窗（鼠标附近）。
   * 本窗展示一排动作按钮；用户点一个 → emit("menu_action", {action, text})
   * → Rust 接管：关闭本窗、打开结果窗执行该动作。
   *
   * 数据投递（消除首帧竞态）：onMount 时先主动拉取 take_pending（首帧兜底），
   * 再 emit("window_ready") 告知 Rust 可补发；之后靠 new_text listener 实时更新。
   * 失焦 150ms 隐藏（防抖）。
   */
  import { onMount, onDestroy } from "svelte";
  import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import { loadConfig } from "$lib/store";
  import { ACTIONS, type ActionKey } from "$lib/actions";
  import { engineSupports } from "$services/translate";

  const appWindow = getCurrentWindow();
  let text = $state("");
  let engineKey = $state("llm");
  let cfgActions: Record<string, { enabled: boolean }> = {};
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let hasFocused = false; // 防止窗口刚 show 还没聚焦就失焦被误关
  let unlistenFns: UnlistenFn[] = [];

  /** 每次显示都重新读配置（窗口持久复用，onMount 只跑一次，配置变更不会自动刷新）。 */
  async function refreshConfig() {
    const cfg = await loadConfig();
    engineKey = cfg.activeEngine;
    cfgActions = cfg.actions;
  }

  onMount(async () => {
    // 1. 首帧兜底：主动拉取 Rust 缓存的 payload（防止 emit 早于 mount 丢失）
    try {
      const pending = await invoke<{ event: string; payload: any } | null>(
        "take_pending",
        { label: "menu" },
      );
      if (pending?.event === "new_text" && typeof pending.payload === "string") {
        text = pending.payload;
        await refreshConfig();
      }
    } catch {}

    // 2. 注册实时监听：每次收到 new_text（即每次显示）都重读配置，
    //    确保用户在设置里改的引擎/动作开关即时生效。
    unlistenFns.push(
      await listen<string>("new_text", async (e) => {
        text = e.payload;
        await refreshConfig();
      }),
    );

    // 3. 告知 Rust 本窗口已就绪（可补发缓存）
    await emit("window_ready", "menu");

    // 4. 失焦延迟关闭（只在曾聚焦过后才生效，避免 show 初期抖动）
    unlistenFns.push(
      await appWindow.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          hasFocused = true;
          cancelBlur();
        } else if (hasFocused) {
          scheduleClose();
        }
      }),
    );
  });

  onDestroy(() => {
    unlistenFns.forEach((fn) => fn());
    if (blurTimer) clearTimeout(blurTimer);
  });

  function cancelBlur() {
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
  }
  function scheduleClose() {
    cancelBlur();
    blurTimer = setTimeout(() => {
      appWindow.hide().catch(() => {});
      text = ""; // 隐藏后清空，避免下次显示残留
      hasFocused = false;
      blurTimer = null;
    }, 150);
  }

  /** 点击动作：通知 Rust，由 Rust 关本窗 + 开结果窗。 */
  function pick(action: ActionKey) {
    cancelBlur();
    emit("menu_action", { action, text });
  }

  /** 数字快捷键 1-9：按序号选可见动作（跳过点击）。 */
  function onKeydown(e: KeyboardEvent) {
    if (!text) return;
    const n = parseInt(e.key, 10);
    if (!isNaN(n) && n >= 1 && n <= 9) {
      // 取当前可见的第 n 个动作（排除 ocr）
      const visible = ACTIONS.filter(
        (a) =>
          a.inMenu &&
          engineSupports(engineKey, a.key) &&
          isEnabled(a.key),
      );
      if (visible[n - 1]) {
        e.preventDefault();
        pick(visible[n - 1].key);
      }
    }
  }

  function isEnabled(key: ActionKey): boolean {
    return cfgActions[key]?.enabled ?? true;
  }

  /** 当前引擎支持且启用、且属于划词菜单的动作（ocr 不进菜单）。 */
  let buttons = $derived(
    text
      ? ACTIONS.filter(
          (a) =>
            a.inMenu &&
            engineSupports(engineKey, a.key) &&
            isEnabled(a.key),
        )
      : [],
  );
</script>

<svelte:window onkeydown={onKeydown} />

<div class="bar" data-tauri-drag-region>
  {#if !text}
    <span class="muted">等待选中文本…</span>
  {:else}
    {#each buttons as action, i (action.key)}
      <button
        class="act"
        title={`${action.name}（按 ${i + 1}）`}
        onclick={() => pick(action.key)}
      >
        <span class="ico">{action.icon}</span>
        <span class="lbl">{action.name}</span>
        <span class="num">{i + 1}</span>
      </button>
    {/each}
  {/if}
</div>

<style>
  .bar {
    display: flex;
    align-items: stretch;
    height: 100vh;
    padding: 5px;
    gap: 4px;
    background: var(--bg);
    border-radius: 14px;
    box-shadow: var(--shadow);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .muted {
    color: var(--text-muted);
    font-size: 12px;
    padding: 0 10px;
    align-self: center;
  }
  .act {
    position: relative;
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    border: none;
    background: transparent;
    border-radius: 9px;
    padding: 4px 2px;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .act:hover {
    background: var(--accent-soft);
  }
  .act:hover .ico {
    background: var(--accent);
    color: #fff;
  }
  .ico {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 50%;
    transition: all 0.12s ease;
  }
  .lbl {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1;
  }
  .act:hover .lbl {
    color: var(--accent);
  }
  .num {
    position: absolute;
    top: 2px;
    right: 3px;
    font-size: 9px;
    color: var(--text-muted);
    opacity: 0.6;
    line-height: 1;
  }
</style>
