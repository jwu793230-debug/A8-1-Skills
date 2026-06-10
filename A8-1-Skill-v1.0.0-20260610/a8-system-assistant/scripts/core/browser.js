"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { ensureDir } = require("./artifacts");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectEdgePath() {
  const candidates = [
    process.env.A8_BROWSER_PATH,
    process.env.A8_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.A8_EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates[0] || "";
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (_error) {
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function requestLocalJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      const handlers = this.eventHandlers.get(message.method) || [];
      for (const handler of handlers) {
        try {
          handler(message.params || {});
        } catch (_error) {
          // Ignore observer failures.
        }
      }
    });
  }

  send(method, params = {}, options = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeoutMs =
        options.timeoutMs ?? Number(process.env.A8_CDP_TIMEOUT_MS || 30000);
      const timeout =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  async close() {
    if (!this.ws) return;
    await new Promise((resolve) => {
      this.ws.addEventListener("close", resolve, { once: true });
      this.ws.close();
    });
  }
}

async function launchEdge({ profileDir, startUrl = "about:blank", headless = true } = {}) {
  const edgePath = detectEdgePath();
  if (!edgePath) {
    throw new Error("Microsoft Edge executable not found");
  }
  await ensureDir(profileDir);
  await fs.unlink(path.join(profileDir, "DevToolsActivePort")).catch(() => {});
  const args = [
    headless ? "--headless=new" : "",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    startUrl,
  ].filter(Boolean);

  const child = spawn(edgePath, args, {
    stdio: "ignore",
    windowsHide: true,
  });

  const devtoolsInfo = await waitForFile(path.join(profileDir, "DevToolsActivePort"), 15000);
  const [portLine] = String(devtoolsInfo).trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid DevTools port: ${portLine}`);
  }
  return { child, port, edgePath, profileDir };
}

async function getPageTargets(port) {
  return requestLocalJson(`http://127.0.0.1:${port}/json/list`);
}

async function connectToFirstPageTarget(port) {
  const targets = await getPageTargets(port);
  const pageTarget = targets.find(
    (target) => target.type === "page" && !String(target.url || "").startsWith("edge://")
  );
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error("Unable to find Edge page target");
  }
  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  cdp.dialogMessages = [];
  cdp.on("Page.javascriptDialogOpening", async (params) => {
    cdp.dialogMessages.push(params?.message || "");
    try {
      await cdp.send("Page.handleJavaScriptDialog", { accept: true }, { timeoutMs: 1000 });
    } catch (_error) {
      // Ignore close races; the caller can inspect cdp.dialogMessages.
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  return { cdp, pageTarget, targets };
}

async function killProcessTree(pid) {
  if (!pid) return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
}

async function closeBrowserSession(session) {
  if (session?.cdp) {
    try {
      await session.cdp.close();
    } catch (_error) {
      // Ignore close failures.
    }
  }
  if (session?.edge?.child?.pid) {
    await killProcessTree(session.edge.child.pid);
  }
}

module.exports = {
  sleep,
  detectEdgePath,
  waitForFile,
  requestLocalJson,
  CdpClient,
  launchEdge,
  getPageTargets,
  connectToFirstPageTarget,
  killProcessTree,
  closeBrowserSession,
};
