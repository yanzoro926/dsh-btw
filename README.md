# dsh-btw

DSH 会话里的 **btw 旁问**：基于当前对话上下文，弹出一次性临时对话框提问；回答只存在于这个弹窗里，**默认不写入该会话的记忆**，点 × 关闭即丢弃（切换会话只是隐藏，切回会恢复）。如果确实想让主会话记住结论，可以在弹窗里生成一份压缩摘要、预览编辑后「送入主会话」。

> 状态：骨架（M0/M1）+ 交互补全（A 档）+ 上下文可控（B 档）+ 模型与成本（C 档）+ 选中文本旁问（0.4.3）+ 送入主会话（0.5.0）+ 浅色主题对比度（0.5.1）+ 仓库元数据（0.5.2）：Markdown 渲染、按钮 / 命令入口、弹窗按会话隐藏/恢复、上下文范围选择与快照统计、冷会话读取、btw 专用模型选择、token 用量、调用设置面板、失败重试、选中一段文本后直接提问、旁问摘要预览与写入。
> 规划文档：`../btw-plan/PLAN.md`；调研：`../btw-plan/research/{A,B,C}-*.md`。

## 它做什么

- 会话输入框右侧多一个 `btw` 小按钮 → 打开一个临时弹窗。
- 也可以在输入框输入 `/btw` 命令（命令入口不依赖按钮；按钮可用 `localStorage['dsh-btw:button']='0'` 隐藏）。
- 问题 + 当前会话的「模型可见历史」快照一起发给模型，流式回答；回答用 DSH 原生 Markdown 渲染器显示。
- 同一条回答不再提供「复制」或「插入输入框」：整段回答塞进主会话缺少你的提问，主会话会看不懂。需要留痕时，点弹窗头部的「送入主会话」，先把整段旁问压缩成摘要、在预览里修改，再确认写入（见下节）。
- 同一个弹窗里可以继续追问：前几轮问答由客户端作为 `priorTurns` 回传（有上限），**不写回主会话**。
- 弹窗顶部有「上下文」栏：选择这次旁问携带多少主会话历史（自动 / 最近 40 条 / 最近 120 条 / 全部 / 全部但不含工具输出），显示快照条数与估算 token，可点「刷新」重新读取；超限部分会从旧往新裁剪并在栏里标出省略条数。
- 目标会话即使没在当前进程里打开（冷会话）也可以旁问：host 会从持久化事件日志折叠出模型可见历史（只读）。
- 弹窗是自由浮窗：拖标题栏移动，拖右/下边缘或右下角改大小，双击标题栏最大化/还原；位置和尺寸记在 `localStorage['dsh-btw:window']`，下次打开沿用；范围选择记在 `localStorage['dsh-btw:range']`。
- 上下文栏旁边有 btw 专用模型下拉（来自本机 provider 目录，只影响这次旁问，不改主会话模型）；选择会记在 `localStorage['dsh-btw:model']`。
- 齿轮按钮打开「调用设置」：温度、最大输出 tokens、推理强度，以及是否在输入框旁显示 btw 按钮；只影响 btw，记在 `localStorage['dsh-btw:settings']`。
- 每条回答下方显示本次调用的 token 用量（`↑输入 ↓输出`，模型返回 usage 时）；调用失败时显示错误原因和「重试」。
- 先选中一段文本再点输入框旁的 `btw`（或执行 `/btw`）：弹窗会引用选中的文本（最多 2000 字符），引用条右侧的 × 可以清除。引用会内联进这次提问，模型能直接基于它回答「这是什么意思」这类问题。
- 点击停止 / 关闭弹窗 / 页面断开都会中止上游请求。

它生成的就是一次普通模型调用；主会话的下一轮完全看不到这些内容。

## 窗口交互

- **移动**：按住标题栏拖动（`pointerdown` → pointer capture；`position: fixed` + 绝对坐标）。
- **缩放**：拖右边缘 / 下边缘 / 右下角三个把手；最小 420×300，始终限制在 viewport 内（8px 边距）。
- **记忆**：拖动/缩放结束时把 `{x,y,w,h}` 写进 `localStorage['dsh-btw:window']`，打开弹窗时恢复并夹回当前 viewport。
- **最大化**：双击标题栏在「视口大小」和上次尺寸之间切换。
- **键盘**：Enter 发送、Shift+Enter 换行（带 IME `isComposing` 保护）；焦点在弹窗内时 Esc 关闭。
- `shell.overlay` 是 click-through 层：外层 `.btw-layer` 不接收指针事件，只有浮窗本身 `pointer-events: auto`。
- 弹窗按会话隐藏/恢复：切到别的会话时窗口立即隐藏（上下文与选中文本都属于打开它的那个会话），切回原会话时窗口和已发生的旁问对话恢复；只有点 × 才会关闭并清空。在别的会话点 `btw` 会打开那个会话自己的窗口，原会话的对话暂存，切回时恢复。

## 选中文本旁问（0.4.1）

- **入口**：先选中一段文本，再点输入框旁的 `btw`（或执行 `/btw`）。0.4.0 曾在每条回答下方提供 `btw` 按钮，0.4.1 已按反馈移除，只保留这一个入口。
- **捕获**：按钮在 `pointerdown` 与 `mousedown` 时读取 `window.getSelection()`，并在 `mousedown` 上 `preventDefault()`，避免按钮抢焦点把选区折叠；同时监听 `selectionchange` 缓存最近一次非空选区（5 秒内有效），即使点击瞬间选区被清掉也能取到。文本 < 2 字符忽略，最多截 2000 字符。
- **传递**：引用块（`[btw] 用户正在针对用户选中的文本提问，引用如下："""…"""`）由客户端内联进这次提问的 `question`，再发给 `/btw/ask`。这样即使 host 还是旧版本（不认识 focus 字段）也能生效。
- **host 兼容**：`normaliseFocus()` 仍接受旧的 `focus` 字段（selection 直接用文本；message 按 `messageId` 在完整快照里解析），但 0.4.1 客户端不再发送它。
- **隐私**：与普通 btw 完全一致——不写主 session、不建子会话；引用只存在于本次请求的消息里。

## 送入主会话（0.5.0）

- **入口**：弹窗头部右侧的「送入主会话」。至少有一轮完成的回答后可用；写入过且对话没再变化时按钮显示「已送入 ✓」并禁用。
- **两步**：先由当前 btw 模型把整段旁问压缩成一份记录（温度 0.2、最多 1200 tokens，按「我问了什么 / 结论 / 关键细节 / 仍未解决」四节，≤900 字）；模型失败或超时会自动改用本地兜底摘要（每个问题 + 每条回答的首段），并在预览里提示。然后在预览层里直接编辑，点「确认送入」才写。
- **写入什么**：一条 `user/message` 事件，`source.kind='btw'`、`source.form='notice'`，正文包在「【btw 旁问记录 · 时间】…这不是新的用户指令，无需逐条回复。…—— btw 插件写入 · 共 N 轮旁问」里。DSH 把它渲染成上下文/通知卡，而不是你的气泡；主会话下一次请求会带上它，**但不会唤醒主会话、不会立刻触发回复、不建 turn**。
- **限制**：只对当前进程里打开的会话（live session）可用；目标会话正在生成回答时拒绝写入（避免插进一轮中间）；摘要上限 8000 字；写入不可撤销（要删只能在主会话里手动处理）；重复保护只在客户端按对话指纹做，切换到别的会话再切回不会重复写，但同一份内容在别处重新生成、重新确认仍会再写一条。
- **隐私**：这是 0.5.0 唯一会写主会话的路径，且必须由你点击「确认送入」；不点就不会写。

## 隐私边界（重点）

| 行为 | 会不会发生 |
| --- | --- |
| 向主 session 追加事件（user/assistant/tool 消息） | 默认不会；只有你在「送入主会话」里点「确认送入」才追加一条 `user/message`（`source.kind='btw'`） |
| 创建 Agent / 子会话 / 会话文件 | 不会 |
| 写入 compaction、标题、搜索索引、turn/step | 不会 |
| 插件自己持久化问题或回答 | 不会（对比 ds-bot 会把 aside 存成 JSON） |
| 调用 provider（billing / provider 侧日志） | 会——这就是一次正常模型调用 |

上下文快照方式沿用 ds-bot 0.2.4（`src/host/btw.js`）的成熟做法：

1. `session.requestHeader()` 拿到本会话实际使用的 provider/model 与请求配置；
2. `trimToolBoundary(session.deriveMessages())` 拿模型可见历史，并丢掉「tool-call 已提交、tool 结果还没落日志」的悬空尾巴；
3. `session.toolHistory()` 取工具更新历史（默认不传 tools，所以仅 parity 模式用到）；
4. 拼上 `priorTurns` 和新问题，`ctx.llm.stream()` 一次调用，SSE 流回浏览器。

冷会话（当前进程里没有对应 Agent）走只读路径：

1. 优先 `ctx.sessionQuery.readSession(id)`（trusted 服务）拿到原始事件；
2. 否则 `ctx.sessionPersistence.open(id,'read')` → `handle.read()` → `handle.close()`；
3. 本地按 `dsh-session` 的 surface 规则折叠：只取 system/developer/user/assistant/tool-result 事件，应用 `replace` 区间，`request/header` 事件给出实际 provider/model；插件侧自带实现，不依赖宿主包解析（message projections 这类展示层投影不应用）。

两条路径都只读：不 attach Agent、不写 session。唯一的写路径是你在「送入主会话」里确认后，host 对 live session 调一次 `session.append('user/message', …, {surfaceOp:'append'})`（见 0.5.0 一节）。

## 架构

```
lib/index.js   host 半（Cordis 插件）
  inject: ['webServer','llm','sessions','connection']（sessionQuery/sessionPersistence 可选探测）
  GET  /btw/health   liveness + 生效配置 + 冷读能力（先过 admission fence）
  GET  /btw/models   provider/model 目录 + 当前会话 route + harness 默认 route（60s 缓存，先过 fence）
  POST /btw/context  JSON in → JSON out：该 range 下会发送的快照统计（不调模型）
      body: { sessionId, range? } → { ok, cold, range, stats{messages,chars,tokens}, dropped, provider, model }
  POST /btw/ask      JSON in → text/event-stream out
      body: { sessionId, question, priorTurns?, range?, provider?, model?, temperature?, reasoningEffort?, maxTokens?, focus? }
      （focus 仅为兼容旧客户端保留；0.4.1 客户端把引用内联进 question）
      SSE events: meta  {range,stats,dropped,cold,provider,model}   ← 首个事件，与 /btw/context 同口径
                  delta {kind:'text'|'reasoning',text}
                  usage {inputTokens,outputTokens,…}
                  done  {text,usage,provider,model,truncated,range,stats,dropped,cold}
                  error {code,message}
  POST /btw/summarize JSON in → JSON out：把弹窗里的旁问压缩成「送入主会话」摘要
      body: { sessionId, messages:[{role,text}], focus?:{text}, provider?, model? }
      → { ok, summary, fallback, warning?, provider, model, usage? }（模型失败/超时用本地兜底）
  POST /btw/commit   JSON in → JSON out：把确认后的摘要 append 进 live 主会话
      body: { sessionId, summary, turns?, at?, focus? } → { ok, seq, turns }
      409 SESSION_NOT_LIVE（会话未打开）/ SESSION_BUSY（正在生成）；不唤醒、不建 turn
lib/client.js  浏览器半（手写 bundle 工厂）
  slot conversation.input.right → 'btw' 按钮（props.sessionId + inputActions；选中文本时带引用）
  slot shell.overlay            → 自绘固定定位浮窗（可拖动/缩放，几何存 localStorage）
  弹窗上下文栏：range 下拉 + 模型下拉 + 快照统计 + 刷新 + 设置齿轮（/btw/context、/btw/models；发送时以 meta 帧为准）
  命令入口：commandUi `/btw`（不注册全局快捷键；Ctrl+Alt+B 属 DSH core）
lib/logic.js   纯函数（快照/范围/统计/冷折叠/摘要/SSE/错误映射），可 node:test
test/          logic 单测 + host 路由 smoke + client bundle smoke
```

配置项（`lib/logic.js` 的 `DEFAULT_CONFIG`，由 Cordis 插件 config 覆盖）：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不注册任何路由 |
| `maxParentMessages` | `200` | 「自动」范围下最多发多少条父会话消息（从旧往新截断） |
| `maxRangeMessages` | `1000` | 「全部」/「不含工具输出」范围的硬上限 |
| `defaultRecentMessages` | `40` | 「最近 N 条」的默认值与缺省回退 |
| `maxPriorTurns` | `20` | 弹窗内追问最多回传多少条历史消息 |
| `maxQuestionChars` | `8000` | 单次问题长度上限 |
| `maxBodyBytes` | `1 MiB` | POST body 上限 |
| `requestTimeoutMs` | `300000` | 单次旁问的看门狗超时 |
| `summaryTimeoutMs` | `60000` | 生成「送入主会话」摘要的看门狗超时（超时用本地兜底摘要） |
| `maxSummaryChars` | `8000` | 确认写入时摘要的长度上限 |
| `toolParity` | `false` | `true` 时像主会话一样传 `tools`+`toolHistory`（不推荐） |

## 安装

CLI 在 `D:\softwares\DSH-desktop\resources\runtime\cli\bin\dsh.cmd`（DSH_HOME 默认 `C:\Users\QY\.dsh`）：

```powershell
dsh plugin --profile desktop add file:D:/DSH-workspace/dsh-btw
```

也可以用 profile 的手动方式：把 `"dsh-btw"` 加进 `C:\Users\QY\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles`（或先 `pnpm add file:D:/DSH-workspace/dsh-btw` 再进 bundles）。

**然后重启 DSH Desktop。** client bundle 是在 host 启动时被 hash 进 boot graph 的，只刷新页面不会加载新插件；重启后打开任意会话，输入框右侧应出现 `btw`。

验证「不进记忆」：

1. 问一个只有 btw 知道答案的问题（比如「刚才那句话的第二个词是什么」）；
2. 关闭弹窗后继续正常的会话轮次——主会话模型不应知晓 btw 的问答；
3. 观察会话列表/标题/transcript 无变化；必要时对比 `C:\Users\QY\.dsh\sessions\<id>\` 文件的 updatedAt/大小（btw 不应产生新事件）。

## 开发循环

> profile 里的 `node_modules/dsh-btw` 已从「安装时复制的包」换成指向本仓库的 **junction**（`tools/relink-dev.ps1` 可重建），所以改源码后重启桌面端即可生效，不用重装。若以后跑 `dsh plugin ... add` 或 profile 里 `pnpm install` 把它覆盖回普通拷贝，重跑一次 `powershell -ExecutionPolicy Bypass -File tools/relink-dev.ps1`。

- 改 `lib/client.js` → 完全退出并重开 DSH Desktop（client bundle 的 hash 在 host 启动时写进 boot graph；本机没有 `pnpm dev:web`/`tsdown --watch`，刷新页面通常拿不到新 bundle）。
- 改 `lib/index.js` → 重启 DSH（Cordis 组合在启动时完成；重载插件也可，但重启最稳）。
- 单测：
  ```powershell
  npm run check        # node --check 三个文件
  npm run test         # node --test test/
  npm run test:direct  # 沙箱里 node --test 的 spawn 会 EPERM 时用这个
  ```

## 模型、用量与设置（C 档）

- **模型下拉**：上下文栏右侧列出本机所有 provider 的可用模型（`GET /btw/models`，60 秒缓存）。默认「跟随会话模型」——使用当前会话 `requestHeader` 里的 provider/model；选中某个模型后只影响 btw 旁问，不会修改主会话模型。
- **目录为空也能选**：很多 adapter 的 `listModels` 返回空列表（DSH 的 base 实现就是如此）。host 会把「当前会话模型」和「harness 默认模型」补进目录；列表里没有的模型可选「自定义模型…」，直接填 provider/model（同样经 `resolveModelInfo` 校验）。
- **校验**：显式选择模型时，host 会先 `ctx.llm.resolveModelInfo(provider, model)`；不可用的组合返回 400 `BAD_MODEL`，不会开始流式。
- **调用设置**（⚙）：温度（0–2）、最大输出 tokens（≤32768）、推理强度（none/low/medium/high/max，部分模型可能忽略）；「在输入框旁显示 btw 按钮」开关；「恢复默认」。
- **记忆**：模型选择在 `localStorage['dsh-btw:model']`，设置在 `localStorage['dsh-btw:settings']`，范围在 `dsh-btw:range`，窗口几何在 `dsh-btw:window`——都是页面本地的，不写 profile。
- **usage**：每条回答下方显示 provider 返回的 `↑输入 ↓输出`（有 reasoning tokens 时一并显示）；provider 不返回 usage 时隐藏。注意它与上下文栏里的「快照 token 估算」是两回事：前者是本次请求的实际计费口径，后者是插件侧按字符粗估。
- **重试**：流式失败（连接断开、provider 报错、被中断）时该条回答下方出现「重试」，用同一问题与当前模型/设置再发一次；成功的回答不提供重试。

## 稳健性与发布（D 档）

- **流式与中断**：SSE 响应带 `cache-control: no-cache, no-transform` 与 `x-accel-buffering: no`；客户端按 `\n\n` 分帧，处理 `meta` / `delta` / `usage` / `done` / `error`。点击停止、关闭弹窗、页面卸载都会 `AbortController.abort()`，host 随即取消上游流。单次请求有 300s 看门狗（`requestTimeoutMs`）。
- **没有自动重连**：旁问是一次性调用，断流后由用户点「重试」比自动重放更可控（避免重复计费）。
- **E2E 手工清单**（每档发布前跑一遍）：
  1. 完全退出并重开 DSH Desktop，确认无 layout/pending 报错；
  2. 新会话里 `/btw` 与输入框按钮都能打开弹窗；
  3. 上下文栏切换五个范围，统计条数/token 随之变化，刷新按钮可用；
  4. 冷会话（未在当前进程打开的历史会话）可预览并提问；
  5. 模型下拉能列出 provider/model，切模型后回答的 meta/usage 与所选一致；
  6. 设置面板改温度/maxTokens/隐藏按钮后，重开页面仍生效；
  7. 发送中途点停止、关闭弹窗、刷新页面，均无悬挂请求与未捕获异常；
  8. 未点「送入主会话」时，主会话 transcript / 标题 / 会话列表无新增，`C:\Users\QY\.dsh\sessions\<id>` 的 mtime 不变；
  9. 选中回答里的一段文本，点输入框旁 `btw`：弹窗出现「引用选中文本」条；问「这是什么意思」，回答应直接解释这段文字；点 × 后引用条消失，下一次提问不再带引用。
  10. 在会话 A 打开 btw 并提问，切到会话 B：窗口应立即隐藏；切回 A：窗口与之前的对话恢复；在 B 点 `btw` 打开的是 B 自己的空窗口，再切回 A 仍能恢复 A 的对话。只有点 × 才会清空当前会话的窗口。
  11. 旁问一轮后点「送入主会话」：出现压缩预览（可编辑）；「确认送入」后主会话出现一张「btw 旁问记录」通知卡，但主会话不应立刻回复；向主会话继续提问时它能引用摘要内容；再次点「送入主会话」且对话未变化时应显示「已送入 ✓」并禁用。
- **发布前置（尚未执行）**：`package.json` 目前 `private: true`；要发布需改 `false`、补 `license`/`repository`/`keywords`，然后 `npm login && npm publish`；dshmarket 还需要单独的商店条目与截图。发布需要你的账号/令牌，仓库里不保存凭据。版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 启动故障排查（2026-11-03 实测）

- **应用无法启动，host 日志 `Unexpected token '﻿', "{ n"... is not valid JSON`**：profile 的 `package.json` 被写入了 UTF-8 BOM（`EF BB BF`）。DSH 在读取清单阶段就退出，所以崩溃对话框里的「禁用第三方插件」也无效。用无 BOM UTF-8 重写：
  `[IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($false))`（PowerShell 5.1 的 `Set-Content -Encoding utf8` 会加 BOM，不要用）。
- **界面一直显示 pending，审计里 `@deepseek-ai/dsh-client-ui-layout: failed`**：btw 曾把 `btw.open` 的默认键位设为 `Ctrl+Alt+B`，与 DSH 核心 `sidebar.left.toggle` / `sidebar.right.toggle` 冲突；快捷键注册表拒绝重复默认绑定，会让核心 layout/右侧栏起不来，其余模块一直等服务。**0.2.1 起插件不注册任何全局快捷键**，入口只有按钮与 `/btw`。
- 上述两类问题都发生在启动阶段，与 React / 插槽 / `cordis.patch.yml` 无关；改插件后务必「完全退出并重开 DSH Desktop」再判断。

## 已知限制 / TODO

- 引用文本最多 2000 字符（`FOCUS_MAX_CHARS`），超出部分静默截断；引用由客户端内联进提问，选中内容为空或只有空白时视为没有引用。
- 选区捕获依赖浏览器 `window.getSelection()`；跨 shadow DOM / 特殊编辑器里的选区可能取不到，此时只会打开普通旁问。
- Markdown 用 shell 的 `MarkdownText` 渲染；若 shell 未暴露 primitives 则退回纯文本。reasoning 内容不显示。
- 「送入主会话」只对当前进程里打开的会话可用；目标会话正在生成回答时会拒绝（409），等它结束再送；写入不可撤销，摘要写入后成为主会话事件的一部分。
- 「送入主会话」的重复保护是客户端按对话指纹做的：切换会话再切回不会重复写；但在别处重新生成同一份内容并再次确认，仍会再写一条。
- token 数是插件侧粗估（CJK≈1/字、其它词≈1.3），不是 provider tokenizer 的精确值；实际计费以回答下方 usage 为准。
- 模型目录来自各 provider adapter 的 `listModels`；某些 provider 返回空或报错时该分组为空，但当前会话模型、harness 默认模型始终会在列表里，也可用「自定义模型…」直接填 provider/model（0.3.1 起）。
- 部分 provider 不返回 usage / 不认 reasoningEffort，界面会相应隐藏或静默忽略。
- 重试是手动的；没有自动重连（避免重复计费）。
- 尚未发布到 npm / dshmarket（见上节前置条件）。
- 窗口几何与范围选择按浏览器/页面本地记忆（`localStorage`），不是跨设备/跨 profile 同步的配置。
- 依赖两个未在 README 公开的 session 方法（`requestHeader`/`toolHistory`）：已做 feature-detect + 降级；DSH rc 升级可能漂移。
- 全局快捷键已移除：`Ctrl+Alt+B` 是 DSH 核心 `sidebar.left.toggle` / `sidebar.right.toggle` 的默认键，插件再注册会导致核心 layout 启动失败。入口只保留按钮与 `/btw`。
- SSE 已加 `x-accel-buffering: no` 并在客户端按 `\n\n` 解析；Electron 桌面壳下的实际缓冲行为待实机验证。
