<script lang="ts">
  /**
   * 设置面板。
   *
   * 左侧导航：通用 / 快捷键 / 引擎 / 动作 / 关于
   * - 引擎页：选引擎类型（LLM/DeepLx/Google），LLM 下管理多个提供商；
   *   通用页：思考开关、目标语言、触发方式；
   * - 动作页：每个动作开关 + 自定义提示词（留空用内置）。
   * 配置改完即时保存；快捷键变更同步到 Rust 即时生效。
   */
  import { onMount } from "svelte";
  import {
    loadConfig,
    saveConfigWithSideEffects,
    defaultConfig,
    normalizeGenParams,
    type AppConfig,
  } from "$lib/store";
  import { applyThemeEverywhere } from "$lib/theme";
  import { fetchModels } from "$lib/models";
  import { ACTIONS } from "$lib/actions";
  import { LANGUAGES } from "$lib/lang";
  import { readNum } from "$lib/utils";
  import Providers from "$components/Providers.svelte";

  let cfg = $state<AppConfig>(defaultConfig());
  let activePage = $state<"general" | "hotkey" | "engine" | "actions" | "history" | "about">("general");
  let savedFlash = $state("");
  let ready = $state(false);
  let capturing = $state(false);
  let prevHotkey = "";

  // 历史记录
  import { getQuick, clearQuick, getChats, deleteChat, type QuickRecord, type ChatRecord } from "$lib/history";
  let quickRecords = $state<QuickRecord[]>([]);
  let chatRecords = $state<ChatRecord[]>([]);
  let historyTab = $state<"quick" | "chat">("quick");
  let expandedRecs = $state<Record<string, boolean>>({});

  async function loadHistory() {
    quickRecords = await getQuick();
    chatRecords = await getChats();
  }

  function toggleRec(id: string) {
    expandedRecs = { ...expandedRecs, [id]: !expandedRecs[id] };
  }

  /** 时间戳 → 简短显示。 */
  function formatTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return `${hh}:${mm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  }

  onMount(async () => {
    cfg = await loadConfig();
    prevHotkey = cfg.hotkey;
    ready = true;
  });

  async function persist(note = "已保存") {
    // 归一生成参数（per-provider）：number input 清空会成 NaN，落库前统一转 null
    cfg.providers = cfg.providers.map((p) => ({
      ...p,
      genParams: normalizeGenParams(p.genParams ?? { temperature: null, topP: null, maxTokens: null, frequencyPenalty: null }),
    }));
    cfg.ocrProvider.genParams = normalizeGenParams(
      cfg.ocrProvider.genParams ?? { temperature: null, topP: null, maxTokens: null, frequencyPenalty: null },
    );
    // 主题即时生效 + 广播给所有窗口
    await applyThemeEverywhere(cfg.theme);
    const res = await saveConfigWithSideEffects(cfg, prevHotkey);
    prevHotkey = cfg.hotkey;
    if (res.hotkeyError) {
      savedFlash = "快捷键无效: " + res.hotkeyError;
    } else {
      savedFlash = note;
    }
    setTimeout(() => (savedFlash = ""), 1500);
  }

  /** 确保 ocrProvider.genParams 存在（老配置可能没有），返回可写引用。 */
  function ensureOcrGP() {
    if (!cfg.ocrProvider.genParams) {
      cfg.ocrProvider.genParams = { temperature: null, topP: null, maxTokens: null, frequencyPenalty: null };
    }
    return cfg.ocrProvider.genParams;
  }

  /** 快捷键捕获：拼装成 "Mod+Key" 字符串。captureTarget 决定写哪个字段。 */
  let captureTarget = $state<"hotkey" | "ocrHotkey">("hotkey");
  function startCapture(target: "hotkey" | "ocrHotkey" = "hotkey") {
    captureTarget = target;
    capturing = true;
  }
  function onCaptureKey(e: KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Super");
    let key = e.key;
    if (key.length === 1) key = key.toUpperCase();
    if (mods.length === 0) {
      savedFlash = "需至少一个修饰键";
      setTimeout(() => (savedFlash = ""), 1500);
      return;
    }
    const combo = [...mods, key].join("+");
    if (captureTarget === "ocrHotkey") {
      cfg.ocrHotkey = combo;
    } else {
      cfg.hotkey = combo;
    }
    capturing = false;
    persist("快捷键已设置");
  }
  function resetHotkey() {
    cfg.hotkey = "Alt+D";
    persist("已重置");
  }
  function resetOcrHotkey() {
    cfg.ocrHotkey = "Alt+S";
    persist("已重置");
  }

  // OCR 模型拉取：Ollama 原生走 /api/tags，…/v1 走 /models
  let ocrModels = $state<{ id: string }[]>([]);
  let ocrModelsLoading = $state(false);
  let ocrModelsError = $state("");
  let ocrModelDropdown = $state(false); // 自定义下拉（避开 datalist 按输入文本过滤的坑）
  async function loadOcrModels() {
    if (!cfg.ocrProvider.baseUrl) {
      ocrModelsError = "请先填 Base URL";
      return;
    }
    ocrModelsLoading = true;
    ocrModelsError = "";
    try {
      ocrModels = await fetchModels(cfg.ocrProvider.baseUrl, cfg.ocrProvider.apiKey);
      if (ocrModels.length === 0) ocrModelsError = "未返回任何模型";
      else ocrModelDropdown = true; // 拉取成功自动展开
    } catch (e: any) {
      ocrModels = [];
      ocrModelsError = e?.message ?? String(e);
    } finally {
      ocrModelsLoading = false;
    }
  }

  /** 选一个 OCR 模型：写入并收起下拉。 */
  function pickOcrModel(id: string) {
    cfg.ocrProvider.model = id;
    ocrModelDropdown = false;
    persist();
  }

  const ENGINE_OPTIONS = [
    { key: "llm", name: "LLM 提供商（翻译/总结/润色/解释/提问）" },
    { key: "deeplx", name: "DeepLx（仅翻译，免 key）" },
    { key: "google", name: "Google（仅翻译，免 key）" },
  ];
</script>

<svelte:window onkeydown={onCaptureKey} />

<div class="config">
  <nav class="sidebar">
    <div class="brand">
      <span class="brand-name">Swiper</span>
    </div>
    <div class="nav-items">
      <button class:active={activePage === "general"} onclick={() => (activePage = "general")}>通用</button>
      <button class:active={activePage === "hotkey"} onclick={() => (activePage = "hotkey")}>快捷键</button>
      <button class:active={activePage === "engine"} onclick={() => (activePage = "engine")}>引擎</button>
      <button class:active={activePage === "actions"} onclick={() => (activePage = "actions")}>动作</button>
      <button class:active={activePage === "history"} onclick={() => { activePage = "history"; loadHistory(); }}>历史</button>
      <button class:active={activePage === "about"} onclick={() => (activePage = "about")}>关于</button>
    </div>
    <div class="nav-foot">v{__APP_VERSION__}</div>
  </nav>

  <main>
    {#if !ready}
      <p class="muted">加载中…</p>
    {:else if activePage === "general"}
      <div class="page-head"><h2>通用</h2></div>

      <section class="card">
        <h3 class="card-title">外观</h3>
        <label class="field">
          <span>主题</span>
          <select bind:value={cfg.theme} onchange={() => persist()}>
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
      </section>

      <section class="card">
        <h3 class="card-title">行为</h3>
        <label class="field">
          <span>触发方式</span>
          <select bind:value={cfg.showActionMenu} onchange={() => persist()}>
            <option value={true}>先弹动作菜单</option>
            <option value={false}>直接执行默认动作</option>
          </select>
        </label>
        {#if !cfg.showActionMenu}
          <label class="field">
            <span>默认动作</span>
            <select bind:value={cfg.defaultAction} onchange={() => persist()}>
              {#each ACTIONS as a}
                <option value={a.key}>{a.icon} {a.name}</option>
              {/each}
            </select>
          </label>
        {/if}
        <label class="field">
          <span>目标语言</span>
          <select bind:value={cfg.targetLang} onchange={() => persist()}>
            {#each LANGUAGES as l}
              <option value={l.code}>{l.name}</option>
            {/each}
          </select>
        </label>
      </section>

      <section class="card">
        <h3 class="card-title">高级</h3>
        <div class="switch-row">
          <span class="switch-label">
            <span class="t">显示思维链</span>
            <span class="d">结果中显示模型的推理过程</span>
          </span>
          <input class="switch" type="checkbox" role="switch" bind:checked={cfg.enableThinking} onchange={() => persist()} />
        </div>
        <div class="switch-row">
          <span class="switch-label">
            <span class="t">开机自启</span>
            <span class="d">登录系统时自动启动</span>
          </span>
          <input class="switch" type="checkbox" role="switch" bind:checked={cfg.autoStart} onchange={() => persist()} />
        </div>
      </section>

    {:else if activePage === "hotkey"}
      <div class="page-head"><h2>快捷键</h2></div>

      <section class="card">
        <h3 class="card-title">划词翻译</h3>
        <p class="card-desc">选中文字后按下组合键，召唤动作菜单或直接翻译。</p>
        <div class="hk-row">
          <button
            type="button"
            class="hotkey-display"
            class:capturing={capturing && captureTarget === "hotkey"}
            onclick={() => startCapture("hotkey")}
          >
            {#if capturing && captureTarget === "hotkey"}
              按下组合键…
            {:else}
              <kbd>{cfg.hotkey}</kbd>
            {/if}
          </button>
          <button class="btn-ghost" onclick={() => startCapture("hotkey")} disabled={capturing}>重新设置</button>
          <button class="btn-ghost" onclick={resetHotkey}>恢复默认</button>
        </div>
      </section>

      <section class="card">
        <h3 class="card-title">OCR 截图识别</h3>
        <p class="card-desc">按下组合键进入截图，识别屏幕文字。</p>
        <div class="hk-row">
          <button
            type="button"
            class="hotkey-display"
            class:capturing={capturing && captureTarget === "ocrHotkey"}
            onclick={() => startCapture("ocrHotkey")}
          >
            {#if capturing && captureTarget === "ocrHotkey"}
              按下组合键…
            {:else}
              <kbd>{cfg.ocrHotkey}</kbd>
            {/if}
          </button>
          <button class="btn-ghost" onclick={() => startCapture("ocrHotkey")} disabled={capturing}>重新设置</button>
          <button class="btn-ghost" onclick={resetOcrHotkey}>恢复默认</button>
        </div>
      </section>

      <p class="hint">提示：需至少一个修饰键 (Ctrl/Alt/Shift/Win) + 一个普通键，避免与系统占用冲突。</p>

    {:else if activePage === "engine"}
      <div class="page-head"><h2>引擎</h2></div>

      <section class="card">
        <h3 class="card-title">翻译引擎</h3>
        <label class="field">
          <span>引擎类型</span>
          <select bind:value={cfg.activeEngine} onchange={() => persist()}>
            {#each ENGINE_OPTIONS as o}
              <option value={o.key}>{o.name}</option>
            {/each}
          </select>
        </label>
      </section>

      {#if cfg.activeEngine === "llm"}
        <section class="card">
          <h3 class="card-title">LLM 提供商</h3>
          <p class="card-desc">添加多个提供商，点选一个为默认（翻译 / 总结 / 润色 / 解释 / 提问共用）。</p>
          <Providers
            bind:providers={cfg.providers}
            bind:activeProviderId={cfg.activeProviderId}
            {persist}
          />
        </section>
      {:else if cfg.activeEngine === "deeplx"}
        <section class="card">
          <h3 class="card-title">DeepLx</h3>
          <label class="field">
            <span>端点</span>
            <input
              type="text"
              bind:value={cfg.deeplx.endpoint}
              onblur={() => persist()}
              placeholder="http://localhost:1188/translate"
            />
          </label>
          <p class="card-desc">DeepLx 仅支持「翻译」动作，无需 API Key。</p>
        </section>
      {:else if cfg.activeEngine === "google"}
        <section class="card">
          <h3 class="card-title">Google</h3>
          <label class="field">
            <span>端点</span>
            <input
              type="text"
              bind:value={cfg.google.endpoint}
              onblur={() => persist()}
              placeholder="https://translate.googleapis.com/translate_a/single"
            />
          </label>
          <p class="card-desc">Google 仅支持「翻译」动作，无需 API Key。</p>
        </section>
      {/if}

      <!-- OCR 引擎配置 -->
      <section class="card">
        <h3 class="card-title">OCR 截图识别</h3>
        <label class="field">
          <span>OCR 引擎</span>
          <select bind:value={cfg.ocrEngine} onchange={() => persist()}>
            <option value="system">Windows 系统 OCR</option>
            <option value="llm">LLM 视觉 OCR</option>
          </select>
        </label>

        {#if cfg.ocrEngine === "llm"}
          <label class="field">
            <span>Base URL</span>
            <input
              type="text"
              bind:value={cfg.ocrProvider.baseUrl}
              onblur={() => persist()}
              placeholder="http://localhost:11434 或 https://api.openai.com/v1"
            />
          </label>
          <label class="field">
            <span>API Key</span>
            <input
              type="password"
              bind:value={cfg.ocrProvider.apiKey}
              onblur={() => persist()}
              placeholder="（Ollama 本地通常留空；云端必填）"
            />
          </label>
          <label class="field">
            <span>视觉模型</span>
            <div class="model-wrap">
              <input
                type="text"
                bind:value={cfg.ocrProvider.model}
                onblur={() => persist()}
                placeholder="qwen-vl-max"
              />
              {#if ocrModels.length > 0}
                <button
                  type="button"
                  class="fetch dropdown-toggle"
                  onclick={() => (ocrModelDropdown = !ocrModelDropdown)}
                  title="已拉取 {ocrModels.length} 个模型，点击选择"
                >▾</button>
              {/if}
              <button
                type="button"
                class="fetch"
                onclick={loadOcrModels}
                disabled={ocrModelsLoading}
                title="从 Ollama 拉取模型列表">{ocrModelsLoading ? "…" : "↻"}</button
              >

              {#if ocrModelDropdown && ocrModels.length > 0}
                <button
                  class="dropdown-backdrop"
                  onclick={() => (ocrModelDropdown = false)}
                  aria-label="关闭"
                ></button>
                <div class="model-dropdown">
                  {#each ocrModels as m (m.id)}
                    <button
                      type="button"
                      class="model-opt"
                      class:active={m.id === cfg.ocrProvider.model}
                      onclick={() => pickOcrModel(m.id)}
                      title={m.id}
                    >
                      <span>{m.id}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </label>
          {#if ocrModelsError}
            <p class="err field-msg">模型拉取失败：{ocrModelsError}</p>
          {:else if ocrModels.length > 0}
            <p class="ok field-msg">已拉取 {ocrModels.length} 个模型，点 ▾ 选择</p>
          {/if}
          <!-- 识别提示词：通用多模态模型需要明确指令才会转录而非描述图片；
              专用 OCR 模型可清空（纯透传图片精度更高）。默认值预填，清空即关闭。 -->
          <label class="prompt-field">
            <span class="prompt-label">识别提示词</span>
            <textarea
              class="prompt"
              bind:value={cfg.ocrProvider.ocrPrompt}
              onblur={() => persist()}
              rows="3"
              placeholder="清空则纯透传图片（专用 OCR 模型推荐）"
            ></textarea>
          </label>
          <p class="card-desc">通用多模态模型(Qwen-VL等)建议保留；专用 OCR 模型(glm-ocr等)可清空。</p>
          <!-- OCR 生成参数：留空=用模型默认值。仅 OCR provider 生效。默认折叠。 -->
          <details class="gen-details">
            <summary>高级参数</summary>
            <div class="gen-params">
              <label class="field">
                <span>温度</span>
                <input
                  class="num"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={cfg.ocrProvider.genParams?.temperature ?? ""}
                  oninput={(e) => { ensureOcrGP().temperature = readNum(e); persist(); }}
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
                  value={cfg.ocrProvider.genParams?.topP ?? ""}
                  oninput={(e) => { ensureOcrGP().topP = readNum(e); persist(); }}
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
                  value={cfg.ocrProvider.genParams?.maxTokens ?? ""}
                  oninput={(e) => { ensureOcrGP().maxTokens = readNum(e); persist(); }}
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
                  value={cfg.ocrProvider.genParams?.frequencyPenalty ?? ""}
                  oninput={(e) => { ensureOcrGP().frequencyPenalty = readNum(e); persist(); }}
                  placeholder="默认"
                />
              </label>
            </div>
            <p class="card-desc">OCR 复读时可调低温度或加重复惩罚。</p>
          </details>
        {/if}
      </section>

    {:else if activePage === "actions"}
      <div class="page-head"><h2>动作</h2></div>
      <p class="card-desc-out">勾选启用；可自定义提示词（留空用内置默认，支持 {`{targetLang}`} 占位符）。</p>
      {#each ACTIONS as a (a.key)}
        <section class="card action-card" class:enabled={cfg.actions[a.key].enabled}>
          <div class="action-head">
            <span class="aico">{a.icon}</span>
            <div class="ameta">
              <span class="aname">{a.name}</span>
              <span class="adesc">
                {#if a.key === "translate"}翻译到目标语言{:else if a.key === "summarize"}提取要点{:else if a.key === "polish"}优化文笔{:else if a.key === "explain"}解释含义{:else if a.key === "chat"}多轮对话提问{:else if a.key === "ocr"}截图识别文字{/if}
              </span>
            </div>
            <input
              class="switch"
              type="checkbox"
              role="switch"
              bind:checked={cfg.actions[a.key].enabled}
              onchange={() => persist()}
            />
          </div>
          <textarea
            class="prompt"
            bind:value={cfg.actions[a.key].customPrompt}
            onblur={() => persist()}
            rows="2"
            placeholder={"自定义提示词（留空用内置默认）"}
          ></textarea>
        </section>
      {/each}

    {:else if activePage === "history"}
      <div class="page-head"><h2>历史记录</h2></div>
      <div class="hist-tabs">
        <button class="hist-tab" class:active={historyTab === "quick"} onclick={() => (historyTab = "quick")}>划词结果</button>
        <button class="hist-tab" class:active={historyTab === "chat"} onclick={() => (historyTab = "chat")}>对话</button>
        {#if historyTab === "quick" && quickRecords.length}
          <button class="hist-clear" onclick={async () => { await clearQuick(); quickRecords = []; }}>清空</button>
        {/if}
      </div>

      {#if historyTab === "quick"}
        {#if quickRecords.length === 0}
          <p class="muted">暂无记录</p>
        {:else}
          <div class="hist-list">
            {#each quickRecords as r (r.id)}
              <div class="hist-item" class:expanded={expandedRecs[r.id]}>
                <div class="hist-head">
                  <span class="hist-act">{r.action}</span>
                  <span class="hist-time">{formatTime(r.ts)}</span>
                  <button class="hist-toggle" onclick={() => toggleRec(r.id)}>
                    {expandedRecs[r.id] ? "收起" : "展开"}
                  </button>
                </div>
                <div class="hist-src">{r.source}</div>
                <div class="hist-tgt">{r.target}</div>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        {#if chatRecords.length === 0}
          <p class="muted">暂无对话</p>
        {:else}
          <div class="hist-list">
            {#each chatRecords as c (c.id)}
              <div class="hist-item chat">
                <div class="chat-head">
                  <span class="chat-title">{c.title}</span>
                  <button class="hist-del" onclick={async () => { await deleteChat(c.id); chatRecords = await getChats(); }}>删除</button>
                </div>
                <span class="muted small">{c.messages.filter((m) => m.role !== "system").length} 条消息</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}

    {:else}
      <div class="page-head"><h2>关于</h2></div>
      <section class="card about">
        <div class="about-name">Swiper</div>
        <div class="about-sub">极简划词 AI 助手 · v{__APP_VERSION__}</div>
        <p class="about-line">选中文字，按 <kbd>{cfg.hotkey}</kbd> 召唤。</p>
        <div class="about-feats">
          <span>翻译</span><i>·</i><span>总结</span><i>·</i><span>润色</span><i>·</i><span>解释</span><i>·</i><span>提问</span>
        </div>
      </section>
    {/if}

    {#if savedFlash}<span class="flash">{savedFlash}</span>{/if}
  </main>
</div>

<style>
  .config {
    display: flex;
    height: 100vh;
    background: var(--bg);
  }

  /* ---------- 侧边导航 ---------- */
  .sidebar {
    width: 120px;
    flex-shrink: 0;
    background: var(--bg-soft);
    border-right: 1px solid var(--border);
    padding: 18px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .brand {
    padding: 0 8px 14px;
  }
  .brand-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .nav-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .nav-items button {
    text-align: left;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 7px;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .nav-items button:hover {
    background: var(--accent-soft);
    color: var(--text);
  }
  .nav-items button.active {
    background: var(--accent);
    color: #fff;
  }
  .nav-foot {
    margin-top: auto;
    padding: 8px 10px 0;
    font-size: 11px;
    color: var(--text-muted);
    opacity: 0.6;
  }

  /* ---------- 主内容区 ---------- */
  main {
    flex: 1;
    padding: 24px 28px;
    overflow-y: auto;
    position: relative;
  }
  .page-head {
    margin-bottom: 18px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }
  .page-head h2 {
    margin: 0;
    font-size: 18px;
  }
  /* 卡片标题在 Config 内不放最上面间距 */
  .card-title {
    margin-top: 0;
  }
  .card-desc-out {
    color: var(--text-muted);
    font-size: 12px;
    margin: -8px 0 14px;
  }
  /* 模型下拉用 input 区块里的内联提示 */
  .field-msg {
    margin: -2px 0 0 122px;
  }

  kbd {
    background: var(--bg-soft);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
    font-family: ui-monospace, monospace;
    font-size: 13px;
  }

  /* ---------- 模型拉取下拉（OCR 引擎页） ---------- */
  .model-wrap {
    flex: 1;
    display: flex;
    gap: 6px;
    align-items: center;
    position: relative;
  }
  .fetch {
    flex-shrink: 0;
    width: 34px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 8px;
    font-size: 14px;
    line-height: 1;
  }
  .fetch:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .fetch:disabled {
    opacity: 0.5;
    cursor: wait;
  }
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

  .err {
    color: var(--danger);
    font-size: 12px;
  }
  .ok {
    color: var(--accent);
    font-size: 12px;
  }
  .muted {
    color: var(--text-muted);
    font-size: 13px;
  }

  /* ---------- 快捷键页 ---------- */
  .hotkey-display {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 170px;
    height: 44px;
    padding: 0 16px;
    background: var(--bg);
    border: 2px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    color: var(--text);
    transition: border-color 0.15s;
    font-family: inherit;
  }
  .hotkey-display:hover {
    border-color: var(--accent);
  }
  .hotkey-display.capturing {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .hotkey-display kbd {
    background: transparent;
    border: none;
    font-size: 16px;
    padding: 0;
  }
  .hk-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hint {
    font-size: 12px;
    color: var(--text-muted);
    margin: 10px 0 0;
  }

  /* ---------- 动作页 ---------- */
  .action-card {
    transition: border-color 0.15s ease;
  }
  .action-card.enabled {
    border-color: var(--accent);
  }
  .action-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .aico {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    border-radius: 8px;
    color: var(--accent);
    font-size: 14px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .ameta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  .aname {
    font-size: 14px;
    font-weight: 500;
  }
  .adesc {
    font-size: 12px;
    color: var(--text-muted);
  }
  .prompt {
    width: 100%;
    font-size: 12px;
    resize: vertical;
    font-family: ui-monospace, monospace;
    background: var(--bg);
  }
  /* OCR 识别提示词字段：label 在上、textarea 在下（多行不用 .field 的居中行布局） */
  .prompt-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .prompt-label {
    font-size: 13px;
    color: var(--text-muted);
  }
  /* 生成参数：4 个 number 字段排成 2 列网格，紧凑 */
  .gen-params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 16px;
    /* 外边距交由 .gen-details 控制 */
  }
  /* 窄标签（覆盖 .field 的 110px span）+ input 不撑满 */
  .gen-params .field {
    margin-bottom: 0;
    gap: 8px;
  }
  .gen-params .field > span {
    width: auto;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gen-params .num {
    flex: 1;
    width: auto;
  }
  /* 高级参数折叠块（OCR 区），默认收起 */
  .gen-details {
    margin: 6px 0;
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

  /* ---------- 关于页 ---------- */
  .about {
    max-width: 420px;
  }
  .about-name {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .about-sub {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 14px;
  }
  .about-line {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 10px;
  }
  .about-feats {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text);
    margin-bottom: 12px;
  }
  .about-feats i {
    color: var(--text-muted);
    font-style: normal;
  }


  /* ---------- 保存提示 ---------- */
  .flash {
    position: absolute;
    bottom: 16px;
    right: 24px;
    background: var(--accent);
    color: #fff;
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    box-shadow: var(--shadow);
  }

  /* ---------- 历史记录 ---------- */
  .hist-tabs {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 14px;
  }
  .hist-tab {
    font-size: 13px;
    padding: 5px 14px;
    border: 1px solid var(--border);
    background: var(--bg-soft);
    border-radius: 14px;
    color: var(--text-muted);
  }
  .hist-tab.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .hist-clear {
    margin-left: auto;
    font-size: 12px;
    border: none;
    background: transparent;
    color: var(--danger);
  }
  .hist-clear:hover {
    text-decoration: underline;
  }
  .hist-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hist-item {
    padding: 10px 12px;
    background: var(--bg-soft);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .hist-item.expanded {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .hist-act {
    font-size: 11px;
    color: var(--accent);
    font-weight: 600;
  }
  .hist-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hist-time {
    font-size: 11px;
    color: var(--text-muted);
    opacity: 0.7;
  }
  .hist-toggle {
    margin-left: auto;
    font-size: 11px;
    border: none;
    background: transparent;
    color: var(--accent);
    padding: 0;
  }
  .hist-toggle:hover {
    text-decoration: underline;
  }
  .hist-src {
    color: var(--text-muted);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hist-item.expanded .hist-src {
    white-space: pre-wrap;
    overflow: visible;
    text-overflow: clip;
  }
  .hist-tgt {
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 3.6em;
    overflow: hidden;
    position: relative;
  }
  .hist-item.expanded .hist-tgt {
    max-height: none;
    overflow: visible;
  }
  .hist-item.chat .chat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .chat-title {
    font-weight: 500;
  }
  .hist-del {
    font-size: 11px;
    border: none;
    background: transparent;
    color: var(--danger);
  }
</style>
