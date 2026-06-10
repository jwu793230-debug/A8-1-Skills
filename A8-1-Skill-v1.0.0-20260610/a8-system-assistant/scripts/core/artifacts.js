"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const skillRoot = path.resolve(__dirname, "..", "..");
const runtimeRoot = path.join(skillRoot, "runtime");
const currentRoot = path.join(runtimeRoot, "current");
const historyRoot = path.join(runtimeRoot, "history");
const tempRoot = path.join(runtimeRoot, "temp");

function sanitizeSegment(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function formatTimestampForPath(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}-${mi}-${ss}`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function createRunContext({ flow = "unknown", label = "" } = {}) {
  const timestamp = formatTimestampForPath();
  const slug = [sanitizeSegment(flow), sanitizeSegment(label)]
    .filter(Boolean)
    .join("-");
  const runName = slug ? `${timestamp}-${slug}` : `${timestamp}-${sanitizeSegment(flow)}`;
  const currentRunRoot = path.join(currentRoot, runName);
  const historyRunRoot = path.join(historyRoot, runName);
  const screenshotsDir = path.join(currentRunRoot, "screenshots");
  const htmlDir = path.join(currentRunRoot, "html");

  await ensureDir(runtimeRoot);
  await ensureDir(currentRoot);
  await ensureDir(historyRoot);
  await ensureDir(tempRoot);
  await ensureDir(currentRunRoot);
  await ensureDir(historyRunRoot);
  await ensureDir(screenshotsDir);
  await ensureDir(htmlDir);

  return {
    flow,
    label,
    timestamp,
    runName,
    skillRoot,
    runtimeRoot,
    currentRoot,
    historyRoot,
    tempRoot,
    runRoot: currentRunRoot,
    historyRunRoot,
    screenshotsDir,
    htmlDir,
    requestPath: path.join(currentRunRoot, "request.json"),
    resultPath: path.join(currentRunRoot, "result.json"),
    errorPath: path.join(currentRunRoot, "error.json"),
  };
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, String(text ?? ""), "utf8");
}

async function writeHtml(runContext, name, html) {
  const filePath = path.join(runContext.htmlDir, `${sanitizeSegment(name) || "page"}.html`);
  await writeText(filePath, html);
  return filePath;
}

async function writeRequest(runContext, request) {
  await writeJson(runContext.requestPath, request);
}

async function writeResult(runContext, result) {
  await writeJson(runContext.resultPath, result);
}

async function writeError(runContext, error) {
  await writeJson(runContext.errorPath, error);
}

module.exports = {
  skillRoot,
  runtimeRoot,
  currentRoot,
  historyRoot,
  tempRoot,
  sanitizeSegment,
  formatTimestampForPath,
  ensureDir,
  createRunContext,
  writeJson,
  writeText,
  writeHtml,
  writeRequest,
  writeResult,
  writeError,
};
