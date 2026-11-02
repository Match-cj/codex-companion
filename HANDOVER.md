# Codex Companion 交接文档

## 最新状态：v1.0.26（2026-11-02）

**「转发 Windows 通知到飞书」开关**（本轮主要功能）：

- 原来代码里就有一个 `monitorWindowsNotifications()`（`server.mjs`，每 15 秒轮询 `wpndatabase.db`），一直在**无开关全量转发**。v1.0.21 加了三道闸：`windowsNotifyForward`（默认 false）、`windowsNotifyApps` 白名单（空 = 全部）、`windowsNotifyIncludeBody`（默认 false，只发标题第一条文本）。
- 单轮最多转发 12 条，超出合并为一条汇总。`listWindowsNotificationApps()` 扫描通知中心 distinct handler 供网页勾选（排除 Codex）。
- 路由：`GET/POST /api/windows-notifications`；网页在「通知管理」里，`loadWindowsNotify()/saveWindowsNotify()`。
- 每轮仍会因 Codex 的 skip 而不转发，但白名单过滤发生在 Codex skip 之后，白名单匹配的是 `formatNotificationAppName()` 的可读名（如 `WorkBuddy`、`Match Tools`）。

### 新增：飞书消息收件箱（`feishu-inbox.mjs`）

**动机**：用户想让本机 AI（Codex / WorkBuddy 等）读到飞书消息，但第三方飞书连接器要企业管理员审核，一直没通过。解决办法是不走审批——Companion 自己就在收飞书消息（自建应用 + 长连接），把它落盘即可。

- 落地两个文件：`%APPDATA%\CodexCompanion\feishu-inbox.jsonl`（原文）与 `feishu-inbox.md`（可读版，最新在最后，最多 200 条）。**只在本机，不上传任何地方**。
- 模块无 Companion 状态，`createFeishuInbox({ dir })` 注入目录；写操作用 promise 串行队列，避免飞书突发消息时并发读改写丢数据。
- 接入点：`Lark.EventDispatcher` 的 `im.message.receive_v1` 改为 `receiveFeishuMessage`（先落盘，再判断是否「收件箱」命令，最后才交给 `handleFeishuMessage`）。**这样改是为了不动 vm 测试切片**：`handleFeishuMessage` 被 `security.test.mjs` 切片覆盖，切片里没有 import 的新函数，在里面直接调会 ReferenceError。
- 飞书命令「收件箱 / 消息 / 最近消息 / inbox」回发最近 10 条（限已绑定的操作者）。
- 路由：`GET /api/feishu/inbox?limit=`、`POST /api/feishu/inbox/clear`。网页区块含「复制给 AI / 刷新 / 清空」。
- 107 项测试（新增 5 项收件箱）。

## 上一版：v1.0.19（2026-10-31）

### 新增：企业微信应用消息（一个人也能用的渠道）

企业微信**群机器人要求内部群至少 3 人**，只有自己一个人的企业微信建不了群，所以群机器人对单人用户不可用。为此新增 `wecom-app` 渠道（`webhook-notify.mjs`）：走自建应用消息，一个人也能发给自己；想用个人微信收就开「微信插件」。

- 用户填的地址带 `corpid` / `agentid` / `touser`，应用 Secret 放在 `token` 字段（**不回显到网页**）。
- `sendWebhook()` 里 `request.wecomApp` 分支：先用 `gettoken` 换 access_token（`wecomAppTokens` 缓存，提前 60 秒过期），再 POST `message/send`。
- 企业微信错误码翻成中文（`WECOM_ERRORS`：40001 Secret 不对、40013 CorpID 不对、45009 太频繁、48002 不在可见范围、60020 IP 白名单等）。
- 测试跟着加了 2 项（token 只换一次、错误码说人话），共 102 项。

### `server.mjs` 拆分第二批已完成

| 新模块 | 内容 | 行数 |
|---|---|---|
| `auth-utils.mjs` | `decodeJwtPayload()`、`jwtExpiry()`、`base64Url()`、`oauthPortStatus()` | ~80 |
| `native-usage.mjs` | `IsolatedUsageSession`（隔离 CODEX_HOME 的 Codex 子进程）、`officialUsageToLegacy()`、`readResetCreditDetails()`，以及 `createNativeUsage()` 工厂 | ~280 |

`server.mjs`：**3369 → 3080 行**，102 项测试全过，功能与界面零变化。

两个模块的分工方式不同，后面照抄即可：

- `auth-utils.mjs`：纯函数，无 Companion 状态，import 回来直接用，调用点一行没改。
- `native-usage.mjs`：需要 Companion 状态（`appDir`、`config`、`accounts`、三个缓存 Map、账号库读写）。做法是 `createNativeUsage({ ... })` 一次性注入，其中 `config` / `accounts` 会因为重载配置、刷新账号被整体重新赋值，所以传的是 `getConfig: () => config`、`getAccounts: () => accounts`，**不能传引用**。

### 锁屏与自动重试（用户问过，已写进网页）

Windows 锁屏（Win+L、屏保恢复需输密码）、远程桌面断开、睡眠/休眠之后，桌面被切走，UI Automation 拿不到按钮，自动重试点不到。只让显示器熄屏不影响，锁屏才影响。网页「桌面端自动重试」区块底部已加这段说明。

## 上一版：v1.0.18（2026-10-30）

**`server.mjs` 拆分第一批已完成**：

| 新模块 | 内容 | 行数 |
|---|---|---|
| `human-error.mjs` | `humanError()`——错误翻译成人话 | ~22 |
| `desktop-client.mjs` | 桌面端/浮窗的进程管理（`closeCodexDesktop`、`codexDesktopPids`、`isCodexDesktopRunning`、`launchCodexDesktop`、`execPowershellShort`、`isQuotaWidgetRunning`、`findQuotaWidgetWindow`、`focusQuotaWidgetWindow`、`killQuotaWidgetProcesses`、`openQuotaWidget`、`codexLaunch`、`WIDGET_*`） | ~150 |
| `device-login.mjs` | `DeviceLoginSession` 类 | ~95 |
| `app-paths.mjs` | 全部本机路径常量（`appDir`/`configPath`/`nativeAccountsPath`/`liveAuthPath`/浮窗脚本路径…），保留 `CODEX_COMPANION_DATA_DIR` 覆盖规则 | ~25 |
| `credential-crypto.mjs` | `runWithInput()`、`dpapiTransform()`、`protectCredential`/`unprotectCredential`（DPAPI，值走 stdin 不进命令行） | ~35 |
| `portable-backup.mjs` | `encryptPortablePayload()`、`decryptPortableAccountBackup()`、`validatePortablePassword()`（AES-256-GCM + scrypt） | ~85 |

`server.mjs`：**3594 → 3369 行**，100 项测试全过，功能与界面零变化。做法是用 import 把同名函数引回来，调用点一行没改。

**拆分的硬约束（后面接手务必先看这段）**：12 个测试用 `vm.runInContext(source.slice(起, 止))` 直接执行 `server.mjs` 的**源码文本**（activity / browser-login / feishu-menu / image-relay / notification-settings / quota-query / quota-reset / security / session-monitor / task-control / topic-lifecycle / webhook-notify）。所以：

- **不能重排、不能重命名**这些函数，否则 `indexOf` 定位会错位或找不到。
- 把某块搬走前，先确认它不在任何切片区间内；搬走后必须跑全量测试确认。
- 已被切片覆盖的大块（路由 `handle`、会话监视、飞书、额度、账号库）要搬走，必须**同步把对应测试改成 import 新模块**，这属于下一批工作，不要在第一批里顺手做。

**下一批建议顺序**（①②③ 已完成）：① ~~`oauthPortStatus` + `decodeJwtPayload`/`jwtExpiry` → `auth-utils.mjs`~~（v1.0.19）；② ~~`IsolatedUsageSession` + 预热 → `native-usage.mjs`~~（v1.0.19）；③ ~~路径常量 → `app-paths.mjs`、DPAPI → `credential-crypto.mjs`、便携备份 crypto → `portable-backup.mjs`~~（v1.0.24，`server.mjs` 3095 行）；④ 剩下账号库业务函数（`upsertNativeAccount`/`switchNativeAccount`/`writeNativeVault`，依赖 `config`/`readJson`/`queueNativeVaultWrite`，可用 `createAccountVault({...})` 注入），以及路由与会话监视（**必须先改对应 vm 切片测试**）。

另外：自动重试命中时会记录 `windowState`（`Minimized`/`Normal`），网页显示「点击时窗口：最小化也能点到」——用来回答"窗口最小化后还能不能自动点"。

## 上一版：v1.0.17（2026-10-30）

真机验收后按用户反馈修的四点（都改在 v1.0.16 的基础上）：

1. **抢鼠标**。`Desktop Retry Watcher.ps1` 原来 Invoke 失败就直接 `SetCursorPos`，而 Electron 常常不支持 Invoke，所以几乎每次都动鼠标。现在顺序是：InvokePattern → LegacyIAccessiblePattern.DoDefaultAction → 才用鼠标。用鼠标前先 `Test-MouseParked`（间隔 120ms 采样两次，位置一致才算空闲）；鼠标在用就 `continue` 并 emit `{"type":"skipped"}`，连续 10 次都忙才强制点（仍然还原位置）。点完 `SetCursorPos` 回原位。新增 `GetCursorPos` 到 Add-Type。
2. **通知轰炸**。会话监视器里新增 `capacityRetrySilence`（Map，定义在 `maybeWarnContextPressure` 之前，**必须在 vm 测试切片范围内**，见下方约束）：`capacityFailure && config.desktopRetryAutoClick === true` 时静默，累计次数；超过 `config.desktopRetryQuietMinutes`（默认 10，1–120）才发一条汇总。任务成功/其他失败时 `capacityRetrySilence.delete(threadId)`。
3. **渠道选择成本**。`webhook-notify.mjs` 的 `KINDS` 每项补 `howto` / `limit` / 可选 `recommend`；`dashboard.html` 的 `WEBHOOK_KINDS` 同步补一份（有测试断言两边 id 一致）。网页提供「各渠道怎么选」对比表 + 选中渠道后显示限制与详细步骤。
4. **状态可查**：`desktopRetryStatusText()`（server.mjs）供飞书「自动重试」「状态」使用；`state.lastMethod` / `state.skipped` 由 `applyDesktopRetryEvent()`（已导出，便于单测）写入。

另外新增「对话收尾」：`server.mjs` 顶层 `export const HANDOFF_PROMPT`，页面渲染时替换 `dashboard.html` 里的 `HANDOFF_PROMPT_TEXT`（页面用 `typeof HANDOFF_PROMPT_TEXT==='string'?...:''` 兜底，避免直接打开 html 时整段脚本报错）。飞书命令「交接提示词 / 收尾」。**上下文水位只提醒，不自动插话**——自动往对话里发指令可能打断正在跑的任务，这个决定不要轻易推翻。

## 上一版：v1.0.16（2026-10-30）

在 v1.0.15（桌面端自动重试）之上补齐三项：

1. **通用 Webhook 通知层**（`webhook-notify.mjs`）：`config.webhooks = [{id,kind,name,url,token,enabled,lastOkAt,lastError}]`，支持 wecom / dingtalk / pushplus / serverchan / bark / telegram / discord / custom。路由：`POST /api/webhooks/add|remove|toggle|test`；`publicWebhooks()` 只回显 `https://host/…abcd` 形式的 `urlHint`，密钥不回传。`sendWebhooks()` 并行发送、逐渠道返回 `{ok,id,reason}`；`webhookBodyRejected()` 处理腾讯系「200 + errcode≠0」。投递结果写回 `config.webhooks[].lastOkAt/lastError`（经 `friendlyWebhookReason()` 转成人话）。
2. **上下文水位提醒**（`context-budget.mjs`）：复用已有的 `codexSessionContextStats`（inputTokens / contextWindow）。`contextWarning()` 在 70/85/95 三档各提醒一次，比例跌回 70% 以下（压缩或新对话）自动重置；账本存 `config.contextPressureLedger`（保留最近 100 条）。触发点是 `maybeWarnContextPressure()`，接入主对话 completed 与 failed 两条分支，通知类型 `context_pressure`（默认开启）。
3. **浮窗右键开关**：`Quota Widget WPF.ps1` 新增可勾选的「桌面端自动重试」项，读 `/api/status` 的 `desktopRetry.enabled` 同步状态，点击走 `POST /api/config`。

改动约束（后续接手请守住）：

- `notify()` 里飞书失败用 `feishuError` 接住而不是直接抛，保证其他渠道照常投递；只有「飞书失败且没有任何 webhook 成功」才整体失败。
- 现有 vm 单元测试直接切 `server.mjs` 源码片段运行，所以 `notify()` 内部**不要**调用切片范围外的函数；webhook 分发全部落在 `extraTargets.length` 判断之内（测试配置里没有 webhooks，因而不进入该分支）。
- 新增渠道只需在 `WEBHOOK_KINDS` 加一行、在 `buildWebhookRequest()` 加一个 case，并在 `dashboard.html` 的 `WEBHOOK_KINDS` 同步一行（必须同时补 `limit` 和 `howto`，有测试会检查）。
- **会话监视器里的新状态必须声明在 `async function processCodexSessionAppend(` 之后、`async function startCodexSessionMonitor(` 之前**，`session-monitor.test.mjs` 用 vm 只切这一段，切片外的模块级变量会 ReferenceError。同理，这段代码里只能用测试上下文已提供的东西（`config`、各个 Map、`notify`、`notifyTurnResult` 等），不要调 `desktopRetryState()` 这类切片外的函数。

96 项测试通过。真机验收仍待：下次容量错误时自动点重试、以及首次配置真实渠道时发一条测试。

## 上一版：v1.0.15（2026-10-30）

新增「桌面端自动重试」（`desktop-retry.mjs` + `Desktop Retry Watcher.ps1`）。背景：Codex 桌面端在 `Selected model is at capacity` 时会显示重试按钮，客户端自身只重试几秒到几分钟就停止，用户此前靠外部脚本手动点击。本次把它做成 Companion 的托管能力：

- 开关：`desktopRetryAutoClick`（默认关闭）、`desktopRetryCooldownSeconds`（3–120，默认 8）。三个入口：网页设置页、飞书命令「自动重试 开启/关闭」、后续可接浮窗右键菜单。
- 互斥：开启自动重试时 `desktopTakeoverAllowed()` 返回 false，即不再走「关闭桌面端 + 后台接管」那条路（该路径会关掉用户的桌面端，用户明确不接受）。
- 行为边界：只点 Codex/ChatGPT 进程窗口里名字为「重试 / Retry」的按钮；优先 UI Automation Invoke（不移动鼠标），失败才回退到鼠标点击；命中后按间隔冷却。
- 实测参考：用户 2026-10-30 的会话中，同一轮被重跑了 116 次（`task_started` 计数），重试期间会话文件**没有新增任何 user/assistant 消息**，只有 task_started / turn_context / token_count，说明点击重试不会污染上下文；代价是每轮重发整段上下文（该会话上下文快照约 1.5MB）。
- 74 项测试通过。真机验收待用户在下一次容量错误时确认：按钮被自动点掉、鼠标不被抢、关闭开关后完全不动。

### v1.0.14 历史记录

浮窗账号切换成功的事后确认框改为右下角 5 秒自动关闭提示。不显示任务栏按钮、不激活窗口；重复提示替换旧提示，退出浮窗清理窗口和计时器。只改成功反馈，事前确认、失败提示及切换接口不变。70 项测试通过，包括实际 WPF 隔离窗口的替换、过期和任务栏属性验证；未切换真实账号。

### v1.0.13 历史记录

用户已验收原话题继续。现场任务仍 running 且登记接管，策略是结束后才重开客户端。新增修复：通知统一真实 ID、复用别名根；旧根恢复同步出站路由；发送失败不再无条件另建话题；接管归属在开始轮次前登记，防止极快结束漏掉重启。67 项隔离测试通过。既有多话题可回复同一个原任务，不删除历史。真实接管结束后重开待验收。详见 docs/RELEASE-v1.0.13.md。

### v1.0.12 历史记录

v1.0.11 首行解析已生效，但之前被旧版清掉的根映射没有恢复，用户回复旧错误回执又没有关联。现通过指定消息读取接口，校验绑定群及本机器人身份，从明确的根消息任务 ID 恢复原线程，独立保存 feishuReplyTopicAnchors（最多 1000 条，不对外暴露），回执保留 taskId。群历史列表接口无权限，但指定的自身消息 GET 可读；不需要新增权限。已针对真实旧根消息只读验证：1 次读取恢复到正确原线程。未修改实际配置/发送继续任务。恢复失败只记录固定原因，不打印原始 SDK 错误及鉴权请求。

飞书通知后立刻回复报 thread not found：现场日志首行元数据 23,059 字节，旧读取仅 16,384 字节，解析失败后使用日志文件名的别名，真实主会话仍存在。修复为完整首行读取（4MB 上限）、旧回复别名解析、通知历史显式回退；未知话题不能用默认任务兜底。一次 not found 不再删除映射或宣称对话被删。任务引擎重新启动后，内存任务记录不能替代该引擎的 thread/resume 注册。59 项测试及真实日志只读身份恢复验证通过，未发送真实继续请求或改写已安装配置。部署后回复原结果通知验收。

## 早期交接记录（历史，版本以最新状态为准）

当前开发版本：**v1.0.9**。通知页增加独立类型开关及多档重置前提醒，`notificationTypes`、`resetReminderLeadMinutes` 和 `stallMinutes` 由专用接口校验保存；`quotaResetReminderLedger` 持久化每周期各档提醒，旧版 `resetReminderMinutes` 兼容默认值。网页卸载按钮仅打开本机 Windows 应用管理页，不直接执行卸载。2026-10-26 用户已验收 v1.0.7 浮窗双击账号切换。额度仅对原定时间前恢复满额发送新通知；正常到期保留即将重置提醒。浮窗自检已使用虚构账号，不依赖本机服务。开源当前状态及未完成项以 `ROADMAP.md` 与 `docs/OPEN_SOURCE_RELEASE.md` 为准。下列早期开发记录保留为历史，不作为当前验收状态。

长期待办和发布前验证清单见 [`ROADMAP.md`](ROADMAP.md)。每次上下文切换或新一轮开发，先读取该文件再继续。

本轮排查：网页和浮窗最终调用同一切换 API，但旧浮窗额外预验证、主要依赖双击卡片，且成功后校验不能证明按钮手势触发。新增单击“切换账号”按钮仍需二次确认；移除额外预验证，保留双击卡片。WPF 自检模拟 Button.Click，已确认调用切换函数（SelfTest 下不执行真实切换）；后台只记录请求来自 widget/web，不写账号身份。30 项单测及 WPF 自检通过，真实切换仍需用户非重要任务场景验收。

悬浮窗现在通过账号 `usage.error` 的固定登录失效语义识别失效凭据：账号卡片显示红色“登录已失效 · 请在网页重新登录”，隐藏可能过期的额度条及重置数据，禁用该卡预热和双击切换；当前账号失效时圆环显示红色 `!`。真机自检读取 2 张账号卡、识别 1 张失效卡，面板动态高度 169，置顶恢复/不抢焦点通过，运行错误 0。

新登录修复：curl 连接10秒/总30秒/进程35秒限制，close后读取完整输出；无HTTPS/ALL_PROXY环境变量时用Windows当前用户系统代理（读取最多5秒），不关闭TLS校验、不自动重放授权码。凭据交换/本地保存阶段和固定错误编号持续显示；未知外部错误/响应内容不回显。账号保存完成后先更新本地卡片，额度刷新后台执行。并发完成请求合并，同轮成功提交幂等；进行中不能重新生成/取消。保存失败的凭据仅保留内存可重试，公开状态固定白名单排除所有令牌，成功删除内存凭据。已通过28项自动测试，未访问同事电脑，不能声称该机根因已确认或已修复。

本轮实现默认关闭的图片回传：本机网页确认授权一个具体目录；仅上传主对话本轮最终回复明确嵌入的绝对本机 Markdown 图片，不扫描目录或下载远程 URL。每轮最多 6 个路径，单张最多 10MB，PNG/JPEG/WebP/GIF，真实路径包含校验及格式头检查，内容去重。跟在应用机器人本轮文字通知下，图片 message ID 绑定原 thread；静音/发送失败/Webhook 不上传。失败以固定提示写通知历史，不输出图片路径。后端仅使用已完成 agentMessage（排除明确 commentary）结果，不从累计输出寻找图片。真实上传、权限、多任务定位和新电脑验收待完成。

新增顶部首次使用检查、定位配置和导入入口。本机 GET `/api/diagnostics` 导出固定字段白名单 JSON，不带日志、身份、路径、内容和凭据；远程禁止导出。完整来源/许可审计、新电脑验收未完成。

本轮新增：默认回复目标与活动列表分离；本地 user 主对话开始/完成/中止记录展示；近 48h 修改文件尾部最多 1MB 恢复活动，不发送历史通知；后台活动、接管、桌面记录分类且按对话 ID 去重。桌面记录不等同于实时执行保证，未知来源和子代理过滤。

本轮：默认本机监听、远程 Bearer 摘要校验、跨站/本机 Host 校验、配置白名单脱敏、飞书本机随机指令验证操作者、明确确认导入本机文件凭据。升级后需本机网页复制验证指令，在飞书验证一次才恢复回复控制；通知仍可接收。远程开关监听范围需重启。

未完成：完整首次使用向导、任务控制体验收口、图片回传真机验收、全面日志脱敏审计、全新机器验收及第三方来源/许可证完整审计。尚不能称为正式公开发行完成。

独立 `/api/health` 用于安装检查；完整状态中账号库诊断采用 single-flight 和 1 秒超时回退，不依赖外部状态完成才响应。

安装就绪检查改用内置 Node HTTP 直连，规避 Windows PowerShell 系统代理；错误版本不会提前结束等待。失败回滚前将启动、后台输出及最后检查错误保存至桌面日志。

额度恢复通知（v1.0.8）：持久化每账号/窗口的消耗比例、原定重置时间、实际读取时间。仅用新鲜成功结果检测原定时间之前的满额恢复；正常窗口到期不发恢复通知。首次满额、旧数字基线、缓存/错误、乱序和重复读取不补发；多个恢复项合并。无法区分官方与手动重置。

## 当前功能

- 72×72 WPF 置顶圆形额度浮窗，显示当前账号可用百分比。
- 点击浮窗显示全部账号；Plus 同行显示 5h/7d，只有 7d 的 Pro 使用整行。
- 点击非当前账号卡片可以切换账号。Codex 桌面端运行时先二次确认，切换后自动重新打开 Codex。
- 完整网页提供账号登录、额度刷新、历史对话继续、新对话启动/继续/停止、飞书配置和通知过滤。
- 浮窗账号切换使用双击和固定二次确认；服务端会先验证目标凭据，再用 `taskkill /T` 关闭完整 ChatGPT/Codex 进程树并轮询确认退出，随后切换账号并重新打开；残留进程会阻止凭据替换并显示明确错误。
- 网页账号卡片、网页“全部预热”、浮窗账号卡片右键及圆环右键均支持额度预热；预热通过隔离 `CODEX_HOME` 的官方 Codex app-server 创建内存临时会话，发送无工具、只读、低推理的最小请求，不切换当前账号、不保存对话，周额度耗尽时拒绝执行。
- 网页账号卡片可编辑备注名，浮窗账号列表优先显示备注；原邮箱仍保留在网页和悬浮提示中。
- 读取重置次数及最近到期时间；新版 app-server 直接读取明细，旧版通过官方只读明细接口兼容；7 天内每天提醒一次。
- 同一账号、同一种额度的“额度已用尽”每天最多发送一次，跨 Companion 重启仍去重。
- 任务完成后刷新额度；多个账号额度恢复可合并通知。
- 直接监听 `~/.codex/sessions` 中新增的 `task_complete` 记录；启动时从文件末尾开始，不重发历史完成消息，以 turn ID 跨来源去重；仅接受明确的 `session_meta.thread_source=user`，subagent 和 unknown 均过滤。
- 飞书回复命中桌面端 active-writer 冲突时，自动关闭 Codex 桌面端、重试接管原 thread；接管 thread ID 持久化，全部远程 turn 完成后再重新打开桌面端，Companion 重启时会释放中断的接管状态。
- 飞书单行回执正文不再重复标题；确认文字使用实际恢复出的 thread 名称，而不是旧的全局绑定名称。
- 飞书 `image` 消息通过 `im.v1.messageResource.get` 下载至 `%APPDATA%\CodexCompanion\feishu-images`，作为 app-server `localImage` 输入继续原 thread，一小时后删除临时文件。
- 原生账号库使用 Windows DPAPI CurrentUser 加密；高级设置可无损迁移 Switcher 账号副本，新登录账号直接写入原生库。
- 全部账号额度由独立 `CODEX_HOME` 中的官方 Codex app-server 读取，互不覆盖当前登录；成功结果写入原生库作为启动快照。
- 原生切换会保存离开账号、原子替换并校验 `~/.codex/auth.json`，失败时从 `auth.json.companion.bak` 回滚，然后重启任务引擎和 Codex 桌面端。
- 通用网页登录和设备码登录直接新增/更新 DPAPI 原生账号库；原生模式不再调用 Switcher 导入接口。
- 浮窗和网页的会员徽标均显示为 `Plus` / `Pro`。
- 原生账号库写入前自动备份上一份有效数据；高级设置支持手动备份和确认恢复，恢复前保留 `accounts.vault.before-restore.json`。
- 网页对失效账号提供“重新登录”，对非当前账号提供确认删除；删除仅影响 Companion 原生账号库并先自动备份。
- 高级设置支持跨电脑 `.ccbackup`：scrypt（N=32768、r=8、p=1）派生密钥，AES-256-GCM 加密账号凭据与备注；密码不落盘，导入采用合并/更新语义。

## 必需依赖

1. Windows 10/11 与 Windows PowerShell 5.1；
2. Node.js LTS（`node.exe` 必须在 PATH）；
3. OpenAI Codex CLI（完整任务和设备码登录功能需要）；

Codex Switcher 不再是运行依赖。若机器上已有 Switcher，Companion 只会在用户点击“安全迁移账号副本”时读取 `%USERPROFILE%\.codex-switcher\accounts.json`；正常登录、额度、重置次数和切换均使用 Companion 原生实现。

## 对外分发

开发测试包为 `CodexCompanion-Setup-v0.8.5.exe`。用户只需双击一次，安装器会：

1. 解压到 `%LOCALAPPDATA%\Programs\CodexCompanion`；
2. 安装内置 Node.js 与官方 Codex CLI 运行时；
3. 创建桌面“Codex 助手”快捷方式；
4. 启动 Companion；
5. 在 Windows“已安装的应用”登记版本和卸载入口；
6. 用户打开网页后直接登录账号，以后只需双击桌面快捷方式。

覆盖升级前会把原程序目录移动为 `CodexCompanion.previous`。解包、内置运行时、后台语法或启动健康检查任何一步失败，安装引导都会恢复并重启旧版本；账号和配置始终保存在独立的 `%APPDATA%\CodexCompanion`。
安装包会在运行时根据 `PAYLOAD-MANIFEST.json` 对所有载荷文件执行大小与 SHA256 校验，并拒绝未登记的额外文件。

安装目录中的 `Uninstall Companion.cmd` 提供两种模式：只删程序并保留账号/设置，或经二次确认后连 `%APPDATA%\CodexCompanion` 一起删除。脚本对正式安装目录做了精确路径限制。

传统 ZIP 包保留为开发/排错备用。单文件安装器当前未签名，外部分发前应补充 Authenticode 代码签名以减少 SmartScreen 警告。

用户配置保存在 `%APPDATA%\CodexCompanion\config.json`，不放进发布包。不要把自己的飞书 Webhook、账号数据或 `.codex-switcher` 目录交给别人。

## 正式文件

| 文件 | 用途 |
| --- | --- |
| `server.mjs` | 本地后台、账号/额度、任务、通知和 API |
| `auth-utils.mjs` | JWT 解析、base64url、OAuth 回调端口检查（无 Companion 状态的纯函数） |
| `native-usage.mjs` | 原生账号额度读取与预热：隔离 CODEX_HOME 的 Codex 子进程 + `createNativeUsage()` 工厂 |
| `webhook-notify.mjs` | 通用 Webhook 通知层（含企业微信应用消息/群机器人、钉钉、PushPlus、Server酱、Bark、Telegram、Discord、自定义） |
| `desktop-retry.mjs` | 桌面端自动重试的托管与状态 |
| `desktop-client.mjs` | Codex 桌面端与浮窗的进程管理 |
| `device-login.mjs` | 设备码登录会话 |
| `human-error.mjs` | 错误翻译成人话 |
| `dashboard.html` | 完整网页控制台 |
| `Quota Widget WPF.ps1` | WPF 圆形浮窗及账号面板 |
| `Launch Quota Widget.vbs` | 隐藏启动浮窗 |
| `Start Codex Companion.ps1` | 清理旧实例并启动后台和浮窗 |
| `Codex Companion Launcher.vbs` | 桌面快捷方式入口 |
| `Codex Companion Worker.vbs` | 任务计划程序调用的隐藏独立启动入口 |
| `Start Codex Companion.cmd` | 启动并打开网页 |
| `Start Codex Companion Background.cmd` | 启动但不打开网页 |
| `Start Quota Widget.cmd` | 单独启动浮窗 |
| `Stop Codex Companion.ps1/.cmd` | 停止后台 |
| `Install Companion.ps1/.cmd` | 分发安装与依赖检查 |
| `Install Startup Task.ps1` | 注册隐藏的当前用户登录任务，并移除旧 `.cmd` 启动项 |
| `Uninstall Companion.ps1/.cmd` | 卸载程序，可选保留或彻底清除用户数据 |
| `README.md` | 用户说明 |
| `companion.ico` | 快捷方式图标 |
| `Install Portable.ps1` | 单文件安装器解包后的安装引导 |
| `Install Branded.cmd` | 现代安装向导调用的静默安装入口 |
| `Build Branded Installer.ps1` | 推荐的维护者构建脚本：下载固定版本官方 Codex CLI、加入 Node 并调用 Inno Setup 7 |

旧式 IExpress 构建脚本和失效的 `Install Portable.cmd` 已删除；正式构建统一使用 Inno Setup 7。

`launcher.log`、`server.stdout.log`、`server.stderr.log` 是运行时诊断日志，不应放入发布包。

## 已验证基线

- `/api/status`：v0.7.29 为之前确认的安装基线，v0.7.33 未自动覆盖安装；返回全部账号、`alias` / `display_name`、重置数量/最近到期时间、Codex 会话监听、飞书长连接状态及 `nativeVault` 备份状态；
- 浮窗原生置顶保活：失焦及两秒定时器调用 SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE)，关闭窗口停止定时器；自检故意降级后确认 TopmostRestored=true、NoFocusSteal=true。
- 冷启动保护：后台服务每次最多等待 45 秒，首次未就绪时静默结束并重试一次；两次均失败后才弹窗，同时保留每次尝试的进程与日志记录。
- 删除账号先持久化 ID、账号 ID、邮箱三重墓碑，再修改账号库并清除内存提醒状态；旧来源、备份与并发额度扫描均不能重新产生该账号的提醒。
- 企业电脑安装兼容：安装健康检查覆盖启动器最多 105 秒的冷启动恢复周期；任务计划注册被策略禁用时回退到隐藏启动项；全新安装失败会清理快捷方式、启动项和卸载登记。
- 登录凭据自愈：刷新额度前把当前 Codex 桌面端或本机已有 Switcher 中身份相同、有效期更长的凭据同步回原生账号库；额度读取按账号 single-flight，防止并发进程竞争旋转式刷新令牌；永久删除账号不会从任何来源复活，也不参与后台额度读取。
- 安装版数据目录固定测试：启动器显式设置 `%APPDATA%\CodexCompanion`；主账号库读取成功时 `source=primary`，主库临时失败时可回退显示有效备份。
- 账号库回退实测：在隔离目录故意写入损坏主库并放入 4 账号有效备份，安装版后台返回 4 个账号、`source=backup`、`usingBackup=true`，测试目录已清理。
- `/api/accounts/migrate-native`：先执行 DPAPI 往返自检，再把现有 Switcher 凭据加密复制到 `%APPDATA%\CodexCompanion\accounts.vault.json`；
- `/api/accounts/warmup` 与 `/api/accounts/warmup-all`：缺少显式确认时返回 400；正式请求只在用户确认后发送，成功后强制刷新该账号额度快照。
- `/api/threads`：通过 Codex 官方 `thread/list` 返回最近对话；`/api/threads/:id/continue` 通过 `thread/resume` 在原对话追加消息；
- 浮窗自检：4 张卡片、3 张可切换卡片、运行时错误 0；
- 正式进程：1 个 server、1 个 widget；
- 重启去重测试：重启前后当天同账号 5h 耗尽通知条数不增加；
- 官方重置明细兼容测试：本机 Codex CLI 0.142.0 只返回数量时，3 个有效账号均通过只读官方后端补齐最近到期时间；
- 账号库备份测试：手动备份返回 4 个账号，`backupReady=true`；恢复接口需要网页明确确认且恢复前另存当前副本；
- 现代单文件构建测试：Inno Setup 7.1.0 成功生成中文现代向导安装器，内置 Node v24.14.0 与 Codex CLI 0.153.4，载荷清单登记 29 个受校验文件。
- 单文件真实解包测试：安装器以模拟双击方式解到隔离临时目录，29 个受校验程序文件加 1 个完整性清单、后台语法、Node/Codex 版本、浮窗脚本、卸载入口及两份许可证全部通过；测试目录已清理，现有账号/配置未触碰。
- 跨电脑备份闭环测试：4 个账号导出后密文不包含邮箱明文；错误密码被拒绝；正确密码合并导入 4 个账号后总数仍为 4、当前账号不变、本机恢复备份仍有效。
- 升级回滚故障注入测试：在临时目录模拟已有旧版，新版解包后故意报错；旧版标记完整恢复、新版文件不残留、`.previous` 临时目录已清理。
- 完整性破坏测试：故意使文件 SHA256 与载荷清单不一致，安装器拒绝安装，旧版自动恢复，损坏文件与回滚临时目录均无残留。
- 卸载安全测试：从开发目录运行测试模式时返回 `Protected=true`，未产生文件或配置变更。
- Windows 卸载登记干跑测试：注册表目标为当前用户 `...\Uninstall\CodexCompanion`，版本、安装目录和带空格卸载命令均正确。
- 覆盖升级测试：模拟旧版目录覆盖升级，新版文件安装成功，旧版回滚副本保留，独立用户数据文件 SHA256 前后不变。
- `server.mjs` 通过 `node --check`，PowerShell 正式脚本均通过语法解析。

历史构建产物已移入 `archive\legacy-builds`，发布目录根部只保留当前版本安装器、ZIP、版本说明和 SHA256 清单。

## 已知边界

- Companion 的账号存储、登录、额度、重置次数和切换均已原生运行；Codex Switcher 仅作为可选的一次性旧账号迁移来源。
- 网页切换账号后自动打开 Codex 使用 Microsoft Store 应用 ID；未安装 Codex 桌面应用时，账号仍会切换，但无法自动打开桌面端。
- Companion 创建的任务可完整跟踪；网页可列出并继续 Codex 已保存的既有对话。未通过 Companion 接入的桌面端进行中任务，仍主要通过 Windows 通知转发感知。
