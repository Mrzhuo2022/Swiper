<script lang="ts">
  /**
   * LLM 提供商管理（可增删改多份）。
   *
   * - 顶部选择当前默认 provider（radio）；
   * - 列表里每个 provider 可编辑（名字/BaseURL/Key/模型，复用 OpenAISettings）；
   * - 可新增、删除。
   */
  import OpenAISettings from "./OpenAISettings.svelte";
  import { emptyGenParams, type LlmProvider } from "$lib/store";
  import { genId } from "$lib/utils";

  let {
    providers = $bindable(),
    activeProviderId = $bindable(),
    persist,
  }: {
    providers: LlmProvider[];
    activeProviderId: string;
    persist: (note?: string) => void;
  } = $props();

  let editingId = $state("");

  // 默认编辑第一个
  $effect(() => {
    if (!editingId && providers.length) editingId = providers[0].id;
  });

  let editing = $derived(providers.find((p) => p.id === editingId) ?? providers[0] ?? null);

  function addProvider() {
    const p: LlmProvider = {
      id: genId(),
      name: "新提供商",
      format: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      genParams: emptyGenParams(),
    };
    providers = [...providers, p];
    editingId = p.id;
    persist("已添加");
  }

  function removeProvider(id: string) {
    if (providers.length <= 1) {
      persist("至少保留一个");
      return;
    }
    const idx = providers.findIndex((p) => p.id === id);
    providers = providers.filter((p) => p.id !== id);
    if (activeProviderId === id) activeProviderId = providers[0].id;
    if (editingId === id) editingId = providers[0].id;
    persist("已删除");
  }

  function setActive(id: string) {
    activeProviderId = id;
    persist("已设为默认");
  }
</script>

<div class="providers">
  <!-- provider 列表 + 增删 -->
  <div class="list">
    {#each providers as p (p.id)}
      <div class="item" class:active={p.id === activeProviderId} class:editing={p.id === editingId}>
        <label class="radio">
          <input
            type="radio"
            name="active-provider"
            checked={p.id === activeProviderId}
            onchange={() => setActive(p.id)}
          />
        </label>
        <button class="name" onclick={() => (editingId = p.id)} title="点击编辑">
          {p.name || "(未命名)"}
          <span class="sub">{p.model}</span>
        </button>
        <button
          class="del"
          title="删除"
          onclick={() => removeProvider(p.id)}
          disabled={providers.length <= 1}>✕</button
        >
      </div>
    {/each}
    <button class="add" onclick={addProvider}>+ 添加提供商</button>
  </div>

  <!-- 当前编辑的 provider 表单 -->
  {#if editing}
    <div class="edit">
      <label class="field">
        <span>名称</span>
        <input type="text" bind:value={editing.name} onblur={() => persist()} placeholder="如 OpenAI / DeepSeek" />
      </label>
      <OpenAISettings bind:config={editing} {persist} />
    </div>
  {/if}
</div>

<style>
  .providers {
    display: flex;
    gap: 16px;
  }
  .list {
    width: 150px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-radius: 8px;
    border: 1px solid transparent;
  }
  .item.editing {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .radio input {
    width: auto;
    margin: 0;
  }
  .name {
    flex: 1;
    min-width: 0;
    text-align: left;
    border: none;
    background: transparent;
    padding: 4px 6px;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name :global(span) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name:hover {
    background: var(--bg-soft);
  }
  .sub {
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .del {
    border: none;
    background: transparent;
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 12px;
    flex-shrink: 0;
  }
  .del:hover:not(:disabled) {
    background: var(--danger);
    color: #fff;
  }
  .del:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .add {
    margin-top: 4px;
    border: 1px dashed var(--border);
    background: transparent;
    color: var(--accent);
    padding: 6px;
    border-radius: 8px;
    font-size: 12px;
  }
  .add:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .edit {
    flex: 1;
    /* 允许 flex 子项收缩，防止内部 .field 的长 label/input 撑破卡片宽度 */
    min-width: 0;
  }
  /* Providers 嵌在卡片里，可用宽度窄；把字段 label 收窄，input 才放得下 */
  .edit :global(.field) {
    flex-wrap: wrap;
  }
  .edit :global(.field > span) {
    width: 84px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 模型拉取的内联提示/错误缩进也跟着收窄的 label 对齐 */
  .edit :global(.hint),
  .edit :global(.err),
  .edit :global(.ok) {
    margin-left: 96px;
  }
</style>
