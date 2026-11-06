# Changelog

## 0.5.8 — 2026-11-06（内置 Markdown 渲染器）

- 不再 `require('@deepseek-ai/dsh-client-ui-primitives')`：DSH 明确不建议插件依赖 Harness Client 包，且该模块的导出形态（`React.memo` 对象）曾让回答整体退化为纯文本。
- 弹窗内置轻量 Markdown 渲染：标题、段落、粗体/斜体、行内代码、围栏代码块、无序/有序列表、引用、分隔线、链接，以及**表格**（含对齐、横向滚动）。
- 纯文本 fallback 一并删除；渲染完全由插件控制，后续 DSH 升级不会再把表格打回原文。
- 版本 0.5.8，测试 64 个（logic 33 / host 28 / client 3）全绿。

## 0.5.7 — 2026-11-05（最小化）

- 标题栏新增「–」：把弹窗收成右下角的小条，对话、草稿、正在生成的回答都保留；点小条（或再点输入框旁的 btw）展开。
- 小条显示轮数与状态：生成中脉动、生成完成显示「有新回答」；展开后清除。
- 最小化状态按会话保存：切走再切回仍是最小化；Esc 在小条上先展开而不是关闭，只有 × 清空。

## 0.5.6 — 2026-11-04（修复 Markdown 渲染）

- 修复回答区退回纯文本的问题：`MarkdownText` 是 `React.memo` 包装的组件（typeof 为 object），此前只接受 function，导致标题、表格、代码块全部按原文显示。改为按存在性判断后，表格/标题/列表等 Markdown 正常渲染。
- 无界面与接口变更；版本 0.5.6，测试 63 个全绿。

## 0.5.5 — 2026-11-03（统一包名为 dsh-btw-plugin）

- 源码包名、Cordis 插件名与 bundle patch 的 insert name 统一为 `dsh-btw-plugin`，与 npm 包名一致，避免本地安装与 npm 包同名冲突。
- 本地 desktop profile 的依赖与 bundles 改为 `dsh-btw-plugin`，并重新建立指向仓库的 junction。
- 功能不变；测试 63 个全绿。

## 0.5.4 — 2026-11-03（README 截图）

- README 增加「界面」一节，放两张实际截图（空状态、引用选中文本后回答）；仓库根新增 `screenshots.json`，供 dsh-market 等商店读取。
- 功能与 0.5.3 相同；版本仅用于更新 npm 上的 README。

## 0.5.3 — 2026-11-03（README 面向使用者重写）

- README 改为以功能和用法为主：功能、安装、使用、送入主会话、隐私边界、配置、已知限制，移除逐版本的开发过程、内部路由与 E2E 清单。
- 功能与 0.5.2 相同；版本仅用于更新 npm 上的 README。

## 0.5.2 — 2026-11-03（仓库元数据）

- `package.json` 增加 `repository` / `homepage` / `bugs`，指向 https://github.com/yanzoro926/dsh-btw；用于 npm 包与源码仓库互链（awesome-dsh-plugin 收录要求）。
- 版本 0.5.2，测试 63 个（logic 33 / host 28 / client 2）全绿；功能与 0.5.1 相同。

## 0.5.1 — 2026-11-03（浅色主题对比度）

- 修正主题变量：改用 DSH 真实 token `--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l2/l3`、`--dsw-alias-state-error-primary`、`--dsw-alias-label-primary-bluish`（此前用了不存在的 `text-*` / `border-base`，浅色主题下回退成近白色，灰字几乎不可读）。
- 标题、空态、提示、上下文统计、token 用量等文字改用更清晰的层级；占位符显式设色并去掉默认半透明；浮窗阴影/警示/成功色按明暗主题分别取值。
- 版本 0.5.1，测试 63 个（logic 33 / host 28 / client 2）全绿。

## 0.5.0 — 2026-11-03（送入主会话）

- 删除每条回答下方的「复制」「插入输入框」：整段回答进入主会话缺少用户提问，主会话难以理解。
- 新增弹窗头部「送入主会话」：把整段旁问压缩成四节摘要（我问了什么 / 结论 / 关键细节 / 仍未解决），在预览层里可编辑，再确认写入。
- host 新增 `POST /btw/summarize`（当前 btw 模型、temperature 0.2、maxTokens 1200、60s 看门狗；失败/超时用本地兜底摘要）与 `POST /btw/commit`（对 live 会话 `session.append('user/message', …, {surfaceOp:'append'})`，`source.kind='btw'`）。
- 写入不唤醒主会话、不建 turn、不立即触发回复；会话未打开返回 409 `SESSION_NOT_LIVE`，正在生成回答返回 409 `SESSION_BUSY`；摘要上限 8000 字。
- 客户端按对话指纹防重复：同一段对话写入后显示「已送入 ✓」并禁用，直到出现新的问答。
- 版本 0.5.0，测试 63 个（logic 33 / host 28 / client 2）全绿。

## 0.4.3 — 2026-11-03（弹窗按会话隐藏/恢复）

- 按会话切换的真正语义：A 会话打开 btw 后切到 B，窗口立即隐藏（不再显示在 B 上，因为上下文与选中文本都属于 A）；从 B 切回 A 时窗口和已发生的对话恢复。只有点 ×（或 Esc）才关闭并清空。
- 每个会话的旁问对话各自暂存：在 B 会话点 `btw` 会打开 B 自己的窗口，A 的对话留在 stash 里，切回 A 时恢复。
- 切换会话时若仍在流式生成，会中止该次回答并标记「（已切换会话，已停止）」；流式回调改为持有自己的消息数组，避免写进另一个会话的对话。
- 移除 0.4.2 的「已切换到另一个会话」提示条（窗口现在直接隐藏）。
- 版本 0.4.3，测试仍为 49 个（logic 26 / host 21 / client 2）全绿。

## 0.4.2 — 2026-11-03（弹窗跨会话保留；0.4.3 已改为按会话隐藏/恢复）

- 去掉「切换会话自动关闭」：切换走再切回，btw 窗口与已发生的旁问对话都保留；只有点 ×（或 Esc）才关闭并清空。
- 同一时间只保留一个 btw 窗口：在另一个会话点 `btw` 或执行 `/btw` 不会重置已打开的窗口（需先关闭）。
- 弹窗会话仍以「打开它的会话」为准：窗口保留期间继续提问，上下文仍取自打开时那个会话。
- 版本 0.4.2，测试仍为 49 个（logic 26 / host 21 / client 2）全绿。

## 0.4.1 — 2026-11-03（选中文本传递修复）

- 移除每条回答下方的 `btw` 按钮（`conversation.chat.assistant-actions` 入口），只保留输入框旁按钮与 `/btw`。
- 修复选中文本没有送达模型：引用块改由客户端内联进本次提问的 `question`，即使 host 仍是旧版本也能生效；host 的 `focus` 字段保留兼容。
- 选区捕获加固：`pointerdown` / `mousedown` 先读选区并在 mousedown 上 `preventDefault()`（避免按钮抢焦点折叠选区），`selectionchange` 缓存最近 5 秒内的非空选区作为回退。
- 修复 `package.json` 描述里的乱码字符（顺带去掉多余的可疑字节）。
- client smoke 改为断言两个 slot；版本 0.4.1，测试共 49 个（logic 26 / host 21 / client 2）全绿。

## 0.4.0 — 2026-11-03（按消息 / 选中文本旁问）

- 新入口：每条已完成回答下方的 `btw`（`conversation.chat.assistant-actions`，按 `messageId` 引用整条回答）。
- 新入口：选中文本后点输入框旁 `btw` 或执行 `/btw`，引用选中文本（≤2000 字符）；弹窗显示引用条，可一键清除。
- host 新增 `normaliseFocus()`：message 在 range 裁剪前的完整快照里按 id 解析（未知 id 忽略），selection 直接使用文本；引用以 `[btw] 用户正在针对…提问，引用如下："""…"""` 前置到问题。
- 引用只影响当次请求，不进入后续追问，也不写入主会话（隐私边界不变）。
- 新增 6 个测试（logic 3 / host 3），client smoke 覆盖第三个 slot；总计 49 个。

## 0.3.1 — 2026-11-03（模型下拉修复）

- 修复模型下拉点击无反应：不再过滤「`listModels` 返回空」的 provider；目录为空时下拉仍可展开。
- host `/btw/models` 并行查询各 provider（单个 2.5s 超时，失败只标记该 provider），并把当前会话模型、harness 默认模型补进目录；空目录不写 60s 缓存。
- 新增「自定义模型…」：目录里没有的模型可直接填 provider/model，仍走 `resolveModelInfo` 校验。
- 模型下拉不再在加载中/目录为空时禁用（仅流式进行中禁用）。

## 0.3.0 — 2026-11-03（C 档：模型与成本）

- 新增 `GET /btw/models`：列出本机 provider/model 目录、当前会话 route、harness 默认 route（60 秒缓存，需通过 admission fence）。
- btw 专用模型选择：只影响旁问，不改主会话模型；显式选择先经 `llm.resolveModelInfo()` 校验，不可用返回 400 `BAD_MODEL`。
- 调用设置面板：温度（0–2）、最大输出 tokens（≤32768）、推理强度；可隐藏输入框旁按钮。
- token 用量：解析流里的 `usage` 帧，在回答下方显示 `↑输入 ↓输出`（含 reasoning tokens）。
- 失败重试：流式失败后可在该条回答下方用相同问题与当前设置重试。
- SSE `meta` 帧补充 `provider` / `model`。

## 0.2.1 — 2026-11-03（启动稳定性修复）

- **移除全局快捷键**：`btw.open` 的 `Ctrl+Alt+B` 与 DSH 核心 `sidebar.left.toggle` / `sidebar.right.toggle` 冲突，会导致核心 layout 启动失败；入口只保留按钮与 `/btw`。
- 按钮可隐藏：`localStorage['dsh-btw:button']='0'`。
- README 增加「启动故障排查」：profile package.json 的 UTF-8 BOM、快捷键默认绑定冲突。

## 0.2.0 — 2026-11-03（B 档：上下文可控）

- 上下文范围：自动 / 最近 40 / 最近 120 / 全部 / 全部但不含工具输出。
- `POST /btw/context`：只读预览当前范围下会发送的快照（条数、字符、估算 token、省略条数），不调用模型。
- 上下文栏：范围下拉、统计、刷新；发送时以 SSE `meta` 帧为准。
- 超限裁剪：从旧往新截断；`no-tools` 会去掉 tool 消息与 assistant 的 tool-call 块。
- 冷会话：当前进程里没有 Agent 的会话可从 `sessionQuery.readSession` 或 `sessionPersistence` 只读折叠出历史。

## 0.1.2 — 2026-11-03（A 档：交互补全）

- Markdown 渲染（DSH 原生 `MarkdownText`）、复制回答、插入输入框草稿。
- `/btw` commandUi 入口；切会话自动关闭；双击标题栏最大化。
- （0.2.1 起移除了快捷键入口。）

## 0.1.1 — 2026-11-02

- 浮窗改为可拖动、可缩放（右/下/右下把手），几何写入 `localStorage['dsh-btw:window']`，双击标题栏最大化。

## 0.1.0 — 2026-11-02

- 首个可用骨架：host `/btw/ask`（`ctx.llm.stream`，不建 agent、不写 session）、SSE 流式、客户端按钮与浮窗、安装声明与单测。
- 上下文快照沿用 ds-bot 0.2.4 的 `requestHeader` + `trimToolBoundary(deriveMessages)` + `toolHistory` 做法。
