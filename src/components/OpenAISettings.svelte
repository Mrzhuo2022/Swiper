<script lang="ts">
  /**
   * 单个 LLM 提供商的连接设置。
   *
   * - 端点格式：OpenAI Chat / OpenAI Responses / Claude Messages 三选一
   *   （决定请求体结构与 SSE 解析方式）
   * - API Key 显隐切换
   * - 一键拉取模型列表（仅 OpenAI 系有 /models；Claude 无，故隐藏按钮）
   * - 模型可手填
   */
  import { fetchModels } from "$lib/models";
  import type { LlmFormat } from "$lib/store";
  import { readNum } from "$lib/utils";

  // config 来自 store 的 provider 对象（含 format/baseUrl/apiKey/model）。
  let {
    config = $bindable(),
    persist,
  }: {
    config: Record<string, any>;
    persist: (note?: string) => void;
  } = $props();

  let showKey = $state(false);
  let fetching = $state(false);
  let fetchError = $state("");
  let models = $state<{ id: string }[]>([]);
  let modelDropdown = $state(false); // 自定义模型下拉（避开 datalist 按输入文本过滤的坑）

  const FORMATS: { value: LlmFormat; label: string; hint: string }[] = [
    { value: "openai-chat", label: "OpenAI Chat Completions", hint: "POST /chat/completions（最通用）" },
    { value: "openai-responses", label: "OpenAI Responses", hint: "POST /responses（新版 API）" },
    { value: "claude", label: "Claude Messages", hint: "POST /v1/messages（Anthropic）" },
  ];

  // 是否 OpenAI 系（有 /models 端点，可拉模型）
  let isOpenAI = $derived(config.format !== "claude");

  async function loadModels() {
    fetchError = "";
    if (!config.baseUrl) {
      fetchError = "请先填 Base URL";
      return;
    }
    fetching = true;
    models = [];
    try {
      models = await fetchModels(config.baseUrl, config.apiKey);
      if (models.length === 0) fetchError = "未返回任何模型";
      else modelDropdown = true; // 拉取成功自动展开列表
    } catch (e: any) {
      fetchError = e?.message ?? String(e);
    } finally {
      fetching = false;
    }
  }

  /** 选一个模型：写入并收起下拉。 */
  function pickModel(id: string) {
    config.model = id;
    modelDropdown = false;
    persist();
  }

  /** 确保 config.genParams 存在（老配置可能没有），返回可写引用。 */
  function ensureGP(): Record<string, number | null> {
    if (!config.genParams) config.genParams = { temperature: null, topP: null, maxTokens: null, frequencyPenalty: null };
    return config.genParams;
  }
</script>

<label class="field">
  <span>端点格式</span>
  <select
    value={config.format ?? "openai-chat"}
    onchange={(e) => {
      config.format = (e.currentTarget as HTMLSelectElement).value;
      models = [];
      fetchError = "";
      persist("已切换格式");
    }}
  >
    {#each FORMATS as f}
      <option value={f.value}>{f.label}</option>
    {/each}
  </select>
</label>
<p class="hint line">
  {FORMATS.find((f) => f.value === (config.format ?? "openai-chat"))?.hint}
</p>

<label class="field">
  <span>API Base URL</span>
  <input
    type="text"
    bind:value={config.baseUrl}
    onblur={() => persist()}
    placeholder={config.format === "claude" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
  />
</label>

<label class="field">
  <span>API Key</span>
  <div class="key-wrap">
    <input
      type={showKey ? "text" : "password"}
      bind:value={config.apiKey}
      onblur={() => persist()}
      placeholder={config.format === "claude" ? "sk-ant-..." : "sk-..."}
      autocomplete="off"
      spellcheck="false"
    />
    <button
      type="button"
      class="eye"
      title={showKey ? "隐藏" : "显示"}
      onclick={() => (showKey = !showKey)}>{showKey ? "隐藏" : "显示"}</button>
  </div>
</label>

<label class="field">
  <span>模型</span>
  <div class="model-wrap">
    <input
      type="text"
      bind:value={config.model}
      onblur={() => persist()}
      placeholder={config.format === "claude" ? "claude-3-5-haiku-latest" : "gpt-4o-mini"}
    />
    {#if models.length > 0}
      <button
        type="button"
        class="fetch dropdown-toggle"
        onclick={() => (modelDropdown = !modelDropdown)}
        title="已拉取 {models.length} 个模型，点击选择"
      >▾</button>
    {/if}
    {#if isOpenAI}
      <button
        type="button"
        class="fetch"
        onclick={loadModels}
        disabled={fetching}
        title="从服务端拉取可用模型">{fetching ? "…" : "↻"}</button
      >
    {/if}

    {#if modelDropdown && models.length > 0}
      <!-- 点击外部关闭：全屏透明遮罩（替代 svelte:window，避免位置/重复限制） -->
      <button
        class="dropdown-backdrop"
        onclick={() => (modelDropdown = false)}
        aria-label="关闭"
      ></button>
      <div class="model-dropdown">
        {#each models as m (m.id)}
          <button
            type="button"
            class="model-opt"
            class:active={m.id === config.model}
            onclick={() => pickModel(m.id)}
            title={m.id}
          >
            <span>{m.id}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</label>
{#if fetchError}
  <p class="err">模型拉取失败：{fetchError}</p>
{:else if models.length > 0}
  <p class="ok">已拉取 {models.length} 个模型，点 ▾ 选择</p>
{/if}

<!-- 生成参数（温度等）：留空=用各模型默认值。仅此 provider 生效。
     默认折叠（details），点击 summary 展开。 -->
<details class="gen-details">
  <summary>高级参数</summary>
  <div class="gen-grid">
    <label class="field">
      <span>温度</span>
      <input
        class="num"
        type="number"
        min="0"
        max="2"
        step="0.1"
        value={config.genParams?.temperature ?? ""}
        oninput={(e) => { ensureGP().temperature = readNum(e); persist(); }}
        onblur={() => persist()}
        placeholder="默认"
      />
    </label>
    <label class="field">
      <span>Top P</span>
      <input
        class="num"
        type="number"
        min="0"
        max="1"
        step="0.05"
        value={config.genParams?.topP ?? ""}
        oninput={(e) => { ensureGP().topP = readNum(e); persist(); }}
        onblur={() => persist()}
        placeholder="默认"
      />
    </label>
    <label class="field">
      <span>最大 Token</span>
      <input
        class="num"
        type="number"
        min="1"
        max="32768"
        step="1"
        value={config.genParams?.maxTokens ?? ""}
        oninput={(e) => { ensureGP().maxTokens = readNum(e); persist(); }}
        onblur={() => persist()}
        placeholder="默认"
      />
    </label>
    <label class="field">
      <span>重复惩罚</span>
      <input
        class="num"
        type="number"
        min="0"
        max="2"
        step="0.1"
        value={config.genParams?.frequencyPenalty ?? ""}
        oninput={(e) => { ensureGP().frequencyPenalty = readNum(e); persist(); }}
        onblur={() => persist()}
        placeholder="默认"
      />
    </label>
  </div>
</details>

<style>
  /* .field / .field span / .field input 已抽到全局 app.css */
  .hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: -6px 0 14px 122px;
  }
  /* number input：与 text input 一样在 .field 里撑满（app.css 只给 text/password 加了 flex） */
  .num {
    flex: 1;
    width: auto;
  }
  /* 高级参数折叠块：默认收起，点击 summary 展开。 */
  .gen-details {
    margin: 4px 0 14px;
  }
  .gen-details > summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--text-muted);
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-soft);
    list-style: none;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.12s ease, border-color 0.12s ease;
  }
  .gen-details > summary:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  /* 自定义三角标记（替代默认的 disclosure triangle） */
  .gen-details > summary::-webkit-details-marker {
    display: none;
  }
  .gen-details > summary::before {
    content: "▸";
    display: inline-block;
    margin-right: 6px;
    transition: transform 0.15s ease;
  }
  .gen-details[open] > summary::before {
    transform: rotate(90deg);
  }
  .gen-details[open] > summary {
    margin-bottom: 10px;
  }
  /* 4 个参数字段排成 2 列网格 */
  .gen-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 16px;
  }
  .gen-grid .field {
    margin-bottom: 0;
    gap: 8px;
  }
  .gen-grid .field > span {
    width: auto;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .key-wrap,
  .model-wrap {
    flex: 1;
    display: flex;
    gap: 6px;
    align-items: center;
    position: relative; /* 供模型下拉列表定位 */
  }
  .eye,
  .fetch {
    flex-shrink: 0;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--border);
    background: var(--bg-soft);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1;
    color: var(--text-muted);
  }
  .fetch {
    width: 34px;
    padding: 0;
    font-size: 14px;
  }
  .eye:hover,
  .fetch:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .fetch:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .err {
    color: var(--danger);
    font-size: 12px;
    margin: -6px 0 12px 122px;
  }
  .ok {
    color: var(--accent);
    font-size: 12px;
    margin: -6px 0 12px 122px;
  }
  /* 自定义模型下拉列表（避开 datalist 按输入文本过滤的坑） */
  .model-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 50;
    min-width: 240px;
    max-width: 360px;
    max-height: 260px;
    overflow-y: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  /* 点击外部关闭用的全屏透明遮罩 */
  .dropdown-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }
  .model-opt {
    display: flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: transparent;
    color: var(--text);
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model-opt:hover {
    background: var(--accent-soft);
  }
  .model-opt.active {
    color: var(--accent);
    font-weight: 600;
  }
</style>
