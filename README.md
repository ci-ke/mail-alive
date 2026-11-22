# mail-alive — 域名邮箱自动登录保活

对由网易企业邮箱（qiye.163.com）托管、以 `https://<你的邮箱域>/` 为登录页的域名邮箱（如高校/机构邮箱），在 GitHub Actions 上**定期模拟一次真实 Webmail 登录**，防止账号因《连续一年未登录将被禁用》类条款被停用；登录后立即调用收件箱接口输出反馈，确认会话真实有效。

## 脱敏设计（适配公有仓库）

- 代码与仓库中**不含任何具体邮箱域/账号/机构字符串**；登录域、接口地址全部由环境变量 `MAIL_USERNAME`（完整邮箱地址）推导
- 凭据只存放在 GitHub Actions Secrets（经环境变量注入，不拼进命令行，避免密码特殊字符破坏 shell 引号），**日志中密码、sid、账号、域名全程打码**（含 URL 编码形式，失败诊断日志与提交进仓库的 result.txt 同样兜底）
- 反馈只记录**最新一封邮件的日期**这一元数据，不记录标题、发件人等任何邮件内容（避免邮件信息泄入公开的 CI 日志与仓库）
- workflow 无第三方依赖（仅 GitHub 官方 `checkout`/`setup-node`，且运行时 Secrets 尚未进入环境），权限仅 `contents: write`（用于提交运行记录）

## 工作原理

登录页是机构定制页，背后是网易企业邮箱统一入口。登录表单原生 POST、密码为明文表单字段、无前端加密、无需预取 Cookie、正常登录无验证码，因此零依赖 Node 脚本即可纯 HTTP 复现：

```
POST https://entryhz.qiye.163.com/domain/domainEntLogin
     account_name=<@前用户名>&domain=<域名>&domainRadio=@<域名>
     &password=******&secure=1&all_secure=1&ch=&support_verify_code=1
  └─ 302 → GET /entry/door?...&uid=<完整邮箱地址>...     （下发会话 Cookie）
  └─ 302 → GET https://mailh.qiye.163.com/js6/main.jsp?sid=…
  └─ 200  落地 URL 含 sid 即登录成功，服务端已记录一次"登录使用"

POST https://mailh.qiye.163.com/js6/s?sid=<sid>&func=mbox:listMessages
     var=<?xml … fid=1、order=date、desc=true、limit=1、start=0 …/>
  └─ XML: <code>S_OK</code> + 最新一封 <date name="sentDate">（仅取此日期，与网页端显示一致）
```

前置假设：地址的域名部分与登录页域名一致（即 `https://<域名部分>/` 就是登录页），高校"域名邮箱"一般满足；纯 `@主域` 形式的地址未验证。

## 运行结果示例

```
[ISO 时间] == 邮箱保活开始 ==
[ISO 时间] 登录成功 ✓（服务端已记录一次登录使用）
[ISO 时间] 会话地址: https://mailh.qiye.163.com/js6/main.jsp?sid=<masked>&...
[ISO 时间] 收件箱校验: 最新一封邮件日期: 2026-11-19 10:36:24——会话确认有效 ✓
[ISO 时间] == 保活完成，退出码 0 ==
```

| 情形 | 日志 | 退出码 |
|---|---|---|
| 登录成功 + 收件箱有信 | `最新一封邮件日期: 2026-11-19 10:36:24` | 0 |
| 登录成功 + 收件箱为空 | `收件箱为空——会话确认有效 ✓` | 0 |
| 登录成功但反馈接口异常 | `登录成功，但收件箱反馈异常…` | 1 |
| 登录失败（密码错误/风控） | 失败详情 + 重定向链（打码，3 次重试后） | 1 |

退出码非 0 时 GitHub Actions 任务变红并向仓库所有者发送通知。

## 运行记录（result.txt）

脚本只负责向控制台输出，workflow 把输出（含 stderr）重定向到仓库根目录的 `result.txt` 并提交——**每次运行覆盖**，最新输出在文件里，历史输出留在 git 提交记录里（每次提交都是当时的输出快照）。失败的运行也会提交记录，同时任务变红触发 GitHub 通知。

成功时 `result.txt` 内容：

```
[ISO 时间] == 邮箱保活开始 ==
[ISO 时间] 登录成功 ✓（服务端已记录一次登录使用）
[ISO 时间] 会话地址: https://mailh.qiye.163.com/js6/main.jsp?sid=<masked>&...
[ISO 时间] 收件箱校验: 最新一封邮件日期: 2026-11-19 10:36:24——会话确认有效 ✓
[ISO 时间] == 保活完成，退出码 0 ==
```

- commit message：`keepalive ok @ 日期` 或 `keepalive failed @ 日期`
- 登录失败时日志会带原因码：`password_error` / `captcha_suspected` / `login_rejected` / `network_error`
- 这些真实运行记录的提交也让仓库持续有活动，GitHub 的 60 天停用规则通常因此不会触发

## 代理（GitHub 上基本必需）

GitHub runner 的机房 IP 会触发网易登录风控（`VERIFYCODE.REQ`，本地宽带则不会，实测确认）。给脚本传入 clash 订阅链接（`--sub-url` 参数或 Secret `CLASH_SUB_URL`）后，脚本全自动管理 mihomo：查找内核（环境变量 `MIHOMO_BIN` → 项目 `bin/` 目录 → 当前目录 → 常见安装位置）→ 生成临时配置 → 启动 → 等订阅加载 → 逐个切换节点尝试登录（触发验证码或网络错误就换下一个，默认最多 8 个，`CLASH_MAX_NODES` 可调）→ 结束时自动关闭内核。密码错误是确定性失败，会立即停止。配置与订阅内容只写入系统临时目录，不进入仓库；HTTPS 端到端加密，代理只能看到目标域名，看不到密码与邮件内容。

CI 中 workflow 只负责下载固定版本的 mihomo 内核并注入 Secret，其余全部由脚本完成。不传订阅链接且未设 `HTTPS_PROXY` 时为直连，行为不变。

## 部署

推送本仓库到 GitHub（公开/私有均可，公开仓库注意事项见下节），然后：

1. Settings → Secrets and variables → Actions → New repository secret，添加以下 Secret：

   | Secret 名 | 值 |
   |---|---|
   | `MAIL_USERNAME` | 完整邮箱地址，如 `user@your.domain` |
   | `MAIL_PASSWORD` | 邮箱登录密码 |
   | `CLASH_SUB_URL` | clash 订阅链接（用于绕过 GitHub 机房 IP 的登录风控，见下文「代理」） |

2. Actions → 「邮箱保活」→ Run workflow 手动跑一次验证；之后每周一上午（北京时间 11:23 左右）自动运行，GitHub 定时有几分钟到几十分钟延迟属正常。

## 本地运行

命名参数（argparse 风格，cmd / PowerShell / bash 语法一致，`--help` 查看全部）：

```bash
node keepalive.mjs -u you@your.domain -p your-password
# 直连登录（本地宽带一般不会触发风控）

node keepalive.mjs -u you@your.domain -p your-password -s "https://sub.example/subscribe?token=xxx"
# 走代理并自动换节点（需本机有 mihomo 内核：MIHOMO_BIN 指向它或放当前目录）
```

也兼容位置参数 `node keepalive.mjs <邮箱> <密码> [订阅链接]`，以及环境变量（CI 即此方式）：`MAIL_USERNAME` / `MAIL_PASSWORD` / `CLASH_SUB_URL`。注意命令行参数可能留在 shell 历史记录（如 PowerShell 的 PSReadLine 会持久化历史）与进程列表中，介意的话用环境变量。

## 公开仓库注意事项

- **Secrets 本身安全**：加密存储、日志自动打码；fork 发起的 PR 默认拿不到 Secrets；本 workflow 只由 schedule 和手动 dispatch 触发，不接受 PR 触发。密码绝不写进代码或提交历史。
- **运行日志公开可见**：脚本已做全局脱敏（账号/域名/密码/sid），且只输出邮件日期、不输出任何邮件内容；但请勿自行往日志里加打印敏感信息的调试代码。
- **60 天停用规则对公有仓库同样适用**：仓库连续 60 天无任何活动，GitHub 会自动停用 scheduled workflow，并提前/届时发送邮件提醒。届时到 Actions 页面手动重新启用，或偶尔 push 一次提交保持活跃。遵守 GitHub 政策，本项目不做自动规避。
- **建议部署前先改一次邮箱密码**再填入 Secret（若旧密码曾在其他地方暴露过）。

## 已知风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| GitHub 停用定时任务 | 仓库 60 天无任何活动会自动停用 scheduled workflow（邮件提醒，公有/私有仓库都适用） | 每周 run 都会提交一次 result.txt 运行记录，仓库持续有活动，通常不会触发；万一停用，按邮件提醒到 Actions 页面重新启用即可 |
| 网易风控/验证码 | GitHub runner 机房 IP 登录会触发风控（实测确认）；连续多次密码错误也会触发"密码错误次数过多"的临时限制（等一段时间或网页端手动登录一次即恢复） | 内置 mihomo + 订阅节点自动轮换（见「代理」）；脚本对密码错误等确定性失败立即停止、不浪费重试；若订阅节点全部被风控，可改用自托管 runner（家里电脑/NAS） |
| 密码更换 | 密码修改后脚本会失败 | 更新 `MAIL_PASSWORD` Secret 即可 |
| 频率 | 每周一次足够（规则是"连续一年"），过于频繁无必要 | 保持现状即可，不建议加大频率 |
| 反馈接口变更 | `mbox:listMessages` 为 webmail 前端接口，网易改版可能变化 | 登录本身仍有效；反馈异常会以退出码 1 提醒人工检查 |
