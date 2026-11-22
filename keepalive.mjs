#!/usr/bin/env node
/**
 * 域名邮箱自动登录保活脚本（零依赖，Node >= 18）
 *
 * 适用对象：由网易企业邮箱（qiye.163.com）托管、以 https://<邮箱域>/ 为登录页的
 * 域名邮箱（如高校/机构邮箱）。定期模拟一次 Webmail 登录，防止账号因
 * "连续一年未登录" 被停用，并通过读取收件箱反馈确认会话真实有效。
 *
 * 脱敏设计：本代码不包含任何具体邮箱域/机构字符串。登录域、接口地址全部由
 * 环境变量 MAIL_USERNAME（完整邮箱地址，如 user@your.domain）推导，
 * 目标信息只存在于环境变量 / GitHub Actions Secrets 中。所有日志输出经过
 * 全局脱敏（账号/域名/密码/sid，含 URL 编码形式），适配公开仓库可见的
 * CI 日志与提交进仓库的运行记录。
 *
 * 运行记录：完整日志只打印到控制台（CI 里即 Actions 日志，随时可删）；只有设置了
 * RESULT_FILE 时才写一行摘要（运行时间/成功与否/最新邮件时间），CI 用它提交
 * result.txt——进入 git 的内容不便删除，所以文件里只留最小信息。
 *
 * 登录协议（逆向自登录页原生表单，密码为明文表单字段，无需预取 Cookie）：
 *   1. POST https://entryhz.qiye.163.com/domain/domainEntLogin
 *      account_name=<@前用户名>&domain=<域名>&domainRadio=@<域名>&password=<明文>
 *      &secure=1&all_secure=1&ch=&support_verify_code=1
 *   2. 302 → GET /entry/door?...&uid=<完整邮箱地址>...        （下发会话 Cookie）
 *   3. 302 → GET https://mailh.qiye.163.com/js6/main.jsp?sid=<会话ID>
 *      落地 URL 含 sid 即登录成功（服务端已记录一次登录使用）。
 *
 * ⚠️ 测试注意：验证失败场景请用不存在的测试账号（如 test-nonexist@<域名>），
 *    勿对真实账号反复用错误密码——会触发"密码错误次数过多"的临时限制。
 *
 * 收件箱反馈（登录后立即调用，与 main.jsp 同源，携带会话 Cookie）：
 *   POST <同源>/js6/s?sid=<sid>&func=mbox:listMessages
 *      var=<?xml ... fid=1（收件箱）、order=date、desc=true、limit=1、start=0 .../>
 *   响应为 XML：<code>S_OK</code> + <array name="var">每封信一个 <object>，
 *   其中 <date name="sentDate"> 为发送时间（网易网页端列表所显示的时间），
 *   <int name="total"> 为收件箱总封数。
 *   只输出最新一封邮件的发送日期，不含标题/发件人等任何邮件内容（脱敏）。
 *
 * 代理与节点轮换：HTTPS_PROXY + CLASH_API 同时设置时（GitHub Actions 上由
 * mihomo 提供），脚本按订阅节点列表逐个切换登录线路；每个节点先经它访问
 * 外网测试地址（默认 Google generate_204）做可用性预检，坏节点直接跳过；
 * 登录时触发风控验证码或网络错误则换下一个，直到成功或试完。HTTPS 是端
 * 到端加密隧道，代理只能看到目标域名，看不到密码与邮件内容。
 *
 * 凭据与代理配置（命名参数优先，位置参数兼容，环境变量兜底；切勿写死在代码里）：
 *   node keepalive.mjs -u <完整邮箱地址> -p <登录密码> [-s <clash订阅链接>]
 *   环境变量：MAIL_USERNAME / MAIL_PASSWORD / CLASH_SUB_URL
 *   注意：命令行参数可能留在 shell 历史记录与进程列表中，介意就用环境变量。
 *
 * 本地运行示例：
 *   node keepalive.mjs -u you@your.domain -p your-password
 *
 * 给定订阅链接时脚本自动管理 mihomo（内核查找顺序：MIHOMO_BIN 环境变量 →
 * ./bin/mihomo(.exe) → ./mihomo(.exe) → /usr/local/bin/mihomo → /usr/bin/mihomo）：
 * 生成临时配置、启动内核、等订阅加载、按节点轮询登录、退出时自动关闭内核。
 * 可用 CLASH_NODE_FILTER 只保留名称含指定关键词的节点（逗号分隔，匹配不到即失败，
 * 不会退回其他节点）。配置与订阅内容只写入系统临时目录，不会进入当前目录/仓库。
 */

import https from "node:https";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

// 先加载脚本同目录的 .env，后面的配置常量与凭据兜底才能读到其中的值
// （.env 已被 .gitignore；只填补 process.env 中不存在的键，真实环境变量优先）
loadDotEnv();

const LOGIN_ENDPOINT = "https://entryhz.qiye.163.com/domain/domainEntLogin";
/** 登录成功的判定：最终落地在 webmail 主页面且带 sid 会话参数 */
const SUCCESS_URL_PATTERN = /\/js6\/main\.jsp\?.*sid=/;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_REDIRECTS = 8;
const REQUEST_TIMEOUT_MS = 20_000;
// 代理支持：HTTPS_PROXY 指向 clash/mihomo 的 mixed-port 时，登录流量经 CONNECT 隧道出去；
// CLASH_API 指向 external-controller 时，触发风控后脚本自动切换节点重试。
// 第三个命令行参数（或 CLASH_SUB_URL 环境变量）给定订阅链接时，脚本自动管理 mihomo
// 生命周期（生成配置→启动→等订阅加载→登录→退出时关闭），CI 与本地行为完全一致。
let PROXY_URL = process.env.HTTPS_PROXY?.trim() || "";
let CLASH_API = process.env.CLASH_API?.trim() || "";
const CLASH_GROUP = process.env.CLASH_GROUP?.trim() || "PROXY";
const CLASH_MAX_NODES = Math.max(1, Number(process.env.CLASH_MAX_NODES || 10));
/** 节点可用性预检地址：能访问外网（Google 204）才算可用，避免拿坏节点去碰邮箱登录 */
const CLASH_TEST_URL =
  process.env.CLASH_TEST_URL?.trim() || "https://www.gstatic.com/generate_204";
const NODE_TEST_TIMEOUT_MS = 8_000;
// 自动管理 mihomo 时的监听端口。刻意避开 7890/9090 等常见 clash 默认端口，
// 防止本机自己的 Clash 占用同名端口时，脚本的 CONNECT 打进别人的实例、流量被短路直连
const CLASH_MIXED_PORT = Number(process.env.CLASH_MIXED_PORT || 17890);
const CLASH_CONTROLLER_PORT = Number(process.env.CLASH_CONTROLLER_PORT || 19090);
/**
 * 请求订阅时声明的客户端标识。不少机场按 User-Agent 返回不同的节点集合：
 * mihomo 内核默认发 clash.meta/<版本>，可能拿到被裁剪过的列表（订阅里会出现
 * "过滤掉 N 条线路" 之类的信息条目）；声明为 mihomo/<版本> 可拿到完整节点。
 * 预检/登录节点本身仍由本地 mihomo 执行，这里只是告诉订阅服务器"我是谁"。
 */
const CLASH_SUB_UA =
  process.env.CLASH_SUB_UA?.trim() ||
  `mihomo/${process.env.MIHOMO_VERSION?.trim() || "v1.19.34"}`;
/** 订阅中常见的信息类条目（含机场的"过滤掉 N 条线路"提示），不是真实代理节点，跳过 */
const NODE_NAME_BLACKLIST =
  /^(官网|套餐|剩余|到期|流量|重置|发布|订阅|更新|官址|过滤)/i;

/**
 * 全局日志脱敏：公有仓库的 Actions 日志对所有人可见，凡是可能带出账号/域名/密码/sid
 * 的输出一律打码（覆盖 URL 编码形式，如 uid=user%40your.domain）。
 */
let scrub = (text) => String(text ?? "");
function installScrubber({ account, domain, password, subUrl = "" }) {
  const tokens = [
    `${account}@${domain}`,
    account,
    domain,
    password,
    subUrl,
  ]
    .filter((t) => t && t.length >= 2)
    .flatMap((t) => [t, encodeURIComponent(t)]);
  scrub = (text) => {
    let out = String(text ?? "");
    for (const token of tokens) out = out.split(token).join("<masked>");
    return out.replace(/(sid=)[^&\s"']+/gi, "$1<masked>");
  };
}

const log = (...args) =>
  console.log(
    `[${new Date().toISOString()}]`,
    ...args.map((a) => (typeof a === "string" ? scrub(a) : a)),
  );

/**
 * 日志里的出口 IP 只保留网段：IPv4 留前两段、IPv6 留前两组，其余打星号。
 * 够用来核对"是否走了节点/出口是否变化"，又不把完整地址留在公开日志里。
 */
function maskIp(ip) {
  const text = String(ip ?? "").trim();
  if (!text) return "查询失败";
  if (text.includes(":")) return `${text.split(":").slice(0, 2).join(":")}:*`;
  const parts = text.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : "***";
}

/**
 * 运行结果的最小化记录：仅当 RESULT_FILE 指向文件时，退出前写入一行摘要
 * （运行时间 + 成功/失败 + 最新邮件时间）。完整日志只留在控制台/Actions 日志里
 * （日志可删），因为进入 git 仓库的内容不便删除。
 */
let runStarted = false;
let resultEmailDate = null; // 成功时的最新邮件时间；空字符串表示收件箱为空
function writeResultFile(ok) {
  const file = process.env.RESULT_FILE?.trim();
  if (!file) return;
  // 固定按北京时间记录（GitHub runner 是 UTC），避免摘要时区含义不明
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const stamp = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  const body = ok
    ? `${stamp} 成功 最新邮件: ${resultEmailDate || "收件箱为空"}\n`
    : `${stamp} 失败\n`;
  try {
    fs.writeFileSync(file, body, "utf8");
  } catch (err) {
    console.error(`写入运行结果文件失败（${file}）: ${err.message}`);
  }
}

// 任何退出路径（正常 return、process.exit、未捕获异常）都会走到这里
process.on("exit", () => {
  const code = process.exitCode ?? 0;
  if (!runStarted && code === 0) return; // --help 等未真正开跑的路径不落文件
  writeResultFile(code === 0 && resultEmailDate !== null);
});

/** 极简 Cookie 罐：只为跟住登录重定向链上的会话 Cookie */
class CookieJar {
  #cookies = new Map();
  absorb(setCookie = []) {
    for (const line of setCookie) {
      const [pair] = line.split(";");
      const name = pair.slice(0, pair.indexOf("=")).trim();
      if (name) this.#cookies.set(name, pair);
    }
  }
  header() {
    return [...this.#cookies.values()].join("; ");
  }
}

/** 打码 sid / riskToken(JWT，内嵌邮箱) / 手机号，避免会话与身份凭据泄进 CI 日志 */
function sanitizeUrl(url) {
  return String(url ?? "")
    .replace(/(sid=)[^&\s"']+/gi, "$1<masked>")
    .replace(/(riskToken=)[^&\s"']+/gi, "$1<masked>")
    .replace(/(mobile=)[^&\s"']+/gi, "$1<masked>");
}

/**
 * 通过 HTTP CONNECT 隧道穿过代理（如 clash/mihomo 的 mixed-port），
 * 返回已与目标完成 TLS 握手的 socket。代理只可见目标域名（SNI），看不到内容。
 */
function connectThroughProxy(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
    });
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let buf = "";
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });
    socket.on("data", function onData(chunk) {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      socket.off("data", onData);
      const head = buf.slice(0, idx);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败: ${head.split("\r\n")[0]}`));
        return;
      }
      // CONNECT 200 响应正常无 body，其后字节即 TLS 记录（此处忽略极罕见的残留）
      let settled = false;
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
        settled = true;
        resolve(tlsSocket);
      });
      // 握手阶段的错误用于 reject；连接建立后的错误交给请求层处理，
      // 避免节点抖动时出现未捕获异常导致进程崩溃
      tlsSocket.on("error", (err) => {
        if (!settled) reject(err);
      });
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`代理连接超时（${REQUEST_TIMEOUT_MS}ms）: ${proxyUrl}`));
    });
    socket.on("error", reject);
  });
}

/** 调用 mihomo/clash 的 external-controller API（仅本机 http，不走隧道） */
function clashRequest({ method = "GET", path, body = null }) {
  return new Promise((resolve, reject) => {
    const api = new URL(CLASH_API);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: api.hostname,
        port: Number(api.port) || 80,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error(`clash API 超时: ${path}`)),
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 解析节点名筛选关键词（CLASH_NODE_FILTER）。
 * 支持逗号（含全角）分隔多个关键词，关键词可用引号包裹（含空格的名字更直观）：
 *   CLASH_NODE_FILTER="日本,新加坡"
 *   CLASH_NODE_FILTER='"日本", "日本 01"'
 * 注意在用时才解析：命令行 --node-filter 会在 parseCredentials 时才注入环境变量，
 * 顶层常量会在此之前就把值固定下来。
 */
function parseNodeFilters(raw) {
  if (!raw) return [];
  const terms = [];
  for (const match of String(raw).matchAll(/"([^"]*)"|'([^']*)'|([^,，]+)/g)) {
    // 第三分支会把前导空格和引号一起吞进来（如 , "日本 01"），统一去掉引号
    const term = (match[1] ?? match[2] ?? match[3] ?? "")
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * 计算本次运行的"线路"计划：
 *   - 未配代理 → [null]（直连）
 *   - 配了 HTTPS_PROXY 但无 CLASH_API → [null]（走代理默认节点）
 *   - 配了 HTTPS_PROXY + CLASH_API → 最多 CLASH_MAX_NODES 个节点，供逐个切换
 *   - 设置了节点筛选但一个都不匹配 → []（由调用方按失败处理，绝不退回其他节点）
 */
async function resolveNodePlan() {
  const filters = parseNodeFilters(process.env.CLASH_NODE_FILTER);
  if (!PROXY_URL || !CLASH_API) {
    if (filters.length) {
      log(
        "已设置节点筛选（CLASH_NODE_FILTER），但本次未自动管理 mihomo，无法切换/筛选节点",
      );
    }
    return [null];
  }
  let group;
  try {
    group = await clashRequest({
      path: `/proxies/${encodeURIComponent(CLASH_GROUP)}`,
    });
  } catch (err) {
    if (filters.length) {
      log(
        `读取 clash 节点列表失败（${err.message}），无法按 CLASH_NODE_FILTER 筛选节点`,
      );
      return [];
    }
    log(`读取 clash 节点列表失败: ${err.message}——将使用当前默认节点`);
    return [null];
  }
  let nodes = (group?.all ?? []).filter(
    (n) => !NODE_NAME_BLACKLIST.test(n),
  );
  if (filters.length) {
    const keywords = filters.map((k) => k.toLowerCase());
    const before = nodes.length;
    nodes = nodes.filter((n) => {
      const name = n.toLowerCase();
      return keywords.some((kw) => name.includes(kw));
    });
    log(
      `节点筛选（名称含 ${filters.map((k) => `"${k}"`).join(" 或 ")}）: ${before} → ${nodes.length} 个`,
    );
    if (!nodes.length) {
      log(
        "没有匹配的节点，请检查 CLASH_NODE_FILTER 或订阅内容；本次不登录（不会改用其他节点）",
      );
      return [];
    }
  }
  if (!nodes.length) {
    log("订阅节点列表为空，将使用当前默认节点");
    return [null];
  }
  return nodes.slice(0, CLASH_MAX_NODES);
}

async function selectNode(node) {
  try {
    await clashRequest({
      method: "PUT",
      path: `/proxies/${encodeURIComponent(CLASH_GROUP)}`,
      body: { name: node },
    });
    return true;
  } catch (err) {
    log(`切换节点失败: ${err.message}`);
    return false;
  }
}

function tailFile(filePath, lines = 15) {
  try {
    return fs.readFileSync(filePath, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(无日志)";
  }
}

/** 内核查找顺序：MIHOMO_BIN → 项目 bin/ 目录 → 当前目录 → 常见安装位置 */
function findMihomoBinary() {
  const candidates = [
    process.env.MIHOMO_BIN,
    "./bin/mihomo",
    "./bin/mihomo.exe",
    "./mihomo",
    "./mihomo.exe",
    "/usr/local/bin/mihomo",
    "/usr/bin/mihomo",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return path.resolve(candidate);
    } catch {
      // 不存在或不可执行，试下一个
    }
  }
  return null;
}

function writeMihomoConfig(dir, subUrl) {
  const config = `mixed-port: ${CLASH_MIXED_PORT}
external-controller: 127.0.0.1:${CLASH_CONTROLLER_PORT}
mode: rule
log-level: info
proxy-providers:
  sub:
    type: http
    url: "${subUrl}"
    path: ./providers/sub.yaml
    interval: 86400
    header:
      User-Agent:
        - "${CLASH_SUB_UA}"
    health-check:
      enable: true
      url: "http://www.gstatic.com/generate_204"
      interval: 3600
proxy-groups:
  - name: ${CLASH_GROUP}
    type: select
    use: [sub]
rules:
  - MATCH,${CLASH_GROUP}
`;
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(configPath, config, "utf8");
  return configPath;
}

/**
 * 全自动管理 mihomo：生成临时配置（含订阅）→ 启动内核 → 等 API 就绪 →
 * 等订阅节点加载。配置/订阅/日志都写入系统临时目录，不污染当前目录。
 * 进程退出时自动关闭内核。
 */
async function startMihomo(subUrl) {
  const bin = findMihomoBinary();
  if (!bin) {
    console.error(
      "未找到 mihomo 内核：请设置环境变量 MIHOMO_BIN 指向内核可执行文件，" +
        "或将 mihomo 放在当前目录（CI 中由 workflow 下载到 ./mihomo）。",
    );
    process.exit(2);
  }
  log(`使用 mihomo 内核: ${bin}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-alive-"));
  const configPath = writeMihomoConfig(dir, subUrl);
  const logPath = path.join(dir, "mihomo.log");

  // 订阅链接等敏感内容经脱敏器打码（子串 token 已在 installScrubber 注册）
  PROXY_URL = `http://127.0.0.1:${CLASH_MIXED_PORT}`;
  CLASH_API = `http://127.0.0.1:${CLASH_CONTROLLER_PORT}`;

  const logStream = fs.createWriteStream(logPath, { flags: "w" });
  const child = spawn(bin, ["-d", dir, "-f", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("error", (err) => log(`mihomo 进程异常: ${err.message}`));
  process.on("exit", () => {
    try {
      child.kill();
    } catch {
      // 已退出则忽略
    }
  });

  // 提供显式清理：登录流程结束后关闭内核与日志流，
  // 否则子进程与文件句柄会挂住 Node 事件循环导致脚本不退出
  const cleanup = () => {
    try {
      child.kill();
    } catch {
      // 已退出则忽略
    }
    try {
      logStream.end();
    } catch {
      // 已关闭则忽略
    }
  };

  // 等 API 就绪
  let apiUp = false;
  for (let i = 0; i < 30; i++) {
    try {
      await clashRequest({ path: "/version" });
      apiUp = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!apiUp) {
    log(`mihomo 启动失败（API 未就绪），日志尾部:\n${tailFile(logPath)}`);
    child.kill();
    process.exit(1);
  }

  // 检查端口绑定：若 7890 等端口被本机其他程序（如你自己的 Clash）占用，
  // mihomo 会报 bind 错误但仍继续运行，CONNECT 就会打不进本实例
  await new Promise((r) => setTimeout(r, 1500));
  const logTail = tailFile(logPath, 50);
  if (/only one usage|address already in use|bind: /i.test(logTail)) {
    log(
      "mihomo 端口绑定失败：端口可能被本机其他程序占用（如你自己的 Clash）。\n" +
        "请换端口后重试（环境变量 CLASH_MIXED_PORT / CLASH_CONTROLLER_PORT），" +
        `或关闭占用程序。日志尾部:\n${logTail}`,
    );
    child.kill();
    process.exit(1);
  }

  // 等订阅节点加载（首次拉取可能因 DNS/网络延迟重试）
  for (let i = 0; i < 60; i++) {
    try {
      const provider = await clashRequest({ path: "/providers/proxies/sub" });
      const count = provider?.proxies?.length ?? 0;
      if (count > 0) {
        log(`订阅已加载 ${count} 个节点`);
        return { child, cleanup };
      }
    } catch {
      // API 未就绪或暂时失败，继续等待
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`订阅节点加载超时，日志尾部:\n${tailFile(logPath)}`);
  child.kill();
  process.exit(1);
}

/**
 * 一次性 HTTPS Agent：把已与目标完成 TLS 握手的隧道 socket 交给 HTTP 栈使用。
 *
 * 注意（踩过的坑）：不能用 https.request({ agent: false, createConnection }),
 * Node 在 agent:false 时会内部新建 Agent 并自行拨号直连目标，请求选项里的
 * createConnection 会被忽略——表现为"看似走了代理，实际全程直连"。
 * 必须通过自定义 Agent 的 createConnection（Agent 的方法）返回隧道 socket。
 */
class OneShotHttpsAgent extends https.Agent {
  constructor(tunnelSocket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.tunnelSocket = tunnelSocket;
  }
  createConnection() {
    return this.tunnelSocket;
  }
}

function httpRequest({
  url,
  method = "GET",
  headers = {},
  body = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const target = new URL(url);
  return (async () => {
    let agent = false;
    if (PROXY_URL) {
      const tunnelSocket = await connectThroughProxy(
        PROXY_URL,
        target.hostname,
        Number(target.port) || 443,
      );
      agent = new OneShotHttpsAgent(tunnelSocket);
    }
    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method,
          headers,
          agent,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              location: res.headers.location,
              setCookie: res.headers["set-cookie"] ?? [],
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error(`请求超时（${timeoutMs}ms）: ${url}`)),
      );
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });
  })();
}

const USAGE = `用法: node keepalive.mjs [-u <邮箱>] [-p <密码>] [-s <clash订阅链接>]
      （兼容位置参数: node keepalive.mjs <邮箱> <密码> [订阅链接]）

凭据也可以放在脚本同目录的 .env 文件中（KEY=VALUE，已被 .gitignore，
适合任务计划等定时运行场景），此时零参数运行即可。

选项:
  -u, --username <邮箱>   完整邮箱地址（环境变量/​.env: MAIL_USERNAME 兜底）
  -p, --password <密码>   登录密码（环境变量/​.env: MAIL_PASSWORD 兜底）
  -s, --sub-url <链接>    clash 订阅链接；传入后自动管理 mihomo（CLASH_SUB_URL 兜底）
      --node-filter <关键词[,关键词]>
                          只使用名称含任一关键词的节点，如 "日本,新加坡"
                          （环境变量 CLASH_NODE_FILTER 兜底）
  -h, --help              显示本帮助

其他调优项（环境变量）: CLASH_MAX_NODES / CLASH_TEST_URL / CLASH_NODE_FILTER /
CLASH_GROUP / CLASH_SUB_UA / MIHOMO_BIN / CLASH_MIXED_PORT / CLASH_CONTROLLER_PORT
注意: 命令行参数可能留在 shell 历史记录与进程列表中，介意就用 .env 或环境变量。`;

/** 命名参数（argparse 风格）为主，位置参数向后兼容，环境变量兜底 */
function parseCli() {
  try {
    return parseArgs({
      options: {
        username: { type: "string", short: "u" },
        password: { type: "string", short: "p" },
        "sub-url": { type: "string", short: "s" },
        "node-filter": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`参数错误: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

/**
 * 读取脚本同目录的 .env（KEY=VALUE，# 注释，可选引号）。
 * 只填补 process.env 中不存在的键——真实环境变量与命令行参数优先级更高。
 * .env 已被 .gitignore，适合存放本地定时运行的凭据。
 */
function loadDotEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // 没有 .env 是正常情况
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    let value = raw.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseCredentials() {
  const { values, positionals } = parseCli();
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const [posUser, posPass, posSub] = positionals;
  // 拿到命令行参数后再注入，resolveNodePlan 解析的是此时的环境变量
  if (values["node-filter"] !== undefined) {
    process.env.CLASH_NODE_FILTER = values["node-filter"];
  }
  const username = (values.username ?? posUser ?? process.env.MAIL_USERNAME)?.trim();
  const password = values.password ?? posPass ?? process.env.MAIL_PASSWORD;
  const subUrl =
    (values["sub-url"] ?? posSub ?? process.env.CLASH_SUB_URL)?.trim() || "";
  if (!username || !password) {
    console.error(`缺少凭据：用 --username/--password 或位置参数提供，或设环境变量。\n\n${USAGE}`);
    process.exit(2);
  }
  const sep = username.lastIndexOf("@");
  if (sep < 1) {
    console.error("邮箱应为完整地址，例如 user@your.domain");
    process.exit(2);
  }
  return {
    account: username.slice(0, sep),
    domain: username.slice(sep + 1),
    password,
    subUrl,
  };
}

function buildLoginBody({ account, domain, password }) {
  // 字段与登录页原生 <form> 完全一致
  return new URLSearchParams({
    domain,
    secure: "1",
    all_secure: "1",
    ch: "",
    support_verify_code: "1",
    account_name: account,
    domainRadio: `@${domain}`,
    password,
  }).toString();
}

/** 最新的邮件排最前（order=date, desc=true），fid=1 为收件箱；limit=1 只要第一封 */
function buildListBody() {
  const xml =
    '<?xml version="1.0"?><object>' +
    '<int name="fid">1</int>' +
    '<string name="order">date</string>' +
    '<boolean name="desc">true</boolean>' +
    '<int name="limit">1</int>' +
    '<int name="start">0</int>' +
    '<boolean name="skipLockedFolders">false</boolean>' +
    '<string name="topFlag">top</string>' +
    '<boolean name="returnTag">true</boolean>' +
    '<boolean name="returnTotal">true</boolean>' +
    "</object>";
  return `var=${encodeURIComponent(xml)}`;
}

function parseListResponse(text) {
  const code = text.match(/<code>([^<]+)<\/code>/)?.[1] ?? null;
  // total 仅用于判断收件箱是否为空，不对外输出
  const total = Number(text.match(/<int name="total">(\d+)<\/int>/)?.[1] ?? -1);
  // 只提取日期元数据，不提取标题/发件人等邮件内容。
  // 网易网页端列表显示的是发送时间（sentDate），优先取它以与页面显示一致；
  // receivedDate（服务器接收时间）可能晚于 sentDate，仅作兜底。
  const sentDate =
    text.match(/<date name="sentDate">([^<]+)<\/date>/)?.[1] ??
    text.match(/<date name="receivedDate">([^<]+)<\/date>/)?.[1] ??
    null;
  return { code, total, sentDate };
}

function looksLikeCaptcha(text) {
  return /验证码|verify.?code|captcha/i.test(text.slice(0, 5000));
}

/** 归类登录失败原因（固定英文码，用于日志定位问题） */
function classifyFailure(finalUrl, captchaSuspected) {
  if (/risk_2fa|startVerifyRisk|riskVerify=mobile/i.test(finalUrl))
    return "risk_2fa_sms";
  if (captchaSuspected || /VERIFYCODE/i.test(finalUrl))
    return "captcha_suspected";
  if (/ERR\.LOGIN\.PASSERR/.test(finalUrl)) return "password_error";
  if (/ERR\.LOGIN/.test(finalUrl)) return "login_rejected";
  return "unknown";
}

/**
 * 完整登录流程：POST → 跟随重定向链 → 落地 main.jsp?sid=…
 * 成功时返回会话信息（sid、接口同源地址、Cookie 罐）
 */
async function login(creds) {
  const jar = new CookieJar();
  const hops = [];

  const body = buildLoginBody(creds);
  let resp = await httpRequest({
    url: LOGIN_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": UA,
    },
    body,
  });
  jar.absorb(resp.setCookie);
  hops.push({ status: resp.status, location: resp.location });

  let currentUrl = resp.location
    ? new URL(resp.location, LOGIN_ENDPOINT).href
    : null;
  for (let i = 0; currentUrl && i < MAX_REDIRECTS; i++) {
    resp = await httpRequest({
      url: currentUrl,
      headers: { "User-Agent": UA, Cookie: jar.header() },
    });
    jar.absorb(resp.setCookie);
    hops.push({ status: resp.status, url: currentUrl, location: resp.location });
    if (resp.status === 200) break;
    currentUrl = resp.location ? new URL(resp.location, currentUrl).href : null;
  }

  const finalUrl = hops.at(-1)?.url ?? LOGIN_ENDPOINT;
  const success = resp.status === 200 && SUCCESS_URL_PATTERN.test(finalUrl);
  const sid = finalUrl.match(/sid=([^&]+)/)?.[1] ?? null;
  return {
    success,
    resp,
    finalUrl,
    hops,
    jar,
    sid,
    apiOrigin: new URL(finalUrl).origin,
  };
}

/** 节点可用性预检：经当前选中节点访问测试地址，2xx/3xx 即可用 */
async function testNode() {
  try {
    const resp = await httpRequest({
      url: CLASH_TEST_URL,
      timeoutMs: NODE_TEST_TIMEOUT_MS,
    });
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  }
}

/**
 * 收件箱反馈：调用 mbox:listMessages 取最新一封邮件的发送日期（与网页端显示一致）
 */
async function fetchInboxFeedback({ sid, apiOrigin, jar }) {
  const body = buildListBody();
  const resp = await httpRequest({
    url: `${apiOrigin}/js6/s?sid=${sid}&func=mbox:listMessages`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": UA,
      Cookie: jar.header(),
    },
    body,
  });
  const parsed = parseListResponse(resp.text);
  return { httpStatus: resp.status, ...parsed };
}

/**
 * 查询出口 IP。viaProxy=false 时临时绕过隧道走直连（用于防直连校验）。
 * 依次尝试多个探测端点，全部失败返回 null。
 */
async function getEgressIp(viaProxy = true) {
  const saved = PROXY_URL;
  if (!viaProxy) PROXY_URL = "";
  try {
    const endpoints = ["https://api.ipify.org", "https://ipinfo.io/ip"];
    for (const url of endpoints) {
      try {
        const resp = await httpRequest({ url, timeoutMs: 6000 });
        const ip = resp.text.trim();
        if (ip) return ip;
      } catch {
        // 换下一个探测端点
      }
    }
  } finally {
    PROXY_URL = saved;
  }
  return null;
}

/** 本机直连出口，只查一次（同一次运行里结果稳定） */
let directEgressCache;
async function getDirectEgress() {
  if (directEgressCache === undefined) {
    directEgressCache = await getEgressIp(false);
  }
  return directEgressCache;
}

/** 查询当前线路的出口 IP；失败返回空串，不影响登录 */
async function queryEgress() {
  try {
    const resp = await httpRequest({
      url: "https://api.ipify.org",
      timeoutMs: 6000,
    });
    return resp.text.trim();
  } catch {
    return "";
  }
}

/**
 * 防直连：经节点出口与本机直连出口相同，说明流量其实没走代理，按用户要求终止。
 * mihomo 配置里没有 DIRECT 规则，正常情况下两者必然不同。
 */
async function checkNotDirect(tunnelEgress) {
  const direct = await getDirectEgress();
  if (tunnelEgress && direct && tunnelEgress === direct) {
    log(
      "❌ 代理未生效：经节点出口与本机直连出口相同，流量疑似直连。按要求终止本次运行。",
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function main() {
  const creds = parseCredentials();
  installScrubber(creds);
  log("== 邮箱保活开始 ==");
  runStarted = true;
  let mihomo = null;
  try {
    if (creds.subUrl) {
      // 给定订阅链接：自动管理 mihomo 生命周期
      mihomo = await startMihomo(creds.subUrl);
    }
    await runKeepalive(creds);
  } finally {
    // 无论成败，登录流程结束后立即关闭内核与日志流，避免句柄挂住进程
    if (mihomo) mihomo.cleanup();
  }
}

async function runKeepalive(creds) {
  const plan = await resolveNodePlan();
  if (!plan.length) {
    console.error("没有可用节点（节点筛选未匹配或无法读取节点列表），本次未登录。");
    process.exitCode = 1;
    return;
  }
  for (let i = 0; i < plan.length; i++) {
    const node = plan[i];
    if (node) {
      if (!(await selectNode(node))) continue;
      log(`尝试节点 (${i + 1}/${plan.length}): ${node}`);
      // 先用外网连通性预检节点，坏节点直接跳过，不拿它去碰邮箱登录
      if (!(await testNode())) {
        log("节点可用性测试未通过（无法访问外网），跳过该节点");
        continue;
      }
      // 先核对实际出口：同时对照本机直连出口，防止"看似走了节点、实际直连"
      const egress = await queryEgress();
      if (egress) {
        const direct = await getDirectEgress();
        log(
          `本次登录出口 IP: ${maskIp(egress)}` +
            (direct ? `（本机直连出口 ${maskIp(direct)}）` : ""),
        );
        if (!(await checkNotDirect(egress))) return;
      }
    } else if (PROXY_URL) {
      // 手工指定 HTTPS_PROXY 或节点列表读取失败：用当前默认节点登录，先做一次防直连校验
      const egress = await queryEgress();
      log(`代理出口 IP: ${maskIp(egress)}（登录将以该 IP 出站）`);
      if (!(await checkNotDirect(egress))) return;
    }
    let result;
    try {
      result = await login(creds);
    } catch (err) {
      // 网络/隧道类错误：换下一条线路
      log(`登录请求异常: ${scrub(String(err.message ?? err))}`);
      continue;
    }
    if (!result.success) {
      const captcha = looksLikeCaptcha(result.resp.text);
      const reason = classifyFailure(result.finalUrl, captcha);
      log(
        `未登录成功（${reason}），最终落地: ${sanitizeUrl(result.finalUrl)}（HTTP ${result.resp.status}）`,
      );
      log(
        "重定向链:",
        JSON.stringify(
          result.hops.map((h) => ({
            status: h.status,
            location: sanitizeUrl(h.location ?? ""),
          })),
        ),
      );
      // 密码错误/登录拒绝/短信二次验证在什么线路都一样；直连模式触发验证码，换线路也无用
      if (
        reason === "password_error" ||
        reason === "login_rejected" ||
        reason === "risk_2fa_sms" ||
        (reason === "captcha_suspected" && !PROXY_URL)
      ) {
        log(
          `${reason} 为确定性失败，停止后续线路。` +
            (reason === "risk_2fa_sms"
              ? "（网易要求向绑定手机发送短信验证码，无法自动化；建议改用自托管 runner/本地定时任务走受信任的家庭宽带 IP）"
              : ""),
        );
        process.exitCode = 1;
        return;
      }
      continue; // 代理模式下触发验证码 → 切换下一个节点
    }

    log("登录成功 ✓（服务端已记录一次登录使用）");
    log("会话地址:", sanitizeUrl(result.finalUrl));

    // 收件箱反馈：确认 sid 会话真实可用（只读日期元数据，不读邮件内容）
    let feedback;
    try {
      feedback = await fetchInboxFeedback(result);
    } catch (err) {
      log(
        `登录成功，但收件箱反馈请求异常: ${scrub(String(err.message ?? err))}。` +
          "保活可能已完成，请人工确认（节点不稳或接口变更）。",
      );
      process.exitCode = 1;
      return;
    }
    if (
      feedback.code === "S_OK" &&
      feedback.total >= 0 &&
      (feedback.total === 0 || feedback.sentDate)
    ) {
      if (feedback.total === 0) {
        resultEmailDate = "";
        log("收件箱校验: 收件箱为空——会话确认有效 ✓");
      } else {
        resultEmailDate = feedback.sentDate;
        log(
          `收件箱校验: 最新一封邮件日期: ${feedback.sentDate}——会话确认有效 ✓`,
        );
      }
      log("== 保活完成，退出码 0 ==");
      return;
    }
    log(
      `登录成功，但收件箱反馈异常：HTTP ${feedback.httpStatus}，code=${feedback.code}。` +
        "保活可能已完成，请人工确认（接口可能变更）。",
    );
    process.exitCode = 1;
    return;
  }
  console.error(
    `保活失败：${plan.length} 条线路均未成功登录。请检查密码/代理节点是否可用。`,
  );
  process.exitCode = 1;
}

main().catch((err) => {
  // 兜底：不让未捕获异常把堆栈（可能带本机路径）直接甩进日志
  console.error(`运行异常: ${scrub(String(err?.message ?? err))}`);
  process.exitCode = 1;
});
