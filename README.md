# mail-alive

定期模拟一次 Webmail 登录（网易企业邮箱 qiye.163.com 托管的域名/高校邮箱），防止账号因"连续一年未登录"被停用。可本地手动跑，也可放 GitHub Actions 定时跑。实现细节见 `keepalive.mjs` 头部注释。

## 本地运行

需要 Node.js 18+（CI 用 20），零依赖，不用 `npm install`。

```bash
# 直连（本地宽带一般不会触发风控）
node keepalive.mjs -u you@your.domain -p your-password

# 走代理并自动换节点（需要先下载 mihomo，见下）
node keepalive.mjs -u you@your.domain -p your-password -s "https://订阅链接"
```

参数与对应的环境变量（`--help` 查看全部）：

| 参数 | 环境变量 | 必填 | 说明 |
|---|---|---|---|
| `-u, --username` | `MAIL_USERNAME` | 是 | 完整邮箱地址 |
| `-p, --password` | `MAIL_PASSWORD` | 是 | 登录密码 |
| `-s, --sub-url` | `CLASH_SUB_URL` | 否 | clash 订阅链接；**不传就直连** |
| `--node-filter` | `CLASH_NODE_FILTER` | 否 | 只使用名称含任一关键词的节点，逗号分隔，如 `日本,新加坡` |
| — | `CLASH_MAX_NODES` | 否 | 最多尝试几个节点，默认 10 |
| — | `CLASH_TEST_URL` | 否 | 节点可用性预检地址 |
| — | `CLASH_GROUP` / `CLASH_MIXED_PORT` / `CLASH_CONTROLLER_PORT` | 否 | 高级调优 |

也可以把 `MAIL_USERNAME=...` 等写进脚本同目录的 `.env`（已在 `.gitignore`），然后零参数运行。注意命令行参数会留在 shell 历史和进程列表里，介意就用环境变量。

### 本地下载 mihomo（走代理才需要）

脚本按 `MIHOMO_BIN` 环境变量 → `./bin/mihomo(.exe)` → `./mihomo(.exe)` → 系统路径的顺序查找内核，`bin/` 已加入 `.gitignore`，不会误提交。

Windows（PowerShell，amd64）：

```powershell
New-Item -ItemType Directory -Force bin | Out-Null
Invoke-WebRequest "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-windows-amd64-compatible-v1.19.34.zip" -OutFile bin\mihomo.zip
Expand-Archive bin\mihomo.zip -DestinationPath bin -Force
Rename-Item (Get-ChildItem bin\mihomo-*.exe | Select-Object -First 1).FullName mihomo.exe
```

macOS（Apple 芯片）或 Linux（x86_64）：

```bash
# macOS:   .../v1.19.34/mihomo-darwin-arm64-v1.19.34.gz
# Linux:   .../v1.19.34/mihomo-linux-amd64-compatible-v1.19.34.gz
mkdir -p bin
curl -sSL -o bin/mihomo.gz "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-compatible-v1.19.34.gz"
gunzip -f bin/mihomo.gz && chmod +x bin/mihomo
```

其他架构/新版本到 [mihomo releases](https://github.com/MetaCubeX/mihomo/releases) 找对应文件名，改 URL 即可。

## CI 运行（GitHub Actions）

workflow 已在 `.github/workflows/keepalive.yml`：每周一北京时间 11:23 自动运行，也可手动触发；mihomo 内核由 workflow 自行下载，不用提交二进制。

1. 把仓库推到 GitHub。
2. Settings → Secrets and variables → Actions → **Secrets**，添加：

   | Secret | 必填 | 说明 |
   |---|---|---|
   | `MAIL_USERNAME` | 是 | 完整邮箱地址 |
   | `MAIL_PASSWORD` | 是 | 登录密码 |
   | `CLASH_SUB_URL` | 否 | 订阅链接；**不设置就直连**。GitHub runner 是机房 IP，直连容易触发风控，一般建议设置 |

3. （可选）**Variables** 里按需添加 `CLASH_NODE_FILTER`、`CLASH_MAX_NODES`、`CLASH_TEST_URL`、`CLASH_GROUP`、`CLASH_MIXED_PORT`、`CLASH_CONTROLLER_PORT`，留空即用默认值。
4. Actions → 「邮箱保活」→ Run workflow 手动跑一次验证。

运行日志直接打印在 Actions 页面；仓库里的 `result.txt` 只有一行摘要（运行时间 / 成功与否 / 最新邮件时间），失败的运行也会提交记录并把任务标红。

## 被风控后如何解除

新 IP（比如 GitHub runner，或订阅里没见过的节点出口）首次登录，可能被要求验证码/短信二次验证（日志提示 `risk_2fa_sms`），这是网易的 IP 风控，不是账号问题。

该 IP 可以手动解除：

1. 用浏览器正常登录邮箱；
2. 进入「自助查询」→「风险拦截查询」；
3. 接收手机验证码，解除这个 IP 的风控。

解除后该 IP 即可直接登录、不再触发验证。CI 里建议配合 `CLASH_NODE_FILTER` 固定节点：在「风险拦截查询」里找到被拦的 IP 并解除（日志中的出口 IP 已打码，完整地址在该页面能看到），以后同一个出口就能长期用。换节点/换 IP 需要重新处理。

另外，密码连续输错会触发"密码错误次数过多"的临时锁定，等一段时间或用正确密码网页登录一次即恢复；测试失败场景请用不存在的账号，不要拿真实账号反复试错密码。
