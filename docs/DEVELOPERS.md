# 开发者文档

面向：想从源码运行、二次开发、打包发布或排查故障的人。普通用户看 [README](../README.md) 就够了。

## 从源码运行

前提：Windows 10/11、[Node.js](https://nodejs.org/) 20 或更高（推荐 22 LTS）。

```powershell
git clone https://github.com/Match-cj/codex-companion.git
cd codex-companion
npm install
npm start
```

打开 `http://127.0.0.1:17841/`，按页面顶部「首次使用检查」一步步走（导入账号 → 配飞书 → 验证操作者）。

## 两份副本：工程目录与安装版

| | 路径 | 内容 |
| --- | --- | --- |
| 工程目录 | 仓库源码目录 | `.git`、`tests/`、`docs/`、`node_modules/` |
| 安装版 | `%LOCALAPPDATA%\Programs\CodexCompanion` | 内置 `runtime/`（Node v24 + Codex CLI）、`PAYLOAD-MANIFEST.json`、运行日志 |

两者不是重复备份，**不能删任一个**。改动流程固定：

```
改源码 → 双击 Deploy to Installed.cmd → 自动 MD5 增量同步 → 停旧进程 → 重启 → 校验 /api/health 与版本号
```

`Deploy to Installed.ps1` 永久跳过 `runtime\`、`node_modules\`、`PAYLOAD-MANIFEST.json`、`*LICENSE.txt`、`*.log`。

## 重启的唯一正规方式（重要）

**不要从任何自动化会话/终端里直接拉起 `Start Codex Companion.ps1`。** 这样启动的进程属于该会话的进程树，会话结束会被一起回收——表现就是“服务莫名消失”。

唯一正确的重启方式：

```powershell
Start-ScheduledTask -TaskName "Codex Companion"
```

计划任务（由 `Install Startup Task.ps1` 注册）带两个触发器：登录时启动 + **每 5 分钟自检**。后台活着时启动器直接空转退出，死掉则自动拉起。计划任务启动的进程归属于 Task Scheduler，不会被别的会话回收。

相关脚本必须存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 中文会按 ANSI 解析，直接报语法错误。

## 测试

```powershell
node --test tests/*.test.mjs
node --test tests/security.test.mjs
```

覆盖并行主对话、子代理过滤、迟到结束事件、同一对话去重和安全控制。安全测试**不是**完整安全审计。

## 版本号与发布流程

- 每次改代码升 patch 版本，三处同步：`server.mjs` 的 `APP_VERSION`、`package.json` 的 `version`、`Quota Widget WPF.ps1` 的 `$script:AppVersion`。
- `CHANGELOG.md` 同步记录用户可见变化。
- 打包：安装 **Inno Setup 7 x64** 后运行 `Build Branded Installer.ps1`，产出同级目录的 `CodexCompanion-Setup-v<版本>.exe`（会自动下载并内置指定版本的 Codex CLI，可用 `-CodexVersion` 指定）。
- 建议攒够一批用户可见变化再发 Release，不必每个 patch 都打包。

## 安装器机制（技术细节）

给朋友安装时，直接发那一个 `.exe` 文件即可。以下是它内部做了什么，出问题时可以对照。

用户双击一次即可安装并启动，安装器已经内置 Node.js 和官方 Codex CLI，不再要求另外安装 Node.js、Codex CLI 或 Codex Switcher。已有 Switcher 账号的用户仍可在高级设置中一次性迁移；新用户直接使用 Companion 的通用网页登录或设备码登录。Codex 桌面应用可选，但想使用切换后自动打开功能时需要安装。

升级时会先停止旧 Companion，把原程序目录保留为 `CodexCompanion.previous`；新版本解包、运行时校验或启动检查失败时，会自动恢复并重新启动旧版本。账号与配置位于 `%APPDATA%`，不跟程序目录一起覆盖。

安装包内置 `PAYLOAD-MANIFEST.json`，安装前会校验每个程序文件的相对路径、大小和 SHA256。文件缺失、多出或被修改时会拒绝安装，覆盖升级时同时自动恢复旧版本。

启动器会使用 Windows 已知文件夹明确设定 Companion 数据目录，不再依赖安装器临时环境。账号库读取会自动重试；主库暂时不可读时，先使用最近的有效备份显示账号，而不是让浮窗长期停在 `--`。

首次启动若遇到 Windows 安全扫描导致内置运行环境变慢，启动器会在后台等待并自动重试一次；两次启动均失败后才显示错误。

安装器会覆盖启动器完整的两次冷启动等待周期。公司电脑若禁止创建用户任务计划，会自动改用同样隐藏的 Windows 启动项；首次安装失败时会清理桌面快捷方式和卸载记录，不留下指向缺失脚本的图标。

安装后使用内置 Node 直连本机检查服务版本，绕过系统代理；安装失败时在回滚前自动把后台及启动日志保存到桌面的 `CodexCompanion安装失败日志.txt`。

单文件安装器不会包含制作者的账号、飞书 Webhook 或个人配置。当前安装器尚未购买代码签名证书，Windows 可能显示“未知发布者”；发布前应补充正式签名。

传统 ZIP 包继续作为开发和故障排查备用。只有使用 ZIP 且包内没有 `runtime` 目录时，才需要用户自己安装 Node.js LTS 与 OpenAI Codex CLI。解压后双击 `Install Companion.cmd`，它会检查依赖、创建桌面“Codex 助手”快捷方式，并注册隐藏的开机启动任务。

## 启动脚本与浮窗

| 文件 | 用途 |
| --- | --- |
| `Start Codex Companion.cmd` | 手动启动后台并打开控制台网页 |
| `Start Codex Companion Background.cmd` | 只启动后台、不打开网页（开机自启使用） |
| `Start Quota Widget.cmd` | 只启动额度浮窗 |
| `Stop Codex Companion.cmd` | 停止程序 |

两者启动的是同一个 Companion，不要同时双击；即使误点两次，也只会保留一个后台实例。

启动脚本会先结束旧 Companion 再干净启动，避免残留进程造成端口占用；这也会中断由旧 Companion 正在执行的任务。额度任务引擎启动失败时，网页和额度功能仍会保持运行，并每 15 秒自动重连。

浮窗始终置顶；本地状态每 60 秒读取一次，实际额度由后台每 5 分钟刷新，任务结束时会立即刷新。浮窗失去焦点时以及每两秒会通过原生窗口 API 恢复置顶，账号面板同样保持置顶；恢复时不激活窗口、不抢键盘焦点，也不改变位置或尺寸。系统安全桌面和独占全屏不在保证范围内。

浮窗、详情面板、toast 都带 `WS_EX_TOOLWINDOW`，因此不出现在 Alt+Tab / Win+Tab 中，但正常显示、点击、拖动。

## 行为细节

完整页面“通知”标签列出所有内置通知的条件及时间，无需先收到通知。类型开关即时保存；重置前可勾选 1 天、12/6/3/1 小时、30/15/5 分钟，也能自定义。同一账号同周期每档只提醒一次，重启不重复；离线错过多档时只提醒最近一档。比额度窗口更长的提前量不会触发。应用静音仍优先，关闭通知不停止任务；手动测试消息不受类型开关影响。逐次重试消息默认关闭。

浮窗双击非当前账号卡片，二次确认后切换，无额外切换按钮。正式切换与网页走同一 `/api/accounts/switch`；服务端与浮窗均核对切换后的当前账号 ID。自检使用虚构账号，不读取本机账号或执行真实切换。

悬浮窗账号面板会把凭据刷新失败明确显示为红色“登录已失效”，不再同时展示可能过期的额度与重置数据；失效账号的预热和切换入口会禁用。当前账号失效时圆环显示红色 `!`。

网页登录收到回调地址后会显示具体阶段；失败编号持续显示，不保留旧的授权提示。后台请求设置连接及总时间限制，Windows 无 HTTPS/ALL_PROXY 环境设置时尝试读取当前用户系统代理，不关闭证书验证。保存失败可在当前进程、15 分钟登录有效期内“重试保存”，无需再次交换授权码。

状态诊断提供固定代码和处理建议，区分缺少账号、引擎未就绪、主对话监听未就绪、机器人连接/操作者验证等状态。未配置飞书仅为可选提示，不影响本机使用。

停止后台任务需要二次确认。有活动任务但缺少本轮标识时明确报错，不伪造“已停止”；中断请求接受后等待真实结束事件，重复请求合并。

本机网页可导出 `CodexCompanion-diagnostics.json`，仅含白名单版本、运行状态和数量；不包含账号身份、路径、网络地址、原始日志、对话内容或凭据。

### 活动任务与默认回复

网页独立显示“活动任务与默认回复”，区分 Companion 后台、后台接管和桌面主对话记录。桌面任务依据主对话 `task_started` / `task_complete` / `turn_aborted` 记录，不能保证客户端当前仍在运行；异常退出可能留下未结束记录。启动时仅读取近 48 小时修改的主对话文件末尾最多 1MB 恢复显示，不补发历史通知。子代理、未知来源不计入活动列表。

### 额度与账号同步

- 从 Companion 的 Windows 加密账号库读取全部账号，并通过 Codex 官方接口读取额度、重置时间、可用重置次数及最近到期时间。
- 额度在上次记录的计划重置时间之前恢复到 100% 时发送“提前恢复”通知，覆盖周额度和 5 小时额度，多个账号同次恢复合并发送。仅检查新鲜成功读取；首次满额、缓存、读取失败和重复观测不触发。
- 额度刷新前会识别当前 Codex 桌面端以及本机已有 Codex Switcher 中的同一账号；若外部来源持有更新且有效期更长的登录凭据，会安全同步回 Companion，但不会恢复已永久删除的账号。
- 从 Companion 删除账号时会先持久化账号 ID、OpenAI 账号 ID 和邮箱三重删除标记，并立即清理该账号的额度提醒状态。
- 账号切换为原生安全切换：确认后强制关闭完整 ChatGPT/Codex 进程树并验证已经退出，再保存离开账号、原子替换 `auth.json`、校验目标身份；失败时明确报错并自动回滚备份。
- 网页高级设置可导出 `.ccbackup` 跨电脑迁移文件：账号凭据和备注经 scrypt 派生密钥 + AES-256-GCM 加密；导入只合并或更新账号，不删除目标电脑已有账号。

## 发布前安全基础

- 默认绑定 `127.0.0.1`，不再开放局域网。网页可显式开启远程访问并设置至少 24 字符口令；重启后监听范围生效。远程接口要求 Bearer 口令，服务端仅保存 SHA-256 摘要。普通 HTTP 不加密，勿公开暴露端口。
- 控制接口拒绝跨站请求及本机 DNS 重绑定地址；状态接口只返回允许公开的配置字段，不回显 Webhook、应用密钥、访问口令摘要或内部消息映射。
- 升级后飞书通知接收不变，回复控制需要验证一次操作者：本机网页复制随机“绑定 …”指令，发到机器人群；验证后仅该操作者可继续任务或重新绑定。操作者重置只能在本机网页进行。
- 可在本机网页确认导入 `.codex/auth.json` 中已有的 OAuth 文件凭据，存入 Windows 加密库。密钥环登录可能无法读取；已删除账号不自动恢复。
- 隐私与本地数据说明见 [PRIVACY.md](../PRIVACY.md)，公开发行准备进度见 [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md)。

## 远程访问与命令行

```powershell
node .\server.mjs
```

然后打开 `http://127.0.0.1:17841/`。首次保存设置时会在 `%APPDATA%\CodexCompanion\config.json` 创建配置。

默认只绑定 `127.0.0.1`，不会把账号令牌或控制接口暴露到局域网。飞书消息会包含结果预览；如果希望直接在手机上打开控制页，可通过 Tailscale 安全暴露本机页面，并把该地址填写到“手机可访问的控制台地址”。

## 故障排查

日志位置（安装目录 `%LOCALAPPDATA%\Programs\CodexCompanion`）：

| 文件 | 内容 |
| --- | --- |
| `launcher.log` | 启动器每次启动、健康检查、自愈记录 |
| `server.stdout.log` | 服务启动横幅、端口、Tailscale 检测 |
| `server.stderr.log` | 服务错误输出 |

浮窗相关问题先看 `launcher.log` 是否有 “Server health ready”；后台应在 `/api/health` 返回 `{"ok":true,"version":...}`。
