# Swiper · 极简划词 AI 助手

极简 Windows 划词助手。选中文字一键召唤，**翻译 / 总结 / 润色 / 解释 / 提问**五种动作，截图 **OCR 识别**，统一以 LLM 为核心。**性能优先、占用极低、无臃肿功能**，避开 Electron 的体积与内存开销。

- **技术栈**：Tauri 2 + Svelte 5 + Rust
- **目标**：安装包 < 10 MB；常驻内存极低
- **平台**：Windows 10 / 11 (x64)

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18+（推荐 20/22）
- [pnpm](https://pnpm.io/) 9+
- [Rust](https://rustup.rs/)（stable，MSVC toolchain）
- Windows 10/11 SDK（WebView2 运行时随系统自带）

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm tauri dev
```

启动后程序常驻托盘（**只有一个托盘图标**）。选中任意文字，按 **Alt+D**（可在设置里改），
鼠标附近弹出动作菜单，点一个动作即执行。按 **Alt+S** 触发屏幕截图 OCR。

### 打包

```bash
pnpm tauri build
```

产物在 `src-tauri/target/release/bundle/`（NSIS ~2MB / MSI ~3MB）。

## 使用

### 划词翻译

| 操作                       | 效果                                                       |
| -------------------------- | ---------------------------------------------------------- |
| 选中文本 +`Alt+D`        | 鼠标附近弹出**动作菜单**（翻译/总结/润色/解释/提问） |
| 点一个动作                 | 执行该动作，结果窗流式显示（LLM 打字机效果）               |
| 结果窗顶部动作栏           | 一键切换动作，基于当前选中文本重跑                         |
| 「提问」动作               | 结果窗带输入框，可多轮追问（保留上下文）                   |
| 点击别处                   | 窗口隐藏（程序仍托盘常驻）                                 |
| 左键单击托盘图标           | 等效快捷键，取当前选中文本弹菜单                           |
| 左键**双击**托盘图标 | 打开独立**对话窗**（自由聊天，不依赖划词）           |
| 右键托盘 → 设置           | 引擎 / 快捷键 / 动作 / OCR / 主题 等配置                   |
| 右键托盘 → 退出           | 完全退出                                                   |

### 屏幕 OCR

按 **`Alt+S`**（可改）→ 截取屏幕任意区域 → 识别文字并在结果窗显示。识别完可在动作栏切到「翻译/总结/…」对识别文本继续处理。

OCR 有两种引擎（设置 → OCR 引擎切换）：

| 引擎                       | 说明                                                                                                      | 需联网 |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| **系统 OCR**（默认） | 调用 Windows 内置 WinRT`OcrEngine`，本地离线、免装、免 key                                              | 否     |
| **LLM OCR**          | 把截图丢给多模态视觉模型（GPT-4o / Qwen-VL / SiliconFlow / 本地 Ollama 等），识别准确度更高、支持复杂版式 | 是     |

LLM OCR 用独立的 provider 配置（端点 / key / 模型 / 识别提示词 / 生成参数），与划词翻译的 LLM provider 互不影响。

## 六种动作

| 动作 | 图标 | 说明                                   | 划词菜单 |          需 LLM          |
| ---- | :--: | -------------------------------------- | :------: | :----------------------: |
| 翻译 |  译  | 翻译到目标语言（可在设置改目标语言）   |    ✓    |  翻译类引擎或 LLM 均可  |
| 总结 |  总  | 提取 3-5 个要点                        |    ✓    |           LLM           |
| 润色 |  润  | 优化文笔、修语法、不改原意             |    ✓    |           LLM           |
| 解释 |  释  | 解释含义/代码（中文）                  |    ✓    |           LLM           |
| 提问 |  问  | 多轮对话，基于选中文本讨论             |    ✓    |           LLM           |
| 识别 |  识  | OCR 截图后显示识别文本（不进划词菜单） |    ✗    | 系统 OCR 免 / LLM OCR 需 |

每个动作都支持**自定义 prompt 覆盖**（设置 → 动作），翻译动作的自定义 prompt 支持 `{targetLang}` 占位符。

## 翻译 / LLM 引擎

内置引擎（纯前端 JS 契约，加引擎零 Rust 重编译）：

- **LLM** — 支持全部 5 个划词动作 + LLM OCR。三种端点协议，配置时按 provider 选：
  - `openai-chat`（**默认**）— `/chat/completions`：OpenAI / DeepSeek / Moonshot / OpenRouter / 本地 Ollama `/v1` 等
  - `openai-responses` — `/responses`：OpenAI 新版 Responses API
  - `claude` — `/v1/messages`：Anthropic Claude 原生协议（流式 SSE 单独解析）
- **DeepLx** — 自建/公共端点，免费免 key，仅翻译
- **Google** — 免费端点，免 key，仅翻译

可配置**多个 LLM provider**，每个 provider 独立设端点/key/模型/生成参数（温度、top-P、maxTokens、重复惩罚），在设置里切换当前激活的。

切换：右键托盘 → 设置 → 引擎，填 API key / 端点。

## 可配置

设置面板分 **6 页**：通用 / 快捷键 / 引擎 / 动作 / 历史 / 关于。

- **快捷键**：划词快捷键 + OCR 截图快捷键，均带按键捕获 UI（按组合键即记录），保存即时生效
- **触发方式**：先弹动作菜单 / 直接执行默认动作（默认动作可选）
- **动作开关**：勾选要在菜单里显示的动作，每个动作可写自定义 prompt
- **目标语言**：翻译动作的目标语言
- **OCR 引擎**：系统 OCR / LLM OCR 切换，LLM OCR 独立 provider 配置
- **主题**：跟随系统 / 浅色 / 深色
- **思维链**：是否显示模型的 reasoning 输出
- **开机自启**：是否随系统启动
- **历史**：划词结果 / 对话 两类历史记录

## 项目结构

```
Swiper/
├── src/                          # Svelte 前端
│   ├── main.ts                   # 多窗口入口路由（menu / result / chat / snip / config）
│   ├── lib/
│   │   ├── actions.ts            # ★ 动作定义 + prompt 模板（6 个动作）
│   │   ├── store.ts              # 配置模型 + 快捷键副作用
│   │   ├── history.ts            # 历史记录
│   │   ├── markdown.ts           # 结果窗 Markdown 渲染
│   │   ├── models.ts             # 模型列表拉取
│   │   ├── sse.ts                # SSE 流式解析
│   │   ├── theme.ts / lang.ts / utils.ts / tauriFetch.ts / repetition.ts
│   ├── components/               # OpenAISettings / Providers 设置组件
│   ├── windows/
│   │   ├── Menu/                 # 动作菜单窗（划词后弹出）
│   │   ├── Result/               # 结果窗（流式输出 + chat 多轮）
│   │   ├── Chat/                 # 独立对话窗（托盘双击打开）
│   │   ├── Snip/                 # OCR 截图选区窗
│   │   └── Config/               # 设置面板
│   └── services/translate/       # 引擎契约 + DeepLx/Google/LLM
│       └── llm/                  # openai-chat / openai-responses / claude / ollama
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                # Tauri Builder + 命令注册 + 不退出
│   │   ├── hotkey.rs             # ★ 可配置快捷键（划词 + OCR）+ update_hotkey 命令
│   │   ├── translate.rs          # 取词入口 + menu_action 事件协调
│   │   ├── ocr.rs                # ★ 屏幕 OCR（WinRT 系统 + LLM 视觉，截图/裁剪/识别）
│   │   ├── window.rs             # menu/result/snip 窗定位（多显示器+DPI）
│   │   ├── tray.rs               # 托盘 + 菜单 + 双击开对话窗
│   │   ├── pending.rs            # 跨窗口待处理事件中转
│   │   ├── config.rs / autostart.rs
│   ├── capabilities/             # Tauri 2 权限
│   └── tauri.conf.json
└── vendor/cookie/                # 本地补丁版 cookie crate（[patch.crates-io]）
```

## 设计要点

- **不用全局鼠标钩子**：快捷键触发，零误触、稳定（Win11 不会卸载）。
- **动作菜单先弹，再选动作**：一个入口统一所有功能，比"直接翻译"更灵活。
- **引擎 = 前端 JS 契约**：加引擎只改前端；LLM 引擎统一为通用 chat 执行器。
- **网络绕 CORS**：统一走 `@tauri-apps/plugin-http`（Rust 网络栈）。
- **失焦隐藏 100ms 防抖**：Windows 拖窗先 blur 后 focus，直接关会拖不动。
- **单托盘图标**：只在 Rust 代码里建一次（tauri.conf.json 不重复声明）。
