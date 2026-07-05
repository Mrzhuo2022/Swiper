<script lang="ts">
  /**
   * 结果窗。
   *
   * Rust 打开本窗并 emit("run_action", { action, text })。
   * - 翻译/总结/润色/解释：流式输出，单次结果。
   * - 提问(chat)：底部带输入框，可多轮追问（累积 messages 历史）。
   * - 思维链：默认折叠可展开。
   * - 钉住按钮：固定窗口后不失焦隐藏。
   *
   * 顶部动作栏可一键切换动作重跑。失焦隐藏（防抖，钉住时禁用）。
   */
  import { onMount, onDestroy } from "svelte";
  import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";
  import { loadConfig, getActiveProvider, type AppConfig } from "$lib/store";
  import { ACTIONS, getAction, buildPrompt, type ActionKey } from "$lib/actions";
  import { LANGUAGES } from "$lib/lang";
  import { runAction, engineSupports } from "$services/translate";
  import type { ChatMessage } from "$services/translate/types";
  import { runOcr } from "$services/translate/llm";
  import { renderMarkdown } from "$lib/markdown";
  import { addQuick } from "$lib/history";
  import { detectRepetition } from "$lib/repetition";

  const appWindow = getCurrentWindow();

  let cfg = $state<AppConfig | null>(null);
  let currentAction = $state<ActionKey>("translate");
  let source = $state("");
  let output = $state("");
  let resultLang = $state("zh"); // 结果窗翻译目标语言（默认取配置，可即时改）
  let reasoning = $state(""); // 思维链累积文本
  let reasoningOpen = $state(false); // 思维链折叠态（默认折叠）
  let reasoningStart = $state(0); // 思考开始时间戳（算耗时）
  let reasoningDuration = $state(0); // 思考总耗时（秒），结束后定格
  let tick = $state(0); // 计时器触发器，让 derived 在加载中实时刷新
  let loading = $state(false);
  let error = $state("");
  let pinned = $state(false); // 钉住：固定窗口，不失焦隐藏
  let lastImage = $state(""); // OCR 上次用的图片 data URL，供「重新生成」重跑视觉模型
  let abortCtrl: AbortController | null = null; // 中断当前流式请求
  let repetitionAborted = $state(false); // 是否因检测到复读而自动中断
  // chat 模式的对话历史（含 system + 多轮 user/assistant）
  let history = $state<ChatMessage[]>([]);
  const MAX_HISTORY = 50; // 聊天历史上限（含 system prompt），超出裁掉最旧对话轮次
  let chatInput = $state("");
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let hasFocused = false; // 防止窗口刚 show 还没聚焦就失焦被误关
  let unlistenFns: UnlistenFn[] = [];

  const actionDef = $derived(getAction(currentAction));
  const isChat = $derived(actionDef.isChat);
  const isOcr = $derived(currentAction === "ocr");
  // 「干净模式」：只展示结果本身，隐藏顶部标签栏/原文区/思考链。
  // 当前仅 OCR 走干净模式；预留为派生便于以后其它动作复用。
  const clean = $derived(isOcr);
  const outputHtml = $derived(renderMarkdown(output));

  onMount(async () => {
    cfg = await loadConfig();
    resultLang = cfg.targetLang; // 默认用配置的目标语言

    // 首帧兜底：主动拉取 Rust 缓存的 payload
    try {
      const pending = await invoke<{ event: string; payload: any } | null>(
        "take_pending",
        { label: "result" },
      );
      if (pending?.event === "run_action" && pending.payload) {
        executeAction(pending.payload.action, pending.payload.text ?? "", pending.payload.image);
      }
    } catch {}

    unlistenFns.push(
      await listen<{ action: ActionKey; text?: string; image?: string }>(
        "run_action",
        (e) => {
          executeAction(e.payload.action, e.payload.text ?? "", e.payload.image);
        },
      ),
    );
    // 告知 Rust 已就绪（可补发缓存）
    await emit("window_ready", "result");

    // 失焦延迟关闭（只在曾聚焦过后且未钉住时才生效）
    unlistenFns.push(
      await appWindow.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          hasFocused = true;
          cancelBlur();
        } else if (hasFocused && !pinned) {
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
    if (pinned) return; // 钉住时不隐藏
    cancelBlur();
    blurTimer = setTimeout(() => {
      // 隐藏而非关闭：窗口持久化复用，避免每次重建。重置状态防残留。
      appWindow.hide().catch(() => {});
      output = "";
      reasoning = "";
      reasoningOpen = false;
      history = [];
      lastImage = "";
      repetitionAborted = false;
      hasFocused = false;
      blurTimer = null;
    }, 150);
  }

  /** 切换钉住状态。钉住后窗口固定，点别处不隐藏。 */
  function togglePin() {
    pinned = !pinned;
    if (pinned) cancelBlur();
  }

  /** 关闭窗口（隐藏复用，重置状态防残留）。 */
  function closeWindow() {
    cancelBlur();
    appWindow.hide().catch(() => {});
    output = "";
    reasoning = "";
    reasoningOpen = false;
    history = [];
    lastImage = "";
    repetitionAborted = false;
    hasFocused = false;
  }

  // 加载中时每 100ms 触发一次 tick，让思考耗时实时刷新（$derived 不会自动随时钟变）。
  $effect(() => {
    if (!loading) return;
    const timer = setInterval(() => {
      tick++;
    }, 100);
    return () => clearInterval(timer);
  });

  /** 当前思考耗时（秒）：加载中实时算（引用 tick 触发刷新），结束后用定格值。 */
  let reasoningSeconds = $derived(
    loading && reasoningStart
      ? Math.max(0, (Date.now() - reasoningStart) / 1000) + tick * 0
      : reasoningDuration,
  );

  /**
   * 执行一个动作。
   * - 非 chat：拼 system + 单条 user，流式输出。
   * - chat：保留历史，追加 user，流式输出后把完整 assistant 回答回填进历史。
   */
  async function executeAction(action: ActionKey, text: string, image?: string) {
    // 每次执行前重新加载配置：结果窗是持久化复用的（hide 而非 close），
    // 否则用户在设置里改了 provider/模型/动作开关后，旧 cfg 缓存不刷新 → 用旧配置。
    // resultLang 保留用户在结果窗手选的翻译目标语言，不被配置覆盖。
    cfg = await loadConfig();
    currentAction = action;
    source = text;
    error = "";
    repetitionAborted = false;
    loading = true;
    reasoning = "";
    reasoningDuration = 0;
    // 先中止上一轮请求，再建新控制器，防 switchAction 在加载中切换时旧请求残留
    abortCtrl?.abort();
    abortCtrl = new AbortController();

    const def = getAction(action);

    // 特殊动作：OCR。
    // - 有 text（系统 OCR 已得文本）→ 直接显示，不调引擎。
    // - 有 image（LLM OCR）→ 用 ocrProvider 跑多模态流式。
    // 两种路径都只「显示识别文本」，绝不自动请求解释/翻译；用户需要时点底部「复制」。
    if (action === "ocr") {
      if (image) {
        await runOcrLlm(image);
      } else if (text) {
        output = text;
        loading = false;
      } else {
        error = "未识别到内容";
        loading = false;
      }
      return;
    }
    const engineKey = cfg.activeEngine; // 'deeplx' | 'google' | 'llm'
    const customPrompt = cfg.actions[action]?.customPrompt;
    // 翻译用结果窗选中的语言；其它动作 targetLang 无关紧要
    const opts = { targetLang: action === "translate" ? resultLang : cfg.targetLang };

    // LLM 引擎配置 = 当前选中的 provider
    const llmConfig = engineKey === "llm" ? getActiveProvider(cfg) : null;
    if (engineKey === "llm" && !llmConfig) {
      error = "未配置 LLM 提供商，请在设置里添加";
      loading = false;
      return;
    }
    if (engineKey !== "llm" && !engineSupports(engineKey, action)) {
      const infoName = engineKey === "deeplx" ? "DeepLx" : "Google";
      error = `${infoName} 不支持「${def.name}」，请在设置里切换到 LLM 引擎`;
      loading = false;
      return;
    }

    reasoningStart = Date.now(); // 非 OCR 动作启动思考计时

    const engineConfig: Record<string, any> =
      engineKey === "llm"
        ? { ...(llmConfig as object), ...(llmConfig?.genParams ?? {}), enableThinking: cfg.enableThinking }
        : engineKey === "deeplx"
          ? cfg.deeplx
          : cfg.google;

    try {
      if (action === "chat") {
        // 多轮：首条 system + 首条 user(选中文本)；后续追问追加
        if (history.length === 0) {
          history = [
            { role: "system", content: buildPrompt(def, opts, customPrompt) },
            { role: "user", content: text },
          ];
        }
        output = "";
        const full = await runAction(
          engineKey,
          action,
          history,
          engineConfig,
          opts,
          (t) => onStreamDelta(t),
          cfg.enableThinking
            ? (r) => {
                reasoning = r;
              }
            : undefined,
          abortCtrl?.signal,
        );
        if (full) history.push({ role: "assistant", content: full });
        else if (output) history.push({ role: "assistant", content: output });
        capHistory();
      } else {
        // 单次动作：全新 messages
        const messages: ChatMessage[] = [
          { role: "system", content: buildPrompt(def, opts, customPrompt) },
          { role: "user", content: text },
        ];
        output = "";
        await runAction(
          engineKey,
          action,
          messages,
          engineConfig,
          opts,
          (t) => onStreamDelta(t),
          cfg.enableThinking
            ? (r) => {
                reasoning = r;
              }
            : undefined,
          abortCtrl?.signal,
        );
      }
    } catch (e: any) {
      // 用户主动中断时不报错（fetch abort 抛 "Request cancelled" / AbortError）
      const msg = e?.message ?? String(e);
      if (/cancel|abort/i.test(msg)) {
        // 保留已流式产出的部分输出
      } else {
        error = msg;
      }
    } finally {
      // 定格最终思考耗时（结束后仍显示具体秒数）
      if (reasoningStart) {
        reasoningDuration = Math.max(0, (Date.now() - reasoningStart) / 1000);
      }
      loading = false;
      reasoningStart = 0;
      abortCtrl = null;
      // 非对话动作且有输出 → 存历史
      if (output && action !== "chat") {
        addQuick({ action: getAction(action).name, source, target: output }).catch(() => {});
      }
    }
  }

  /** 中断当前流式输出。 */
  function stop() {
    abortCtrl?.abort();
    loading = false;
  }

  /** 裁剪聊天历史：超出 MAX_HISTORY 时裁掉最旧的对话轮次（保留 system prompt）。
   *  始终裁掉完整的 (user,assistant) 对，避免破坏配对结构。 */
  function capHistory() {
    if (history.length > MAX_HISTORY) {
      const excess = history.length - MAX_HISTORY;
      // 向上取偶数，确保裁掉完整轮次
      const remove = Math.ceil(excess / 2) * 2;
      history = [history[0], ...history.slice(remove + 1)];
    }
  }

  /**
   * 流式输出的统一回写回调：写入 output 前实时检测复读。
   * 命中 → 保留全部已产出文本 + abort 流 + 给出友好提示（不清除内容）。
   * 某些本地视觉/OCR 模型会无限重复同一片段导致流永不结束，这里客户端兜底中断。
   */
  function onStreamDelta(t: string) {
    if (repetitionAborted) return; // 已中断则不再写入
    if (detectRepetition(t).repeated) {
      repetitionAborted = true;
      output = t; // 保留全部已产出文本，不清除
      error = "检测到模型输出重复，已自动停止。可在设置「生成参数」里调低温度或加重复惩罚。";
      abortCtrl?.abort();
      loading = false;
      return;
    }
    output = t;
  }

  /** LLM OCR：用 ocrProvider 跑多模态流式。
   *  按 baseUrl 自动识别端点：Ollama 原生(/api/chat) 或 OpenAI 兼容(/v1/chat/completions)。
   *  image_url 多模态由 runOcr 分流：Ollama 路径在 ollama.ts 转成 images 字段，
   *  OpenAI 兼容路径在 chat.ts 原样透传 image_url。支持 GPT-4o/Qwen-VL/Ollama 等视觉模型。
   *  完成后 source 更新为识别出的文本，便于顶部切翻译等动作重跑。
   *
   *  提示词两种模式（由 ocrProvider.ocrPrompt 控制）：
   *  - 非空：在图片块前附该文本作识别指令 → 通用多模态模型(GPT-4o/Qwen-VL)知道要转录而非描述；
   *  - 清空：纯透传图片零文本 → 专用 OCR 模型(glm-ocr/llava-ocr)保持最佳精度。
   *  注：视觉 OCR 模型无思维链，强制 enableThinking:false
   *  （否则 ollama 端 think:true 对不支持的模型可能报错或卡在「思考中」）。 */
  async function runOcrLlm(image: string) {
    if (!cfg) return;
    lastImage = image; // 保留原图，供「重新生成」重跑视觉模型
    const provider = cfg.ocrProvider;
    if (!provider?.baseUrl || !provider?.model) {
      error = "请在设置里配置 OCR 提供商（BaseURL + 模型，支持 OpenAI 兼容 /v1 或 Ollama 原生端点）";
      loading = false;
      return;
    }
    // 按配置拼多模态 content：有提示词则 text 块在前 + 图片块；清空则只图片块。
    const prompt = provider.ocrPrompt?.trim() ?? "";
    const content: import("$services/translate/types").ContentPart[] = [];
    if (prompt) content.push({ type: "text", text: prompt });
    content.push({ type: "image_url", image_url: { url: image } });
    const messages: ChatMessage[] = [{ role: "user", content }];
    output = "";
    // OCR 不需要思维链：视觉 OCR 模型无思考能力，强制 enableThinking:false
    reasoning = "";
    reasoningDuration = 0;
    try {
      // runOcr 按 baseUrl 自动分流 Ollama 原生 / OpenAI 兼容执行器
      const full = await runOcr(messages, {
        config: { ...provider, ...(provider.genParams ?? {}), enableThinking: false },
        setResult: (t) => onStreamDelta(t),
        signal: abortCtrl?.signal,
      });
      const result = full || output;
      // 识别出的文本作为 source，便于顶部切「翻译」等动作重跑
      source = result;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (!/cancel|abort/i.test(msg)) error = msg;
    } finally {
      loading = false;
      abortCtrl = null;
    }
  }

  /** chat 模式：发送追问。 */
  async function sendChat() {
    const q = chatInput.trim();
    if (!q || loading) return;
    chatInput = "";
    history.push({ role: "user", content: q });
    error = "";
    repetitionAborted = false;
    loading = true;
    reasoning = "";
    reasoningDuration = 0;
    reasoningStart = Date.now();
    // 中止上一轮请求（sendChat 有 loading guard，但历史曾推入，安全起见仍 abort）
    abortCtrl?.abort();
    abortCtrl = new AbortController();
    const c = cfg!;
    const llmConfig = c.activeEngine === "llm" ? getActiveProvider(c) : null;
    const engineConfig: Record<string, any> =
      c.activeEngine === "llm"
        ? { ...(llmConfig as object), ...(llmConfig?.genParams ?? {}), enableThinking: c.enableThinking }
        : c.activeEngine === "deeplx"
          ? c.deeplx
          : c.google;
    try {
      const full = await runAction(
        c.activeEngine,
        "chat",
        history,
        engineConfig,
        { targetLang: c.targetLang },
        (t) => onStreamDelta(t),
        c.enableThinking
          ? (r) => {
              reasoning = r;
            }
          : undefined,
        abortCtrl?.signal,
      );
      if (full) history.push({ role: "assistant", content: full });
      capHistory();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (!/cancel|abort/i.test(msg)) error = msg;
    } finally {
      if (reasoningStart) {
        reasoningDuration = Math.max(0, (Date.now() - reasoningStart) / 1000);
      }
      loading = false;
      reasoningStart = 0;
      abortCtrl = null;
    }
  }

  function onChatKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  }

  /** 切换动作重跑（基于当前选中文本 source）。 */
  function switchAction(a: ActionKey) {
    if (a === currentAction) return;
    history = [];
    executeAction(a, source);
  }

  /** 切换目标语言：若有原文则用新语言重跑翻译。 */
  function changeLang() {
    if (source && !loading) {
      executeAction("translate", source);
    }
  }

  let copied = $state(false);
  async function copyOutput() {
    try {
      await navigator.clipboard.writeText(output);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {}
  }

  function retry() {
    history = [];
    // OCR 重新生成：原始图片在首次 runOcrLlm 后已丢失（source 被识别文本覆盖），
    // 用 lastImage 重跑视觉模型；系统 OCR（无图片）退回 source 文本路径。
    if (currentAction === "ocr" && lastImage) {
      executeAction("ocr", "", lastImage);
    } else {
      executeAction(currentAction, source);
    }
  }

  /** 顶部可切换的动作列表（当前引擎支持的）。 */
  let switchable = $derived.by(() => {
    if (!cfg) return [];
    return ACTIONS.filter(
      (a) => engineSupports(cfg!.activeEngine, a.key) && (cfg!.actions[a.key]?.enabled ?? true),
    );
  });
  /** OCR 干净模式底部「发送到」候选动作：可切换列表去掉 ocr 自身。 */
  let sendTargets = $derived(switchable.filter((a) => a.key !== "ocr"));
</script>

<div class="win" data-tauri-drag-region>
  <!-- 顶部动作栏：动作标签（左）+ 固定 + 关闭（右） -->
  <header data-tauri-drag-region>
    {#if clean}
      <!-- 干净模式（OCR）：只显示标题，不堆动作标签栏 -->
      <div class="title">
        <span class="tico">{actionDef.icon}</span>{actionDef.name}结果
      </div>
    {:else}
      <div class="acts">
        {#each switchable as a (a.key)}
          <button
            class="tab"
            class:active={a.key === currentAction}
            onclick={() => switchAction(a.key)}
            title={a.name}
          >
            <span class="tico">{a.icon}</span>{a.name}
          </button>
        {/each}
      </div>
    {/if}
    <div class="tools">
      <button
        class="icon-btn"
        class:active={pinned}
        title={pinned ? "取消固定" : "固定窗口（不失焦隐藏）"}
        aria-label={pinned ? "取消固定窗口" : "固定窗口"}
        onclick={togglePin}
      >{pinned ? "▣" : "▢"}</button>
      <button class="icon-btn close" title="关闭" aria-label="关闭" onclick={closeWindow}>✕</button>
    </div>
  </header>

  <!-- 原文（折叠区，chat / 干净模式不显示） -->
  {#if !isChat && !clean && source}
    <section class="source" data-tauri-drag-region>{source}</section>
    <!-- 翻译动作：原文下方的目标语言栏 -->
    {#if currentAction === "translate"}
      <div class="lang-bar">
        <span class="lang-label">译为</span>
        <select class="lang-select" bind:value={resultLang} onchange={changeLang} title="目标语言">
          {#each LANGUAGES as l}
            <option value={l.code}>{l.name}</option>
          {/each}
        </select>
      </div>
    {/if}
  {/if}

  <!-- 思维链（默认折叠）。仅在真正收到 reasoning 文本时显示（不支持思考的模型不会出现）。
       干净模式(OCR)永不显示。 -->
  {#if !clean && reasoning}
    <section class="reasoning">
      <button class="reasoning-toggle" onclick={() => (reasoningOpen = !reasoningOpen)}>
        <span class="arrow">{reasoningOpen ? "▾" : "▸"}</span>
        {#if loading}
          思考中… {reasoningSeconds.toFixed(1)}s
        {:else}
          已思考 {reasoningSeconds.toFixed(1)}s（点击展开）
        {/if}
      </button>
      {#if reasoningOpen && reasoning}
        <div class="reasoning-body">{reasoning}</div>
      {/if}
    </section>
  {/if}

  <!-- 输出区（含悬浮的复制/重试/停止按钮） -->
  <section class="output">
    {#if output}
      <!-- 有内容时优先显示输出（无论是否有 error），error 作为横幅浮在下方 -->
      <div class="out-text markdown">{@html outputHtml}{#if loading}<span class="cursor">▋</span>{/if}</div>
      {#if error}
        <div class="error-notice">{error}</div>
      {/if}
    {:else if error}
      <div class="error">{error}</div>
    {:else if loading && !reasoning}
      <span class="muted">{clean ? "识别中…" : "生成中…"}</span>
    {:else if !loading}
      <span class="muted">{isChat ? "问点什么…" : clean ? "等待识别…" : "等待结果…"}</span>
    {/if}

  <!-- 悬浮在结果区右下角的工具按钮（滚到底也可见）。
       干净模式(OCR)不在此处显示，改放到底部「发送到」/「停止」行，避免重复。 -->
    {#if (output || loading) && !clean}
      <div class="floating-tools">
        <button
          class="float-btn"
          title="复制"
          aria-label="复制"
          onclick={copyOutput}
          disabled={!output}
        >{copied ? "✓" : "⎘"}</button>
        {#if loading}
          <button class="float-btn" title="停止" aria-label="停止" onclick={stop}>■</button>
        {:else}
          <button class="float-btn" title="重新生成" aria-label="重新生成" onclick={retry} disabled={!source}>↻</button>
        {/if}
      </div>
    {/if}
  </section>

  <!-- 干净模式(OCR)底部操作栏：加载中只显示「停止」，完成后显示「发送到」+ 工具。 -->
  {#if clean}
    {#if loading}
      <div class="sendto-loading">
        <button class="float-btn" title="停止识别" aria-label="停止识别" onclick={stop}>■ 停止</button>
      </div>
    {:else if output}
      <section class="sendto">
        <div class="sendto-actions">
          <span class="sendto-label">发送到</span>
          {#each sendTargets as a (a.key)}
            <button class="tab" onclick={() => switchAction(a.key)} title={a.name}>
              <span class="tico">{a.icon}</span>{a.name}
            </button>
          {/each}
        </div>
        <div class="sendto-tools">
          <button
            class="float-btn"
            title="复制"
            aria-label="复制"
            onclick={copyOutput}
          >{copied ? "✓" : "⎘"}</button>
          <button
            class="float-btn"
            title="重新识别"
            aria-label="重新识别"
            onclick={retry}
            disabled={!source && !lastImage}
          >↻</button>
        </div>
      </section>
    {/if}
  {/if}

  <!-- chat 输入框 -->
  {#if isChat}
    <footer>
      <textarea
        placeholder="追问（Enter 发送，Shift+Enter 换行）"
        bind:value={chatInput}
        onkeydown={onChatKeydown}
        rows="1"
      ></textarea>
      <button class="primary send" onclick={sendChat} disabled={loading || !chatInput.trim()}>
        发送
      </button>
    </footer>
  {/if}
</div>

<style>
  .win {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px 4px 8px;
    height: 38px;
    background: var(--bg-soft);
    border-bottom: 1px solid var(--border);
    cursor: default;
    flex-shrink: 0;
  }
  .acts {
    display: flex;
    gap: 2px;
    overflow-x: auto;
  }
  .acts::-webkit-scrollbar {
    display: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 3px;
    border: none;
    background: transparent;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .tab:hover {
    background: var(--accent-soft);
  }
  .tab.active {
    background: var(--accent);
    color: #fff;
  }
  .tico {
    font-size: 13px;
  }
  .lang-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 14px 6px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-soft);
    flex-shrink: 0;
  }
  .lang-label {
    font-size: 11px;
    color: var(--text-muted);
  }
  .lang-select {
    width: auto;
    font-size: 12px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    border-radius: 6px;
    cursor: pointer;
  }
  .lang-select:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .tools {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }
  .icon-btn {
    border: none;
    background: transparent;
    padding: 4px 7px;
    font-size: 14px;
    color: var(--text-muted);
    border-radius: 6px;
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .icon-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  /* 关闭按钮：hover 变红，贴近系统关闭键习惯 */
  .icon-btn.close:hover {
    background: var(--danger);
    color: #fff;
  }
  /* 干净模式标题（替代动作标签栏）：图标 + 名字，占 header 左侧 */
  .title {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 输出区悬浮工具条：贴右下角，结果滚动时始终可见 */
  .floating-tools {
    position: sticky;
    bottom: 0;
    display: flex;
    gap: 4px;
    justify-content: flex-end;
    padding: 6px 0 2px;
    margin-top: 8px;
    background: linear-gradient(to top, var(--bg) 60%, transparent);
    pointer-events: auto;
  }
  .float-btn {
    border: 1px solid var(--border);
    background: var(--bg-soft);
    color: var(--text-muted);
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1;
  }
  .float-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .float-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  /* 干净模式(OCR)loading 行：仅「停止」按钮居中 */
  .sendto-loading {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    background: var(--bg-soft);
    flex-shrink: 0;
  }
  /* 干净模式(OCR)底部「发送到」动作栏：左动作按钮 + 右复制/重新识别 */
  .sendto {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    background: var(--bg-soft);
    flex-shrink: 0;
  }
  .sendto-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    overflow-x: auto;
  }
  .sendto-actions::-webkit-scrollbar {
    display: none;
  }
  .sendto-label {
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
    margin-right: 2px;
  }
  .sendto-tools {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  /* 思维链折叠区 */
  .reasoning {
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg-soft);
  }
  .reasoning-toggle {
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    padding: 6px 14px;
    font-size: 12px;
    color: var(--text-muted);
    border-radius: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .reasoning-toggle:hover {
    color: var(--accent);
  }
  .arrow {
    font-size: 10px;
    width: 10px;
  }
  .reasoning-body {
    padding: 4px 14px 10px 30px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 40%;
    overflow-y: auto;
    border-left: 2px solid var(--accent-soft);
    margin-left: 14px;
  }
  /* Markdown 渲染样式 */
  .markdown :global(p) {
    margin: 0 0 8px 0;
  }
  .markdown :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    margin: 10px 0 6px 0;
    font-size: 15px;
    font-weight: 600;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 4px 0 8px 0;
    padding-left: 20px;
  }
  .markdown :global(li) {
    margin: 2px 0;
  }
  .markdown :global(code) {
    background: var(--bg-soft);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: ui-monospace, "Cascadia Code", monospace;
    font-size: 12px;
  }
  .markdown :global(pre) {
    background: var(--bg-soft);
    padding: 10px 12px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 6px 0;
  }
  .markdown :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .markdown :global(a) {
    color: var(--accent);
    text-decoration: none;
  }
  .markdown :global(strong) {
    font-weight: 600;
  }
  .source {
    padding: 8px 14px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 35%;
    overflow-y: auto;
    flex-shrink: 0;
  }
  .output {
    flex: 1;
    padding: 12px 14px;
    overflow-y: auto;
    font-size: 14px;
    line-height: 1.7;
    color: var(--text);
    user-select: text;
  }
  .out-text {
    word-break: break-word;
  }
  .cursor {
    color: var(--accent);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .muted {
    color: var(--text-muted);
  }
  /* 输出已存在时的 error 横幅（不覆盖输出内容，浮在下方） */
  .error-notice {
    color: var(--danger);
    font-size: 12px;
    line-height: 1.4;
    background: var(--bg-soft);
    border: 1px solid var(--danger);
    border-radius: 6px;
    padding: 6px 10px;
    margin-top: 8px;
  }
  .error {
    color: var(--danger);
    font-size: 13px;
    background: var(--bg-soft);
    padding: 8px 10px;
    border-radius: 6px;
  }
  footer {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-soft);
    flex-shrink: 0;
  }
  footer textarea {
    flex: 1;
    resize: none;
    max-height: 80px;
    font-family: inherit;
  }
  .send {
    align-self: stretch;
  }
</style>
