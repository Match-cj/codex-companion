# Codex Companion 交接文档

当前开发版本：**v0.7.45**（所有对话图片回传与项目/对话完成通知）

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

额度恢复通知：新鲜成功读取中，已观测的消耗比例从大于 0 回到 0 时通知，覆盖重置卡和正常窗口重置。观测值持久化，防止重启重复；首次读取满额不补发，多个恢复项合并通知。

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

开发测试包为 `CodexCompanion-Setup-v0.7.45.exe`。用户只需双击一次，安装器会：

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
