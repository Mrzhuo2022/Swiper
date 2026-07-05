<script lang="ts">
  /**
   * Chatbox —— 独立常驻对话窗（迷你 ChatGPT）。
   *
   * - 多轮对话，流式输出，支持思维链折叠
   * - 复用 LLM 引擎（按当前 provider + format）
   * - 对话自动存历史（saveChat）；可新建、切换（本窗内单会话，历史在设置可查）
   * - 消息 Markdown 渲染、复制反馈
   */
  import { onMount } from "svelte";
  import { loadConfig, getActiveProvider, saveConfig, type AppConfig } from "$lib/store";
  import { fetchModels } from "$lib/models";
  import { runAction } from "$services/translate";
  import type { ChatMessage } from "$services/translate/types";
  import { renderMarkdown } from "$lib/markdown";
  import { saveChat } from "$lib/history";
  import { invoke } from "@tauri-apps/api/core";

  let cfg = $state<AppConfig | null>(null);
  /** 对话消息（system + 多轮 user/assistant）。 */
  let messages = $state<ChatMessage[]>([]);
  /** 渲染用的消息（不含 system）。 */
  let visible = $derived(messages.filter((m) => m.role !== "system"));
  let input = $state("");
  let loading = $state(false);
  let abortCtrl: AbortController | null = null;
  /** 当前流式 assistant 的索引（messages 里）。 */
  let streamingIdx = $state(-1);
  let reasoning = $state("");
  let reasoningOpen = $state(false);
  let copiedId = $state(-1);
  let chatId = $state("");
  let scrollEl: HTMLElement | null = $state(null);

  onMount(async () => {
    cfg = await loadConfig();
    // 系统提示词作为首条 system
    messages = [
      {
        role: "system",
        content:
          "You are Swiper, a helpful AI assistant. Reply in the user's language (default 中文). Be concise and useful. Use Markdown when helpful.",
      },
    ];
    // 初始化当前模型 + 拉取模型列表
    const provider = getActiveProvider(cfg);
    currentModel = provider?.model ?? "";
    loadModelsForProvider();
  });

  /** 自动滚到底。 */
  function scrollBottom() {
    setTimeout(() => {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }, 0);
  }

  /** 发送一条消息。 */
  async function send() {
    const q = input.trim();
    if (!q || loading || !cfg) return;
    input = "";
    messages = [...messages, { role: "user", content: q }];
    // 占位一条空 assistant，流式填充
    const assistantMsg: ChatMessage = { role: "assistant", content: "" };
    messages = [...messages, assistantMsg];
    streamingIdx = messages.length - 1;
    reasoning = "";
    loading = true;
    abortCtrl = new AbortController();
    scrollBottom();

    const provider = getActiveProvider(cfg);
    if (!provider) {
      messages[streamingIdx].content = "⚠️ 未配置 LLM 提供商，请先在设置里添加。";
      loading = false;
      return;
    }
    const engineConfig = { ...provider, model: currentModel || provider.model, enableThinking: cfg.enableThinking };

    try {
      const full = await runAction(
        "llm",
        "chat",
        messages.slice(0, -1), // 不含占位的空 assistant
        engineConfig,
        { targetLang: cfg.targetLang },
        (t) => {
          messages[streamingIdx].content = t;
          messages = [...messages];
          scrollBottom();
        },
        cfg.enableThinking
          ? (r) => {
              reasoning = r;
            }
          : undefined,
        abortCtrl?.signal,
      );
      if (full) messages[streamingIdx].content = full;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // 中断时保留已输出内容，不显示错误
      if (!/cancel|abort/i.test(msg)) {
        messages[streamingIdx].content = "⚠️ " + msg;
      }
    } finally {
      loading = false;
      streamingIdx = -1;
      abortCtrl = null;
      // 持久化（去掉占位空 assistant 后）
      const firstUser = visible.find((m) => m.role === "user")?.content;
      const titleStr = (typeof firstUser === "string" ? firstUser : "").slice(0, 24) || "对话";
      chatId = await saveChat({
        id: chatId || undefined,
        title: titleStr,
        messages: messages.filter((m) => m.content),
      });
    }
  }

  /** 中断当前回复。 */
  function stop() {
    abortCtrl?.abort();
    loading = false;
    streamingIdx = -1;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function copy(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text);
      copiedId = idx;
      setTimeout(() => (copiedId = -1), 1200);
    } catch {}
  }

  /** 新建对话（清空）。 */
  function newChat() {
    messages = messages.slice(0, 1); // 只留 system
    chatId = "";
    reasoning = "";
    input = "";
  }

  /** 打开设置窗口。 */
  async function openSettings() {
    try {
      await invoke("open_config");
    } catch (e) {
      console.error(e);
    }
  }

  // 当前选中的模型名（可不同于 provider.model —— 支持同一 provider 下选多个模型）
  let currentModel = $state("");
  // 当前 provider 的可用模型列表（拉取自 /models，Claude 等无此端点则空）
  let availableModels = $state<string[]>([]);
  let modelsLoading = $state(false);
  // provider id → 已拉取的模型列表缓存
  let modelsCache: Record<string, string[]> = {};

  /** 切换提供商：保存 + 用该 provider 的默认模型 + 拉取其模型列表。 */
  async function onProviderChange() {
    if (!cfg) return;
    const provider = getActiveProvider(cfg);
    currentModel = provider?.model ?? "";
    await saveConfig(cfg);
    await loadModelsForProvider();
  }

  /** 拉取当前 provider 的可用模型列表（带缓存）。 */
  async function loadModelsForProvider() {
    if (!cfg) return;
    const provider = getActiveProvider(cfg);
    if (!provider) {
      availableModels = [];
      return;
    }
    // Claude 无 /models 端点，直接用配置里的 model
    if (provider.format === "claude") {
      availableModels = provider.model ? [provider.model] : [];
      return;
    }
    // 命中缓存
    if (modelsCache[provider.id]) {
      availableModels = modelsCache[provider.id];
      return;
    }
    modelsLoading = true;
    try {
      const list = await fetchModels(provider.baseUrl, provider.apiKey);
      const ids = list.map((m) => m.id);
      availableModels = ids;
      modelsCache[provider.id] = ids;
    } catch {
      availableModels = provider.model ? [provider.model] : [];
    } finally {
      modelsLoading = false;
    }
  }

  /** 切换模型（不持久化到 provider，仅本次会话生效）。 */
  function onModelChange() {
    // currentModel 已被 bind 更新；无需额外动作
  }

  let canSend = $derived(input.trim().length > 0 && !loading);
</script>

<div class="chat">
  <header data-tauri-drag-region>
    <span class="title">Swiper Chat</span>
    <div class="head-tools">
      {#if reasoning}
        <button class="ht-btn" onclick={() => (reasoningOpen = !reasoningOpen)}>
          {reasoningOpen ? "▾" : "▸"} 思考
        </button>
      {/if}
      <button class="ht-btn" onclick={newChat} title="新对话">＋ 新对话</button>
      <button class="ht-btn" onclick={openSettings} title="设置">设置</button>
    </div>
  </header>

  {#if reasoning && reasoningOpen}
    <div class="reasoning-bar">{reasoning}</div>
  {/if}

  <main bind:this={scrollEl}>
    {#if visible.length === 0}
      <div class="empty">
        <p>开始对话吧 ✨</p>
        <p class="muted">输入问题，Enter 发送，Shift+Enter 换行</p>
      </div>
    {/if}
    {#each visible as m, i (i)}
      <div class="msg" class:user={m.role === "user"} class:assistant={m.role === "assistant"}>
        <div class="bubble">
          {#if m.role === "assistant"}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="markdown">{@html renderMarkdown((typeof m.content === "string" ? m.content : "") || (loading && i === streamingIdx ? "…" : ""))}</div>
          {:else}
            <div class="user-text">{typeof m.content === "string" ? m.content : ""}</div>
          {/if}
        </div>
        {#if m.role === "assistant" && m.content}
          <button class="copy" onclick={() => copy(typeof m.content === "string" ? m.content : "", i)}>
            {copiedId === i ? "✓ 已复制" : "复制"}
          </button>
        {/if}
      </div>
    {/each}
  </main>

  <!-- 输入区：模型选择 + 输入框 -->
  <footer>
    {#if cfg}
      <div class="model-bar">
        <!-- 提供商选择 -->
        <select
          class="model-select"
          bind:value={cfg.activeProviderId}
          onchange={onProviderChange}
          title="选择提供商"
        >
          {#each cfg.providers as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
        <span class="sep">›</span>
        <!-- 模型选择：有列表时用 select（下拉可靠），无列表时用 input 可手填 -->
        {#if availableModels.length}
          <select
            class="model-select"
            bind:value={currentModel}
            onchange={onModelChange}
            title="选择模型"
          >
            {#if currentModel && !availableModels.includes(currentModel)}
              <option value={currentModel}>{currentModel}</option>
            {/if}
            {#each availableModels as m}
              <option value={m}>{m}</option>
            {/each}
          </select>
        {:else}
          <input
            class="model-input"
            bind:value={currentModel}
            onchange={onModelChange}
            placeholder="模型"
            title="输入模型名"
          />
        {/if}
        <button
          class="refresh-models"
          onclick={loadModelsForProvider}
          disabled={modelsLoading}
          title="刷新模型列表"
        >{modelsLoading ? "…" : "↻"}</button>
      </div>
    {/if}
    <div class="input-row">
      <textarea
        placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
        bind:value={input}
        onkeydown={onKeydown}
        rows="1"
      ></textarea>
      {#if loading}
        <button class="send stop" onclick={stop} title="停止生成">停止</button>
      {:else}
        <button class="primary send" onclick={send} disabled={!canSend}>
          发送
        </button>
      {/if}
    </div>
  </footer>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    height: 40px;
    background: var(--bg-soft);
    border-bottom: 1px solid var(--border);
    cursor: default;
    flex-shrink: 0;
  }
  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .head-tools {
    display: flex;
    gap: 6px;
  }
  .ht-btn {
    font-size: 12px;
    padding: 3px 9px;
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 6px;
    color: var(--text-muted);
  }
  .ht-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .reasoning-bar {
    padding: 6px 14px;
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-soft);
    border-bottom: 1px solid var(--border);
    max-height: 120px;
    overflow-y: auto;
    white-space: pre-wrap;
  }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .empty {
    margin: auto;
    text-align: center;
    color: var(--text);
  }
  .empty p {
    margin: 4px 0;
  }
  .muted {
    color: var(--text-muted);
    font-size: 13px;
  }
  .msg {
    display: flex;
    flex-direction: column;
    max-width: 85%;
  }
  .msg.user {
    align-self: flex-end;
    align-items: flex-end;
  }
  .msg.assistant {
    align-self: flex-start;
    align-items: flex-start;
  }
  .bubble {
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.65;
    word-break: break-word;
  }
  .msg.user .bubble {
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .msg.assistant .bubble {
    background: var(--bg-soft);
    color: var(--text);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }
  .user-text {
    white-space: pre-wrap;
  }
  .copy {
    margin-top: 4px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
  }
  .copy:hover {
    color: var(--accent);
  }
  footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    background: var(--bg-soft);
    flex-shrink: 0;
  }
  .model-bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .model-select {
    width: auto;
    font-size: 12px;
    padding: 3px 8px;
    max-width: 140px;
  }
  .sep {
    color: var(--text-muted);
    font-size: 12px;
  }
  .model-input {
    width: auto;
    font-size: 12px;
    padding: 3px 8px;
    flex: 1;
    max-width: 220px;
  }
  .refresh-models {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 6px;
    font-size: 12px;
    line-height: 1;
    color: var(--text-muted);
  }
  .refresh-models:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .refresh-models:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  footer textarea {
    flex: 1;
    resize: none;
    max-height: 120px;
    font-family: inherit;
  }
  .send {
    align-self: stretch;
  }
  .send.stop {
    background: var(--danger);
    color: #fff;
    border: none;
  }
  /* Markdown（复用样式） */
  .markdown :global(p) {
    margin: 0 0 8px 0;
  }
  .markdown :global(p:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(pre) {
    background: var(--bg);
    padding: 10px 12px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 6px 0;
  }
  .markdown :global(code) {
    background: var(--bg);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .markdown :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 4px 0 8px 0;
    padding-left: 20px;
  }
  .markdown :global(a) {
    color: var(--accent);
  }
</style>
