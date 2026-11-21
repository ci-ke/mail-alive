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
 * 凭据两种方式（任选其一，切勿写死在代码里）：
 *   1. 命令行参数（本地调试方便，cmd / PowerShell / bash 语法一致）：
 *        node keepalive.mjs <完整邮箱地址> <登录密码>
 *      注意：参数可能留在 shell 历史记录与进程列表中
 *   2. 环境变量（GitHub Actions 用 Secrets 注入，推荐）：
 *        MAIL_USERNAME  完整邮箱地址，例如 user@your.domain
 *        MAIL_PASSWORD  登录密码
 *
 * 本地运行示例：
 *   node keepalive.mjs you@your.domain your-password
 */

import https from "node:https";
import { URL } from "node:url";

const LOGIN_ENDPOINT = "https://entryhz.qiye.163.com/domain/domainEntLogin";
/** 登录成功的判定：最终落地在 webmail 主页面且带 sid 会话参数 */
const SUCCESS_URL_PATTERN = /\/js6\/main\.jsp\?.*sid=/;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_REDIRECTS = 8;
const LOGIN_RETRY_TOTAL = 3;
const RETRY_BACKOFF_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 全局日志脱敏：公有仓库的 Actions 日志对所有人可见，凡是可能带出账号/域名/密码/sid
 * 的输出一律打码（覆盖 URL 编码形式，如 uid=user%40your.domain）。
 */
let scrub = (text) => String(text ?? "");
function installScrubber({ account, domain, password }) {
  const tokens = [`${account}@${domain}`, account, domain, password]
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function httpRequest({ url, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers,
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
}

function parseCredentials() {
  // 凭据来源：命令行参数优先（本地调试方便），其次环境变量（GitHub Actions 注入）
  const [argUser, argPass] = process.argv.slice(2);
  const username = (argUser ?? process.env.MAIL_USERNAME)?.trim();
  const password = argPass ?? process.env.MAIL_PASSWORD;
  if (!username || !password) {
    console.error(
      "缺少凭据：可用命令行参数 node keepalive.mjs <邮箱地址> <密码>，" +
        "或环境变量 MAIL_USERNAME / MAIL_PASSWORD",
    );
    process.exit(2);
  }
  const sep = username.lastIndexOf("@");
  if (sep < 1) {
    console.error("MAIL_USERNAME 应为完整邮箱地址，例如 user@your.domain");
    process.exit(2);
  }
  return {
    account: username.slice(0, sep),
    domain: username.slice(sep + 1),
    password,
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

/** 确定性失败：重试只会增加错误计数、加深风控，应当立即停止 */
const NO_RETRY_REASONS = new Set([
  "password_error",
  "captcha_suspected",
  "login_rejected",
]);

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
  for (let attempt = 1; attempt <= LOGIN_RETRY_TOTAL; attempt++) {
    try {
      const result = await login(creds);
      if (!result.success) {
        const captcha = looksLikeCaptcha(result.resp.text);
        const reason = classifyFailure(result.finalUrl, captcha);
        log(
          `第 ${attempt}/${LOGIN_RETRY_TOTAL} 次尝试未登录成功（${reason}），最终落地: ${sanitizeUrl(result.finalUrl)}（HTTP ${result.resp.status}）`,
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
        if (NO_RETRY_REASONS.has(reason)) {
          // 密码错误/触发验证码等确定性失败：重试只会增加错误计数，立即停止
          log(`${reason} 为确定性失败，不再重试（重试会加重风控）。`);
          process.exitCode = 1;
          return;
        }
        if (attempt < LOGIN_RETRY_TOTAL) await sleep(RETRY_BACKOFF_MS * attempt);
        continue;
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
    } catch (err) {
      log(
        `第 ${attempt}/${LOGIN_RETRY_TOTAL} 次尝试异常: ${scrub(String(err.message ?? err))}`,
      );
      if (attempt < LOGIN_RETRY_TOTAL) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  console.error(
    "保活失败：三次重试后仍未成功登录。请检查密码是否失效/是否触发风控。",
  );
  process.exitCode = 1;
}

main();
