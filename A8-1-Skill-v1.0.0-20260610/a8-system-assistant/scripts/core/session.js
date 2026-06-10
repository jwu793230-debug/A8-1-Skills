"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const {
  launchEdge,
  connectToFirstPageTarget,
  closeBrowserSession,
  waitForFile,
  sleep,
} = require("./browser");

const baseUrl = "https://a8.uni-ubi.com";
const loginPageUrl = `${baseUrl}/seeyon/main.do?method=index`;
const loginPostUrl = `${baseUrl}/seeyon/main.do?method=login`;
const indexOpenWindowUrl = `${baseUrl}/seeyon/indexOpenWindow.jsp`;
const mainUrl = `${baseUrl}/seeyon/main.do?method=main`;

const username = process.env.SEEYON_USERNAME;
const password = process.env.SEEYON_PASSWORD;

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  addFromResponse(response) {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const entry of setCookies) {
      const first = entry.split(";")[0];
      const index = first.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
    }
  }

  toHeader() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  toCookieArray() {
    return [...this.cookies.entries()].map(([name, value]) => ({ name, value }));
  }
}

function requireCredentials() {
  if (!username || !password) {
    throw new Error("Missing SEEYON_USERNAME or SEEYON_PASSWORD");
  }
  return { username, password };
}

async function request(url, options, jar) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    Accept: "*/*",
    ...options.headers,
  };
  const cookieHeader = jar.toHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });
  jar.addFromResponse(response);
  const body = await response.text();
  return { response, body };
}

async function requestJson(url, options, jar) {
  const result = await request(url, options, jar);
  let json = null;
  try {
    json = JSON.parse(result.body);
  } catch (_error) {
    json = null;
  }
  return {
    ...result,
    json,
  };
}

function extractSecuritySeed(html) {
  const match = String(html || "").match(/var\s+_SecuritySeed\s*=\s*'([^']*)'/);
  if (!match) throw new Error("Unable to locate _SecuritySeed");
  return match[1];
}

async function loadCryptoJs(scriptDir) {
  const source = await fs.readFile(path.join(scriptDir, "..", "legacy", "crypto.js"), "utf8");
  const context = { CryptoJS: undefined, window: {}, self: {}, global: {}, navigator: {} };
  context.window = context;
  context.self = context;
  context.global = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "crypto.js" });
  if (!context.CryptoJS) {
    throw new Error("CryptoJS failed to load");
  }
  return context.CryptoJS;
}

async function loginWithHttp({ scriptDir }) {
  const creds = requireCredentials();
  const jar = new CookieJar();
  const cryptoJs = await loadCryptoJs(scriptDir);

  const loginPage = await request(
    loginPageUrl,
    { method: "GET", headers: { Accept: "text/html,*/*" } },
    jar
  );
  const securitySeed = extractSecuritySeed(loginPage.body);
  const encryptedPassword = cryptoJs.DES.encrypt(
    cryptoJs.enc.Utf8.parse(creds.password),
    securitySeed
  ).toString();

  const form = new URLSearchParams({
    authorization: "",
    "login.timezone": "GMT+8:0",
    province: "",
    city: "",
    redirect_url: "",
    token_login_app_id: "",
    token_login_third_user_id: "",
    request_auth_authenticator: "",
    rectangle: "",
    login_username: creds.username,
    trustdo_type: "",
    login_validatePwdStrength: "4",
    selGroup: "",
    phone_number: "",
    login_smsVerifyCode: "",
    random: "",
    fontSize: "12",
    screenWidth: "1920",
    screenHeight: "1080",
    login_password: encryptedPassword,
  });

  const loginResult = await request(
    loginPostUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Origin: baseUrl,
        Referer: loginPageUrl,
      },
      body: form.toString(),
    },
    jar
  );

  if (![301, 302].includes(loginResult.response.status)) {
    throw new Error(`Login failed with status ${loginResult.response.status}`);
  }

  await request(indexOpenWindowUrl, { method: "GET", headers: { Referer: loginPageUrl } }, jar);
  await request(mainUrl, { method: "GET", headers: { Referer: indexOpenWindowUrl } }, jar);
  const sessionCheck = await request(
    `${baseUrl}/seeyon/main.do?method=index`,
    { method: "GET", headers: { Referer: mainUrl, Accept: "text/html,*/*" } },
    jar
  );
  const checkBody = String(sessionCheck.body || "");
  const alertText = checkBody.match(/alert\(["']([\s\S]*?)["']\)/)?.[1] || "";
  if (/login_username|login_password|_SecuritySeed/i.test(checkBody)) {
    throw new Error(
      `A8 login session validation failed: login page returned${
        alertText ? ` (${alertText})` : ""
      }`
    );
  }
  if (/被迫下线|服务器失去连接|method=logout/i.test(checkBody)) {
    throw new Error(
      `A8 login session validation failed: offline page returned${
        alertText ? ` (${alertText})` : ""
      }`
    );
  }

  return {
    baseUrl,
    jar,
    cookies: jar.toCookieArray(),
  };
}

async function writePngFromBase64(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from(data || "", "base64"));
  return filePath;
}

async function captureCdpScreenshot(cdp, filePath, options = {}) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    ...options,
  });
  return writePngFromBase64(filePath, result.data);
}

async function captureVisibleCaptcha(cdp, artifactsDir, state, label = "captcha-visible") {
  const captcha = state?.visibleCaptcha;
  if (!captcha?.rect?.width || !captcha?.rect?.height) return null;
  const filePath = path.join(artifactsDir, `${label}.png`);
  await captureCdpScreenshot(cdp, filePath, {
    clip: {
      x: Math.max(0, captcha.rect.x - 8),
      y: Math.max(0, captcha.rect.y - 8),
      width: Math.max(1, captcha.rect.width + 16),
      height: Math.max(1, captcha.rect.height + 16),
      scale: 1,
    },
  }).catch(() => null);
  return filePath;
}

async function resolveBrowserVerifyCode({ artifactsDir, reason, onStage = async () => {} } = {}) {
  const directCode = String(process.env.A8_LOGIN_VERIFY_CODE || "").trim();
  if (directCode) {
    await onStage({ stage: "browser-form-login-captcha-code-source", source: "env" });
    return directCode;
  }

  const codeFile = process.env.A8_LOGIN_VERIFY_FILE || path.join(artifactsDir, "captcha-code.txt");
  const waitMs = Number(process.env.A8_LOGIN_VERIFY_WAIT_MS || 120000);
  const readme = [
    "A8 登录页出现验证码。",
    "请查看同目录下的 captcha-visible.png，识别后把验证码写入本文件旁边的 captcha-code.txt。",
    "脚本会读取 captcha-code.txt 的第一行并重新提交登录。",
    "",
    `等待文件：${codeFile}`,
    `等待时长：${waitMs} ms`,
    `触发原因：${reason || "browser-login-captcha"}`,
  ].join("\n");
  await fs.writeFile(path.join(artifactsDir, "captcha-code.README.txt"), readme, "utf8");
  await onStage({
    stage: "browser-form-login-captcha-waiting-for-code",
    codeFile,
    waitMs,
    reason,
  });

  if (!Number.isFinite(waitMs) || waitMs <= 0) return "";
  const content = await waitForFile(codeFile, waitMs).catch(() => "");
  const code = String(content || "").split(/\r?\n/)[0].trim();
  if (code) {
    await onStage({ stage: "browser-form-login-captcha-code-source", source: "file", codeFile });
  }
  return code;
}

async function readBrowserLoginState(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const info = (node) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          id: node.id || "",
          name: node.getAttribute("name") || "",
          type: node.getAttribute("type") || "",
          className: String(node.getAttribute("class") || ""),
          src: node.getAttribute("src") || "",
          placeholder: node.getAttribute("placeholder") || "",
          text: clean(node.innerText || node.textContent).slice(0, 300),
          visible: visible(node),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      };
      const loginUsername = document.querySelector("#login_username, input[name='login_username']");
      const password = document.querySelector("#login_password1, input[name='login_password1'], input[type='password']");
      const loginError = document.querySelector("#login_error, .login_error");
      const captchaNodes = Array.from(document.querySelectorAll(
        ".captcha, .captcha *, #VerifyCode, input[id*='Verify'], input[name*='Verify'], img[src*='verify'], img[src*='Verify'], img[src*='random'], img[src*='captcha'], img[src*='validate'], img[src*='Validate']"
      )).map(info).filter(Boolean);
      const visibleCaptcha = captchaNodes.find((item) => item.visible && item.rect.width > 0 && item.rect.height > 0) || null;
      return {
        ok: true,
        url: location.href,
        title: document.title,
        bodyText: clean(document.body ? document.body.innerText : "").slice(0, 1500),
        hasLoginUsername: Boolean(loginUsername),
        hasPassword: Boolean(password),
        loginError: loginError ? info(loginError) : null,
        captchaNodes,
        visibleCaptcha,
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, error: "login-state-empty" };
}

async function submitBrowserLoginForm(cdp, creds, verifyCode = "") {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const setValue = (selectors, value) => {
        const node = selectors
          .split(",")
          .map((selector) => document.querySelector(selector.trim()))
          .find(Boolean);
        if (!node) return false;
        node.focus();
        node.value = value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      const clickFirst = (selectors) => {
        const node = selectors
          .split(",")
          .map((selector) => document.querySelector(selector.trim()))
          .find(Boolean);
        if (!node) return false;
        node.click();
        return true;
      };
      const usernameSet = setValue("#login_username, input[name='login_username']", ${JSON.stringify(creds.username)});
      const passwordSet = setValue("#login_password1, input[name='login_password1'], input[type='password']", ${JSON.stringify(creds.password)});
      let verifySet = false;
      const verifyCode = ${JSON.stringify(String(verifyCode || "").trim())};
      if (verifyCode) {
        verifySet = setValue("#VerifyCode, input[name='VerifyCode'], input[id*='Verify'], input[name*='Verify']", verifyCode);
      }
      const clicked = clickFirst("#login_button, #submit_button, input[type='submit'], .login_button");
      if (!clicked) {
        const password = document.querySelector("#login_password1, input[name='login_password1'], input[type='password']");
        if (password) {
          password.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
          password.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }));
        }
      }
      return { ok: Boolean(usernameSet && passwordSet && clicked), usernameSet, passwordSet, verifySet, clicked };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, error: "submit-login-empty" };
}

async function waitForBrowserLoginOutcome(cdp, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readBrowserLoginState(cdp).catch((error) => ({
      ok: false,
      error: String(error),
    }));
    const url = String(lastState?.url || "");
    const bodyText = String(lastState?.bodyText || "");
    if (!lastState?.hasLoginUsername && (/main\.do\?method=main/i.test(url) || /个人空间|单位空间|待发事项|新建事项/.test(bodyText))) {
      return { ok: true, state: lastState };
    }
    await sleep(intervalMs);
  }
  return { ok: false, state: lastState, error: "browser-login-outcome-timeout" };
}

async function loginWithBrowserForm({
  runRoot,
  profileDir,
  headless = true,
  onStage = async () => {},
} = {}) {
  const creds = requireCredentials();
  const artifactsDir = path.join(runRoot || process.cwd(), "browser-login");
  const loginProfileDir = profileDir || path.join(runRoot || process.cwd(), "browser-login-profile");
  let edge = null;
  let session = null;
  try {
    await onStage({ stage: "browser-form-login-launch-start", profileDir: loginProfileDir });
    edge = await launchEdge({
      profileDir: loginProfileDir,
      startUrl: loginPageUrl,
      headless,
    });
    session = {
      edge,
      ...(await connectToFirstPageTarget(edge.port)),
    };
    const cdp = session.cdp;
    await sleep(2000);
    const beforeState = await readBrowserLoginState(cdp);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactsDir, "01-login-before-submit.json"),
      JSON.stringify(beforeState, null, 2),
      "utf8"
    );
    await captureCdpScreenshot(cdp, path.join(artifactsDir, "01-login-before-submit.png"));
    await onStage({ stage: "browser-form-login-before-submit", state: beforeState });

    let verifyCode = process.env.A8_LOGIN_VERIFY_CODE || "";
    if (!verifyCode && beforeState?.visibleCaptcha) {
      await captureVisibleCaptcha(cdp, artifactsDir, beforeState, "captcha-visible");
      verifyCode = await resolveBrowserVerifyCode({
        artifactsDir,
        reason: "captcha-visible-before-submit",
        onStage,
      });
    }

    const submitResult = await submitBrowserLoginForm(
      cdp,
      creds,
      verifyCode
    );
    await onStage({ stage: "browser-form-login-submit", submitResult });
    let outcome = await waitForBrowserLoginOutcome(cdp, {
      timeoutMs: Number(process.env.A8_BROWSER_LOGIN_TIMEOUT_MS || 30000),
    });
    let afterState = outcome.state || await readBrowserLoginState(cdp);
    await fs.writeFile(
      path.join(artifactsDir, "02-login-after-submit.json"),
      JSON.stringify({ outcome, afterState }, null, 2),
      "utf8"
    );
    await captureCdpScreenshot(cdp, path.join(artifactsDir, "02-login-after-submit.png"));

    if (!outcome.ok && afterState?.visibleCaptcha) {
      await captureVisibleCaptcha(cdp, artifactsDir, afterState, "captcha-visible");
      const retryVerifyCode = await resolveBrowserVerifyCode({
        artifactsDir,
        reason: "captcha-visible-after-submit",
        onStage,
      });
      if (retryVerifyCode) {
        const retrySubmitResult = await submitBrowserLoginForm(cdp, creds, retryVerifyCode);
        await onStage({
          stage: "browser-form-login-captcha-retry-submit",
          submitResult: retrySubmitResult,
        });
        outcome = await waitForBrowserLoginOutcome(cdp, {
          timeoutMs: Number(process.env.A8_BROWSER_LOGIN_TIMEOUT_MS || 30000),
        });
        afterState = outcome.state || await readBrowserLoginState(cdp);
        await fs.writeFile(
          path.join(artifactsDir, "03-login-after-captcha-submit.json"),
          JSON.stringify({ outcome, afterState }, null, 2),
          "utf8"
        );
        await captureCdpScreenshot(cdp, path.join(artifactsDir, "03-login-after-captcha-submit.png"));
      }
    }

    if (!outcome.ok) {
      const message = afterState?.loginError?.text || afterState?.bodyText || outcome.error || "";
      throw new Error(
        `A8 browser form login failed${message ? `: ${message}` : ""}. Artifacts: ${artifactsDir}`
      );
    }

    const cookiesResult = await cdp.send("Network.getAllCookies").catch(() => ({ cookies: [] }));
    const cookies = (cookiesResult.cookies || [])
      .filter((cookie) => /a8\.uni-ubi\.com|uni-ubi\.com/i.test(String(cookie.domain || "")))
      .map((cookie) => ({ name: cookie.name, value: cookie.value }));
    if (!cookies.length) {
      throw new Error(`A8 browser form login succeeded but no A8 cookies were captured. Artifacts: ${artifactsDir}`);
    }

    return {
      baseUrl,
      cookies,
      loginMethod: "browser-form",
      artifactsDir,
      outcome,
    };
  } finally {
    if (session) {
      await closeBrowserSession(session);
    } else if (edge) {
      await closeBrowserSession({ edge });
    }
  }
}

async function injectCookiesToCdp(cdp, cookies, base = baseUrl) {
  for (const cookie of cookies || []) {
    await cdp.send("Network.setCookie", {
      url: base,
      name: cookie.name,
      value: cookie.value,
    });
  }
}

module.exports = {
  baseUrl,
  loginPageUrl,
  loginPostUrl,
  indexOpenWindowUrl,
  mainUrl,
  CookieJar,
  requireCredentials,
  request,
  requestJson,
  extractSecuritySeed,
  loadCryptoJs,
  loginWithHttp,
  loginWithBrowserForm,
  injectCookiesToCdp,
};
