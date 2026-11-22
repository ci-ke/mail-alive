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
 * 运行记录：本脚本只负责向控制台输出，GitHub Actions workflow 会把输出
 * 重定向到仓库根目录的 result.txt（每次运行覆盖）并提交进仓库——最新输出
 * 在文件里，历史输出留在 git 提交记录里。
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
 * mihomo 提供），脚本按订阅节点列表逐个切换登录线路；某节点触发风控验证码
 * 或网络错误则换下一个，直到成功或试完。HTTPS 是端到端加密隧道，代理只能
 * 看到目标域名，看不到密码与邮件内容。
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
 * 当前目录 ./mihomo(.exe) → /usr/local/bin/mihomo）：生成临时配置、启动内核、
 * 等订阅加载、按节点轮询登录、退出时自动关闭内核。配置与订阅内容只写入
 * 系统临时目录，不会进入当前目录/仓库。
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
import { URL } from "node:url";

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
const CLASH_MAX_NODES = Math.max(1, Number(process.env.CLASH_MAX_NODES || 8));
// 自动管理 mihomo 时的监听端口（默认与常见 clash 一致；本机端口冲突时可改）
const CLASH_MIXED_PORT = Number(process.env.CLASH_MIXED_PORT || 7890);
const CLASH_CONTROLLER_PORT = Number(process.env.CLASH_CONTROLLER_PORT || 9090);
/** 订阅中常见的信息类条目，不是真实代理节点，跳过 */
const NODE_NAME_BLACKLIST =
  /^(官网|套餐|剩余|到期|流量|重置|发布|订阅|更新|官址)/i;

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

/** 打码 sid，避免把会话凭据泄进 CI 日志 */
function sanitizeUrl(url) {
  return String(url ?? "").replace(/(sid=)[^&]+/i, "$1<masked>");
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
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () =>
        resolve(tlsSocket),
      );
      tlsSocket.once("error", reject);
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
 * 计算本次运行的"线路"计划：
 *   - 未配代理 → [null]（直连）
 *   - 配了 HTTPS_PROXY 但无 CLASH_API → [null]（走代理默认节点）
 *   - 配了 HTTPS_PROXY + CLASH_API → 最多 CLASH_MAX_NODES 个节点，供逐个切换
 */
async function resolveNodePlan() {
  if (!PROXY_URL || !CLASH_API) return [null];
  let group;
  try {
    group = await clashRequest({
      path: `/proxies/${encodeURIComponent(CLASH_GROUP)}`,
    });
  } catch (err) {
    log(`读取 clash 节点列表失败: ${err.message}——将使用当前默认节点`);
    return [null];
  }
  const nodes = (group?.all ?? []).filter(
    (n) => !NODE_NAME_BLACKLIST.test(n),
  );
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

function httpRequest({ url, method = "GET", headers = {}, body = null }) {
  const target = new URL(url);
  return (async () => {
    let tunnelSocket = null;
    if (PROXY_URL) {
      tunnelSocket = await connectThroughProxy(
        PROXY_URL,
        target.hostname,
        Number(target.port) || 443,
      );
    }
    return await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method,
          headers,
          agent: false,
          ...(tunnelSocket ? { createConnection: () => tunnelSocket } : {}),
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
      req.setTimeout(REQUEST_TIMEOUT_MS, () =>
        req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）: ${url}`)),
      );
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });
  })();
}

const USAGE = `用法: node keepalive.mjs [-u <邮箱>] [-p <密码>] [-s <clash订阅链接>]
      （兼容位置参数: node keepalive.mjs <邮箱> <密码> [订阅链接]）

选项:
  -u, --username <邮箱>   完整邮箱地址（环境变量 MAIL_USERNAME 兜底）
  -p, --password <密码>   登录密码（环境变量 MAIL_PASSWORD 兜底）
  -s, --sub-url <链接>    clash 订阅链接；传入后自动管理 mihomo（CLASH_SUB_URL 兜底）
  -h, --help              显示本帮助

其他调优项（环境变量）: CLASH_MAX_NODES / CLASH_GROUP / MIHOMO_BIN /
CLASH_MIXED_PORT / CLASH_CONTROLLER_PORT
注意: 命令行参数可能留在 shell 历史记录与进程列表中，介意就用环境变量。`;

/** 命名参数（argparse 风格）为主，位置参数向后兼容，环境变量兜底 */
function parseCli() {
  try {
    return parseArgs({
      options: {
        username: { type: "string", short: "u" },
        password: { type: "string", short: "p" },
        "sub-url": { type: "string", short: "s" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`参数错误: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

function parseCredentials() {
  const { values, positionals } = parseCli();
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const [posUser, posPass, posSub] = positionals;
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

async function main() {
  const creds = parseCredentials();
  installScrubber(creds);
  log("== 邮箱保活开始 ==");
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
  for (let i = 0; i < plan.length; i++) {
    const node = plan[i];
    if (node) {
      if (!(await selectNode(node))) continue;
      log(`尝试节点 (${i + 1}/${plan.length}): ${node}`);
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
      // 密码错误/登录拒绝在什么线路都一样；直连模式触发验证码，换线路也无用
      if (
        reason === "password_error" ||
        reason === "login_rejected" ||
        (reason === "captcha_suspected" && !PROXY_URL)
      ) {
        log(`${reason} 为确定性失败，停止后续线路。`);
        process.exitCode = 1;
        return;
      }
      continue; // 代理模式下触发验证码 → 切换下一个节点
    }

    log("登录成功 ✓（服务端已记录一次登录使用）");
    log("会话地址:", sanitizeUrl(result.finalUrl));

    // 收件箱反馈：确认 sid 会话真实可用（只读日期元数据，不读邮件内容）
    const feedback = await fetchInboxFeedback(result);
    if (
      feedback.code === "S_OK" &&
      feedback.total >= 0 &&
      (feedback.total === 0 || feedback.sentDate)
    ) {
      if (feedback.total === 0) {
        log("收件箱校验: 收件箱为空——会话确认有效 ✓");
      } else {
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

main();
