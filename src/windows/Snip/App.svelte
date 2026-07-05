<script lang="ts">
  /**
   * 截图选区窗（OCR）。
   *
   * 显示 Rust 投递的整屏截图作为背景（不依赖窗口透明度），鼠标拖框选区域。
   * 松开后 emit("snip_complete", {x,y,w,h,scale})。
   * 坐标用 CSS 逻辑像素，附上 scaleFactor 由 Rust 转物理像素裁剪。
   * Esc / 右键 / 失焦 → emit("snip_cancel")。
   */
  import { onMount } from "svelte";
  import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";

  const appWindow = getCurrentWindow();
  let dragging = $state(false);
  let startX = 0;
  let startY = 0;
  let curX = $state(0);
  let curY = $state(0);
  let scale = 1;
  let bgUrl = $state("");
  let unlistenFns: UnlistenFn[] = [];
  // raf 节流：合并一帧内的多次 mousemove，避免高频触发 derived 重算 + DOM 重排
  let rafQueued = false;

  onMount(() => {
    appWindow.scaleFactor().then((f) => (scale = f)).catch(() => {});

    // 首帧兜底：主动拉取 Rust 缓存的截图背景
    invoke<{ event: string; payload: any } | null>("take_pending", { label: "snip" })
      .then((p) => {
        if (p?.event === "snip_bg" && typeof p.payload === "string") bgUrl = p.payload;
      })
      .catch(() => {});

    // 实时监听截图背景（窗口复用时走这里）
    listen<string>("snip_bg", (e) => {
      bgUrl = e.payload;
    }).then((un) => unlistenFns.push(un));

    // 告知 Rust 已就绪（可补发缓存）
    emit("window_ready", "snip");

    // 失焦也视为取消
    appWindow.onFocusChanged(({ payload: focused }) => {
      if (!focused) emit("snip_cancel");
    }).then((un) => unlistenFns.push(un));

    return () => unlistenFns.forEach((fn) => fn());
  });

  function onDown(e: MouseEvent) {
    if (e.button === 2) return; // 右键单独处理
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    pendingX = e.clientX;
    pendingY = e.clientY;
    curX = e.clientX;
    curY = e.clientY;
  }

  function onMove(e: MouseEvent) {
    if (!dragging) return;
    // 不直接写 $state，先存待用值，下一帧统一提交，合并高频 mousemove
    pendingX = e.clientX;
    pendingY = e.clientY;
    if (!rafQueued) {
      rafQueued = true;
      requestAnimationFrame(() => {
        rafQueued = false;
        curX = pendingX;
        curY = pendingY;
      });
    }
  }
  let pendingX = 0;
  let pendingY = 0;

  function onUp() {
    if (!dragging) return;
    dragging = false;
    // flush：确保松手时用的是最新坐标（最后一次 move 可能还在 raf 队列里）
    curX = pendingX;
    curY = pendingY;
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    if (w < 4 || h < 4) {
      // 太小，视为点击取消
      emit("snip_cancel");
      return;
    }
    emit("snip_complete", { x, y, w, h, scale });
  }

  function onContext(e: MouseEvent) {
    e.preventDefault();
    emit("snip_cancel");
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      emit("snip_cancel");
    }
  }

  // 选框位置/尺寸
  let rect = $derived(
    dragging
      ? {
          left: Math.min(startX, curX),
          top: Math.min(startY, curY),
          width: Math.abs(curX - startX),
          height: Math.abs(curY - startY),
        }
      : null,
  );
</script>

<svelte:window onkeydown={onKeydown} oncontextmenu={onContext} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="overlay"
  role="presentation"
  style={bgUrl ? `background: #000 url('${bgUrl}') center/100% 100% no-repeat` : ""}
  onmousedown={onDown}
  onmousemove={onMove}
  onmouseup={onUp}
>
  {#if rect}
    <!-- 单 div 选框：用超大 box-shadow 压暗四周（box-shadow 走合成层，不触发 layout，
         远快于 4 个 mask 块改尺寸）。位置/尺寸用 CSS 变量驱动，避免重排字符串拼接。 -->
    <div
      class="sel"
      style="--x:{rect.left}px;--y:{rect.top}px;--w:{rect.width}px;--h:{rect.height}px"
    ></div>
  {/if}
  <div class="hint" class:hidden={dragging}>拖拽选择要识别的区域 · Esc 取消</div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    cursor: crosshair;
    background: rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }
  /* 单选框 div：定位 + 尺寸用 CSS 变量（来自 inline style），四周压暗靠 box-shadow
     （0 0 0 9999px 覆盖整个视口，不触发 layout，仅合成层变换，拖拽最流畅）。 */
  .sel {
    position: absolute;
    left: var(--x);
    top: var(--y);
    width: var(--w);
    height: var(--h);
    border: 1.5px solid #3b82f6;
    background: rgba(59, 130, 246, 0.08);
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    will-change: transform, width, height;
  }
  .hint {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #fff;
    font-size: 14px;
    background: rgba(0, 0, 0, 0.6);
    padding: 8px 16px;
    border-radius: 8px;
    pointer-events: none;
  }
  .hidden {
    display: none;
  }
</style>
