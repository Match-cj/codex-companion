# 贡献指南

感谢你为 Codex Companion 提交反馈或代码。项目当前面向 Windows，修改应优先保持本机安全边界和现有升级流程。

## 开发环境

- Windows 10/11
- Node.js LTS（当前运行时使用 ESM）
- PowerShell 5.1 或更高版本
- 可选：Inno Setup 7（只在构建安装器时需要）

首次准备依赖：

```powershell
npm ci
```

## 本地验证

提交前至少运行：

```powershell
node --check server.mjs
node --test tests/*.test.mjs
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -Command '$source=Get-Content -Raw -Encoding UTF8 -LiteralPath ".\Quota Widget WPF.ps1"; & ([scriptblock]::Create($source)) -SelfTest'
```

需要验证安装包时再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\Build Branded Installer.ps1'
```

安装包和运行时目录是构建产物，不要提交到 Git。测试不要使用真实账号、飞书 Webhook、App Secret 或本机授权文件。

浮窗 `-SelfTest` 使用内置虚构账号，无需启动服务或登录，不读取本机账号，也不执行切换/预热或发送通知。仓库脚本使用 UTF-8；Windows PowerShell 5.1 请按上面的显式 UTF-8 命令执行，避免中文编码导致语法错误。自检失败会返回非零退出码。

## 提交规范

1. 一个 Pull Request 尽量只解决一个问题。
2. 新功能要补自动化测试；Windows UI 行为至少补自检或静态回归测试。
3. 修改配置、通知、账号或远程访问行为时，同时更新 `README.md`、`ROADMAP.md` 或 `CHANGELOG.md`。
4. 不要在提交、截图、日志和测试输出中包含 Token、邮箱、Webhook、绝对路径或真实对话内容。
5. 描述问题时请附 Windows 版本、软件版本、复现步骤和脱敏后的错误信息。

## Pull Request 检查清单

- [ ] 测试通过。
- [ ] 没有提交凭据或个人数据。
- [ ] 更新了用户可见行为的文档或变更日志。
- [ ] 说明了升级、回滚和兼容性影响。
