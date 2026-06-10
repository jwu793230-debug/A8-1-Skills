"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const baseUrl = "https://a8.uni-ubi.com";
const loginUrl = `${baseUrl}/seeyon/main.do?method=index`;
const initApplyUrl =
  `${baseUrl}/seeyon/collaboration/collaboration.do?method=newColl` +
  `&from=bizconfig` +
  `&firstName=%E8%81%8C%E8%83%BD%E7%B1%BB` +
  `&secondName=%E9%9B%86%E6%88%90%E9%A1%B9%E7%9B%AE%E7%AB%8B%E9%A1%B9%E7%94%B3%E8%AF%B7` +
  `&menuId=1504114103205580015` +
  `&templateId=671804392642006097` +
  `&showTab=true&showTab=true`;

const projectRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(projectRoot, "runtime");
const username = process.env.SEEYON_USERNAME || "";
const password = process.env.SEEYON_PASSWORD || "";
const chromePath =
  process.env.A8_CHROME_PATH ||
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const traceLevelName = normalizeTraceLevel(process.env.A8_TRACE_LEVEL || process.env.A8_RUN_MODE || "fast");
const traceRank = { fast: 0, normal: 1, debug: 2 }[traceLevelName];
const configuredWaitScale = Number.parseFloat(process.env.A8_WAIT_SCALE || "");
const shouldObserveMaterialPicker =
  process.argv.includes("--material-picker") ||
  process.argv.includes("--select-material") ||
  process.argv.includes("--save-draft") ||
  /^(1|true|yes)$/i.test(process.env.A8_OBSERVE_MATERIAL_PICKER || "");
const shouldSelectMaterial =
  process.argv.includes("--select-material") ||
  process.argv.includes("--fill-material") ||
  process.argv.includes("--save-draft") ||
  /^(1|true|yes)$/i.test(process.env.A8_SELECT_MATERIAL || "");
const shouldFillMaterial =
  process.argv.includes("--fill-material") ||
  process.argv.includes("--save-draft") ||
  /^(1|true|yes)$/i.test(process.env.A8_FILL_MATERIAL || "");
const shouldSaveDraft =
  process.argv.includes("--save-draft") ||
  /^(1|true|yes)$/i.test(process.env.A8_SAVE_DRAFT || "");
const linkedCreateNo = process.env.A8_LINKED_CREATE_NO || "";
const linkedCreateSearchInputIndex = Number.parseInt(
  process.env.A8_LINKED_CREATE_SEARCH_INPUT_INDEX || "1",
  10
);
const materialSearchInputIndex = Number.parseInt(
  process.env.A8_MATERIAL_SEARCH_INPUT_INDEX || "1",
  10
);
const baseFieldValues = {
  buildUnit: process.env.A8_BUILD_UNIT || "",
  constructionUnit: process.env.A8_CONSTRUCTION_UNIT || "",
  needDelivery: process.env.A8_NEED_DELIVERY || "",
  priceSystem: process.env.A8_PRICE_SYSTEM || "",
  softwareConfirm: process.env.A8_SOFTWARE_CONFIRM || "",
  supervisionNeed: process.env.A8_SUPERVISION_NEED || "",
  business: process.env.A8_BUSINESS || "",
  industry: process.env.A8_INDUSTRY || "",
};
const shouldFillBaseFields =
  process.argv.includes("--fill-base-fields") ||
  Object.values(baseFieldValues).some(Boolean);
const shouldSelectLinkedCreate =
  !!linkedCreateNo &&
  (process.argv.includes("--link-create") ||
    process.argv.includes("--fill-material") ||
    process.argv.includes("--save-draft") ||
    /^(1|true|yes)$/i.test(process.env.A8_LINK_CREATE || ""));
const targetMaterialNo = process.env.A8_MATERIAL_NO || "";
const targetQuantity = process.env.A8_MATERIAL_QTY || "";
const targetTaxPrice = process.env.A8_MATERIAL_TAX_PRICE || "";
const materialItems = parseMaterialItems();
const materialItemWarnings = collectMaterialItemWarnings(materialItems);

function parseMaterialItems() {
  const raw =
    process.env.A8_MATERIAL_ITEMS_JSON ||
    (process.env.A8_MATERIAL_ITEMS_JSON_FILE
      ? fsSync.readFileSync(path.resolve(process.env.A8_MATERIAL_ITEMS_JSON_FILE), "utf8")
      : "");
  if (!raw) {
    return targetMaterialNo || targetQuantity || targetTaxPrice
      ? [
          {
            code: targetMaterialNo,
            qty: targetQuantity,
            taxPrice: targetTaxPrice,
          },
        ]
      : [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid A8_MATERIAL_ITEMS_JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("A8_MATERIAL_ITEMS_JSON must be a non-empty array");
  }
  return parsed.map((item, index) => {
    const code = String(item.code || item.materialNo || item.material || "").trim();
    const qty = String(item.qty ?? item.quantity ?? "").trim();
    const taxPrice = String(item.taxPrice ?? item.tax_price ?? item.price ?? "").trim();
    const allowBlankCode = !code || boolish(item.allowBlankCode) || boolish(item.blankCode) || boolish(item.skipMaterialPicker);
    const allowBlankQty = !qty || boolish(item.allowBlankQty) || boolish(item.blankQty) || boolish(item.allowBlankValues);
    const allowBlankTaxPrice = !taxPrice || boolish(item.allowBlankTaxPrice) || boolish(item.blankTaxPrice) || boolish(item.allowBlankValues);
    return {
      code,
      qty,
      taxPrice,
      source: item.source || item.sourceRow || item.excelRow || item.excel_row || "",
      sourceRows: Array.isArray(item.sourceRows) ? item.sourceRows : [],
      label: item.label || item.device || item.productName || code || `row-${index + 1}`,
      allowBlankCode,
      allowBlankQty,
      allowBlankTaxPrice,
    };
  });
}

function boolish(value) {
  return /^(1|true|yes|y)$/i.test(String(value || ""));
}

function collectMaterialItemWarnings(items) {
  const warnings = [];
  const byCode = new Map();
  items.forEach((item, index) => {
    if (item.code) {
      const bucket = byCode.get(item.code) || [];
      bucket.push({ index: index + 1, source: item.source || item.sourceRows?.join(",") || "" });
      byCode.set(item.code, bucket);
    }
    const blankFields = [];
    if (!item.code) blankFields.push("material code");
    if (!item.qty) blankFields.push("quantity");
    if (!item.taxPrice) blankFields.push("tax price");
    if (blankFields.length) {
      warnings.push({
        type: "blank-fields-preserved",
        index: index + 1,
        source: item.source || item.sourceRows?.join(",") || "",
        label: item.label,
        code: item.code,
        blankFields,
        action: "Row is kept; blank fields are left blank for manual review after wait-send save.",
      });
    }
  });
  for (const [code, rows] of byCode.entries()) {
    if (rows.length > 1) {
      warnings.push({
        type: "duplicate-material-code-preserved",
        code,
        rows,
        action: "Duplicate rows are kept as separate A8 detail rows unless the user explicitly asks to merge.",
      });
    }
  }
  return warnings;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeTraceLevel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["fast", "normal", "debug"].includes(normalized) ? normalized : "fast";
}

function traceAt(level) {
  return traceRank >= { fast: 0, normal: 1, debug: 2 }[level];
}

function isErrorArtifactName(name) {
  return /error|missing|failed|fail|not-found|option-missing/i.test(String(name || ""));
}

function shouldWriteArtifact(filePath, options = {}) {
  if (options.critical) return true;
  const name = path.basename(filePath);
  if (/^(result|error)\.json$/i.test(name)) return true;
  if (/save-draft-responses|save-draft-main-state/i.test(name)) return true;
  if (isErrorArtifactName(name)) return true;
  return traceAt(options.level || "normal");
}

function scaledWaitMs(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return ms;
  const scale =
    Number.isFinite(configuredWaitScale) && configuredWaitScale > 0
      ? configuredWaitScale
      : traceLevelName === "debug"
        ? 1
        : traceLevelName === "normal"
          ? 0.8
          : 0.45;
  const cap = traceLevelName === "fast" ? 5000 : numeric;
  const floor = numeric <= 1000 ? 300 : 500;
  return Math.min(numeric, cap, Math.max(floor, Math.ceil(numeric * scale)));
}

function installTraceHooks(page) {
  const originalWaitForTimeout = page.waitForTimeout.bind(page);
  page.waitForTimeout = async (ms, ...args) => originalWaitForTimeout(scaledWaitMs(ms), ...args);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value, options = {}) {
  if (!shouldWriteArtifact(filePath, options)) return;
  await fs.writeFile(filePath, JSON.stringify(value, null, options.compact ? 0 : 2), "utf8");
}

async function writeText(filePath, value, options = {}) {
  if (!shouldWriteArtifact(filePath, options)) return;
  await fs.writeFile(filePath, String(value || ""), "utf8");
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1000 }))) {
        await locator.click({ timeout: 3000 });
        return selector;
      }
    } catch (_error) {
      // Try the next selector.
    }
  }
  return "";
}

function optionTextVariants(text) {
  return [...new Set([text, text.replace(/--+/g, "-"), text.replace(/-/g, "--")])].filter(Boolean);
}

function scoreOptionBox(box, nearBox) {
  if (!nearBox || !box) {
    return 0;
  }
  const verticalDistance = Math.max(0, box.y - (nearBox.y + nearBox.height));
  const horizontalDistance = Math.abs(box.x - nearBox.x);
  const narrowPenalty = box.width < 60 ? 200 : 0;
  return verticalDistance + horizontalDistance * 0.2 + narrowPenalty;
}

async function clickExactVisibleText(scopes, text, options = {}) {
  const variants = optionTextVariants(text);
  const matches = [];
  for (const scope of scopes) {
    for (const variant of variants) {
      const locator = scope.getByText(variant, { exact: true });
      const count = Math.min(await locator.count().catch(() => 0), 30);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        try {
          if (await candidate.isVisible({ timeout: 500 })) {
            const box = await candidate.boundingBox().catch(() => null);
            if (options.nearBox && box) {
              const belowField = box.y >= options.nearBox.y + options.nearBox.height - 5;
              const closeVertically = box.y <= options.nearBox.y + options.nearBox.height + 360;
              const overlapsHorizontally =
                Math.min(box.x + box.width, options.nearBox.x + options.nearBox.width + 80) -
                  Math.max(box.x, options.nearBox.x - 80) >
                0;
              if (!belowField || !closeVertically || !overlapsHorizontally) {
                continue;
              }
            }
            matches.push({
              candidate,
              text: variant,
              scope: scope.constructor?.name || "unknown",
              index,
              box,
              score: scoreOptionBox(box, options.nearBox),
            });
          }
        } catch (_error) {
          // Try the next matched text node.
        }
      }
    }
  }
  matches.sort((left, right) => left.score - right.score);
  const best = matches[0];
  if (best) {
    await best.candidate.click({ timeout: 3000 });
    return {
      text: best.text,
      scope: best.scope,
      index: best.index,
      box: best.box,
    };
  }
  return null;
}

async function login(page, runDir) {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  if (traceAt("normal")) {
    await page.screenshot({ path: path.join(runDir, "01-login-page.png"), fullPage: true });
  }
  await writeText(path.join(runDir, "01-login-page.html"), await page.content());

  const userField = page.locator("#login_username, input[name='login_username']").first();
  const passwordField = page.locator("#login_password1, input[name='login_password1'], input[type='password']").first();

  if ((await userField.count()) === 0 || (await passwordField.count()) === 0) {
    return { alreadyLoggedIn: true, url: page.url() };
  }
  if (!username || !password) {
    throw new Error("Missing SEEYON_USERNAME or SEEYON_PASSWORD");
  }

  await userField.fill(username);
  await passwordField.fill(password);
  const clicked = await clickFirstVisible(page, [
    "#login_button",
    "#submit_button",
    "input[type='submit']",
    "button:has-text('登录')",
    "a:has-text('登录')",
    ".login_button",
  ]);
  if (!clicked) {
    await passwordField.press("Enter");
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const stillLogin = (await page.locator("#login_username, input[name='login_username']").count()) > 0;
  if (traceAt("normal")) {
    await page.screenshot({ path: path.join(runDir, "02-after-login.png"), fullPage: true });
  }
  await writeText(path.join(runDir, "02-after-login.html"), await page.content());

  return {
    alreadyLoggedIn: false,
    clicked,
    stillLogin,
    url: page.url(),
    title: await page.title().catch(() => ""),
  };
}

async function summarizeFrame(frame) {
  return frame.evaluate(() => {
    function textOf(node) {
      return (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    }
    const buttons = [...document.querySelectorAll("a,button,input[type='button'],input[type='submit']")]
      .slice(0, 200)
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        name: el.getAttribute("name") || "",
        type: el.getAttribute("type") || "",
        className: el.className || "",
        text: textOf(el).slice(0, 80),
        value: el.getAttribute("value") || "",
        visible:
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
          getComputedStyle(el).visibility !== "hidden" &&
          getComputedStyle(el).display !== "none",
      }));
    const inputs = [...document.querySelectorAll("input,textarea,select")]
      .slice(0, 300)
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        name: el.getAttribute("name") || "",
        type: el.getAttribute("type") || "",
        title: el.getAttribute("title") || "",
        placeholder: el.getAttribute("placeholder") || "",
        value: el.tagName === "SELECT" ? el.value : (el.getAttribute("value") || el.value || "").slice(0, 120),
        visible:
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
          getComputedStyle(el).visibility !== "hidden" &&
          getComputedStyle(el).display !== "none",
      }));
    const text = textOf(document.body).slice(0, 6000);
    const tables = [...document.querySelectorAll("table")]
      .slice(0, 80)
      .map((table, index) => ({
        index,
        id: table.id || "",
        className: table.className || "",
        text: textOf(table).slice(0, 600),
      }));
    return {
      title: document.title,
      url: location.href,
      text,
      buttons,
      inputs,
      tables,
      hasSaveDraft: /保存待发|saveDraft/i.test(document.body.innerText || document.body.textContent || ""),
      hasMaterialText: /料号|物料|整机外购件|含税单价|数量/.test(document.body.innerText || document.body.textContent || ""),
    };
  }).catch((error) => ({ error: String(error), url: frame.url() }));
}

async function collectVisibleFieldMap(frame) {
  return frame.evaluate(() => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    function textOf(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }
    function rectOf(el) {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        cx: Math.round(r.x + r.width / 2),
        cy: Math.round(r.y + r.height / 2),
      };
    }
    return [...document.querySelectorAll("input,textarea,select")]
      .filter((el) => isVisible(el))
      .map((el, index) => {
        const rect = rectOf(el);
        const td = el.closest("td");
        const tr = el.closest("tr");
        const cells = tr ? [...tr.children].map((cell) => textOf(cell)).filter(Boolean) : [];
        const holder = el.closest("[id],[class]");
        return {
          index,
          tag: el.tagName,
          id: el.id || "",
          name: el.getAttribute("name") || "",
          type: el.getAttribute("type") || "",
          className: String(el.className || ""),
          value: el.value || el.getAttribute("value") || "",
          readonly: el.hasAttribute("readonly"),
          disabled: el.disabled || false,
          rect,
          tdText: td ? textOf(td).slice(0, 200) : "",
          rowCells: cells.slice(0, 12),
          holder: holder
            ? {
                tag: holder.tagName,
                id: holder.id || "",
                className: String(holder.className || ""),
                text: textOf(holder).slice(0, 200),
              }
            : null,
        };
      });
  });
}

async function collectVisibleElementMap(frame) {
  return frame.evaluate(() => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    function textOf(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }
    function rectOf(el) {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        cx: Math.round(r.x + r.width / 2),
        cy: Math.round(r.y + r.height / 2),
      };
    }
    return [...document.querySelectorAll("*")]
      .filter((el) => isVisible(el))
      .map((el, index) => {
        const text = textOf(el);
        const rect = rectOf(el);
        return {
          index,
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className || ""),
          title: el.getAttribute("title") || "",
          role: el.getAttribute("role") || "",
          text: text.slice(0, 180),
          rect,
        };
      })
      .filter((item) => {
        const key = item.text + item.title + item.className + item.id;
        const usefulClass = /browse|relation|select|field|append|icon|cap4|el-input|multi/i.test(key);
        const inFormTop = item.rect.y >= 130 && item.rect.y <= 500;
        return inFormTop && (usefulClass || item.text);
      })
      .slice(0, 400);
  });
}

async function observeInitApply(page, runDir) {
  const network = [];
  page.on("requestfinished", async (request) => {
    const url = request.url();
    if (!/seeyon|cap4|collaboration|form/i.test(url)) return;
    const response = await request.response().catch(() => null);
    network.push({
      method: request.method(),
      url,
      status: response?.status() || null,
      resourceType: request.resourceType(),
    });
  });

  await page.goto(initApplyUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  if (traceAt("normal")) {
    await page.screenshot({ path: path.join(runDir, "03-init-apply-page.png"), fullPage: true });
  }
  await writeText(path.join(runDir, "03-init-apply-page.html"), await page.content());

  const frameSummaries = [];
  for (const frame of page.frames()) {
    frameSummaries.push({
      name: frame.name(),
      url: frame.url(),
      summary: await summarizeFrame(frame),
    });
  }
  await writeJson(path.join(runDir, "04-frame-summaries.json"), frameSummaries);
  await writeJson(path.join(runDir, "05-network-summary.json"), network);
  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  if (zwFrame) {
    await writeJson(path.join(runDir, "06-visible-field-map.json"), await collectVisibleFieldMap(zwFrame));
    await writeJson(path.join(runDir, "07-visible-element-map.json"), await collectVisibleElementMap(zwFrame));
  }

  const likelyFrames = frameSummaries.filter((item) => {
    const summary = item.summary || {};
    return summary.hasSaveDraft || summary.hasMaterialText || /newColl|form|cap4/i.test(item.url || "");
  });

  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    frameCount: page.frames().length,
    likelyFrames: likelyFrames.map((item) => ({
      name: item.name,
      url: item.url,
      hasSaveDraft: item.summary?.hasSaveDraft || false,
      hasMaterialText: item.summary?.hasMaterialText || false,
      inputCount: item.summary?.inputs?.length || 0,
      buttonCount: item.summary?.buttons?.length || 0,
    })),
    artifactDir: runDir,
  };
}

async function captureAllFrames(page, runDir, prefix) {
  const errorArtifact = isErrorArtifactName(prefix);
  if (!traceAt("normal") && !errorArtifact) {
    return [];
  }
  await page.screenshot({ path: path.join(runDir, `${prefix}-page.png`), fullPage: true });
  if (traceAt("debug")) {
    await writeText(path.join(runDir, `${prefix}-page.html`), await page.content(), { critical: true });
  }
  const frameSummaries = [];
  for (const frame of page.frames()) {
    frameSummaries.push({
      name: frame.name(),
      url: frame.url(),
      summary: await summarizeFrame(frame),
    });
  }
  await writeJson(path.join(runDir, `${prefix}-frame-summaries.json`), frameSummaries, {
    critical: errorArtifact,
  });
  return frameSummaries;
}

async function observeMaterialPicker(page, runDir) {
  const beforeFrames = page.frames().map((frame) => ({
    name: frame.name(),
    url: frame.url(),
  }));
  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  if (!zwFrame) {
    throw new Error("zwIframe not found before material picker observation");
  }

  const clickableCandidates = await zwFrame.evaluate(() => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    function textOf(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }
    return [...document.querySelectorAll("*")]
      .filter((el) => isVisible(el))
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        className: String(el.className || ""),
        text: textOf(el).slice(0, 80),
        role: el.getAttribute("role") || "",
        title: el.getAttribute("title") || "",
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })(),
      }))
      .filter((item) => /插入整机外购件|产品编号|报价清单|料号|物料/.test(item.text + item.title))
      .slice(0, 120);
  });
  await writeJson(path.join(runDir, "06-material-clickable-candidates.json"), clickableCandidates);

  let clickResult = null;
  const textLocator = zwFrame.getByText("插入整机外购件", { exact: true }).first();
  if ((await textLocator.count()) > 0) {
    await textLocator.click({ timeout: 5000 });
    clickResult = { method: "frame.getByText", text: "插入整机外购件" };
  } else {
    const candidate = clickableCandidates.find((item) => item.text === "插入整机外购件");
    if (!candidate) {
      throw new Error("Unable to locate 插入整机外购件 in visible frame candidates");
    }
    await zwFrame.page().mouse.click(
      candidate.rect.x + candidate.rect.width / 2,
      candidate.rect.y + candidate.rect.height / 2
    );
    clickResult = { method: "mouse", candidate };
  }

  await page.waitForTimeout(5000);
  const afterFrames = page.frames().map((frame) => ({
    name: frame.name(),
    url: frame.url(),
  }));
  const summaries = await captureAllFrames(page, runDir, "07-after-material-picker-click");
  const pickerLikeFrames = summaries
    .filter((item) => {
      const text = item.summary?.text || "";
      return /查询|搜索|物料|产品编号|整机外购件|确定|取消|选择|料号/.test(text);
    })
    .map((item) => ({
      name: item.name,
      url: item.url,
      text: (item.summary?.text || "").slice(0, 1200),
      visibleInputs: (item.summary?.inputs || []).filter((input) => input.visible).slice(0, 80),
      visibleButtons: (item.summary?.buttons || []).filter((button) => button.visible).slice(0, 80),
    }));
  await writeJson(path.join(runDir, "08-picker-like-frames.json"), pickerLikeFrames);

  return {
    clickResult,
    beforeFrames,
    afterFrames,
    frameCountDelta: afterFrames.length - beforeFrames.length,
    pickerLikeFrames,
  };
}

async function extractVisibleTextRows(frame, pattern) {
  return frame.evaluate((source) => {
    const regex = new RegExp(source);
    function isVisible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    function textOf(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }
    return [...document.querySelectorAll("tr,.cap4-table-row,.el-table__row,[class*='row']")]
      .filter((el) => isVisible(el))
      .map((el) => ({ tag: el.tagName, className: String(el.className || ""), text: textOf(el) }))
      .filter((item) => regex.test(item.text))
      .slice(0, 80);
  }, pattern);
}

async function clickFirstVisibleInFrame(frame, selectors) {
  for (const selector of selectors) {
    const locator = frame.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1000 }))) {
        await locator.click({ timeout: 3000 });
        return selector;
      }
    } catch (_error) {
      // Try the next selector.
    }
  }
  return "";
}

async function closeMaterialPickerOverlays(page, runDir, label = "material-picker-close") {
  const result = await page.evaluate(() => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    const closed = [];
    const layers = [...document.querySelectorAll(".layui-layer")]
      .filter((layer) => isVisible(layer))
      .reverse();
    for (const layer of layers) {
      const close = layer.querySelector(".layui-layer-setwin a,[class*='layui-layer-close']");
      if (!close || !isVisible(close)) continue;
      close.click();
      closed.push({
        id: layer.id || "",
        className: String(layer.className || ""),
      });
    }
    return {
      attempted: layers.length,
      closed,
    };
  }).catch((error) => ({
    attempted: 0,
    closed: [],
    error: String(error),
  }));
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);
  await writeJson(path.join(runDir, `${label}.json`), result);
  return result;
}

function findMaterialPickerFrame(page) {
  return (
    page
      .frames()
      .find((frame) => /fieldId=field0062|relationShipId=-4922717543573076153/.test(frame.url())) ||
    page
      .frames()
      .find(
        (frame) =>
          /^layui-layer-iframe/.test(frame.name()) &&
          /type=relation|tpRelationList|relationShipId/.test(frame.url())
      )
  );
}

async function probeMaterialPickerFrame(frame, wantedInputIndex = materialSearchInputIndex) {
  if (!frame) {
    return { ok: false, error: "material-picker-frame-not-found" };
  }
  return frame
    .evaluate((inputIndex) => {
      function isVisible(el) {
        const style = getComputedStyle(el);
        return (
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      }
      function textOf(el) {
        return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      }
      const inputs = [...document.querySelectorAll("input[placeholder],textarea[placeholder]")]
        .filter((el) => isVisible(el) && el.type !== "hidden" && !el.disabled)
        .map((el, index) => ({
          index,
          tag: el.tagName,
          type: el.type || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: el.value || "",
          title: el.getAttribute("title") || "",
          className: String(el.className || ""),
        }));
      const buttons = [
        ...document.querySelectorAll("button,a,[role='button'],.cap4-condition-button__filter"),
      ]
        .filter((el) => isVisible(el))
        .map((el, index) => ({
          index,
          tag: el.tagName,
          text: textOf(el).slice(0, 80),
          title: el.getAttribute("title") || "",
          className: String(el.className || ""),
        }))
        .slice(0, 80);
      return {
        ok: inputs.length > inputIndex,
        href: location.href,
        readyState: document.readyState,
        text: textOf(document.body).slice(0, 800),
        inputCount: inputs.length,
        wantedInputIndex: inputIndex,
        buttonCount: buttons.length,
        inputs,
        buttons,
      };
    }, Number.isInteger(wantedInputIndex) ? wantedInputIndex : 1)
    .catch((error) => ({
      ok: false,
      error: String(error),
      href: frame.url(),
    }));
}

async function waitForMaterialPickerReady(
  page,
  runDir,
  { timeoutMs = traceLevelName === "fast" ? 16000 : 35000, artifactPrefix = "09" } = {}
) {
  const deadline = Date.now() + timeoutMs;
  const filterInputIndex = Number.isInteger(materialSearchInputIndex)
    ? materialSearchInputIndex
    : 1;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const pickerFrame = findMaterialPickerFrame(page);
    lastProbe = await probeMaterialPickerFrame(pickerFrame, filterInputIndex);
    if (lastProbe?.ok) {
      await writeJson(
        path.join(runDir, `${artifactPrefix}-material-picker-ready.json`),
        {
          frameName: pickerFrame.name(),
          frameUrl: pickerFrame.url(),
          probe: lastProbe,
        },
        { level: "debug" }
      );
      return { pickerFrame, probe: lastProbe };
    }
    await page.waitForTimeout(traceLevelName === "fast" ? 350 : 700);
  }

  await writeJson(
    path.join(runDir, `${artifactPrefix}-material-picker-not-ready.json`),
    lastProbe || {},
    { critical: true }
  );
  throw new Error("Material picker filter input not found after waiting");
}

function findLinkedCreatePickerFrame(page) {
  return (
    page
      .frames()
      .find(
        (frame) =>
          /^layui-layer-iframe/.test(frame.name()) &&
          /fieldId=field0014|mainSelector=field0014|relationShipId=-5059030683602435591/.test(
            frame.url()
          )
      ) ||
    page
      .frames()
      .find(
        (frame) =>
          /^layui-layer-iframe/.test(frame.name()) &&
          /type=relation|tpRelationList|relationShipId/.test(frame.url())
      )
  );
}

async function probeLinkedCreatePickerFrame(frame) {
  if (!frame) {
    return { ok: false, error: "linked-create-picker-frame-not-found" };
  }
  return frame
    .evaluate(() => {
      function isVisible(el) {
        const style = getComputedStyle(el);
        return (
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      }
      function textOf(el) {
        return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      }
      const inputs = [...document.querySelectorAll("input,textarea")]
        .filter((el) => isVisible(el) && el.type !== "hidden" && !el.disabled)
        .map((el, index) => ({
          index,
          tag: el.tagName,
          type: el.type || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: el.value || "",
          title: el.getAttribute("title") || "",
          className: String(el.className || ""),
        }));
      const buttons = [
        ...document.querySelectorAll("button,a,[role='button'],.cap4-condition-button__filter"),
      ]
        .filter((el) => isVisible(el))
        .map((el, index) => ({
          index,
          tag: el.tagName,
          text: textOf(el).slice(0, 80),
          title: el.getAttribute("title") || "",
          className: String(el.className || ""),
        }))
        .slice(0, 80);
      const rows = [
        ...document.querySelectorAll("tr,.cap4-table-row,.el-table__row,[class*='row']"),
      ]
        .filter((el) => isVisible(el))
        .map((el) => textOf(el))
        .filter(Boolean)
        .slice(0, 20);
      return {
        ok: inputs.length > 0,
        href: location.href,
        readyState: document.readyState,
        text: textOf(document.body).slice(0, 1000),
        inputCount: inputs.length,
        buttonCount: buttons.length,
        rowCount: rows.length,
        inputs,
        buttons,
        rows,
      };
    })
    .catch((error) => ({
      ok: false,
      error: String(error),
      href: frame.url(),
    }));
}

async function waitForLinkedCreatePickerReady(page, runDir, { timeoutMs = 35000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const pickerFrame = findLinkedCreatePickerFrame(page);
    lastProbe = await probeLinkedCreatePickerFrame(pickerFrame);
    if (lastProbe?.ok && lastProbe.inputCount > 0) {
      await writeJson(path.join(runDir, "08-linked-create-picker-ready.json"), {
        frameName: pickerFrame.name(),
        frameUrl: pickerFrame.url(),
        probe: lastProbe,
      });
      return { pickerFrame, probe: lastProbe };
    }
    await page.waitForTimeout(700);
  }

  await writeJson(path.join(runDir, "08-linked-create-picker-not-ready.json"), lastProbe || {});
  throw new Error("Linked-create picker filter input not found after waiting");
}

async function selectLinkedCreateAndObserve(page, runDir) {
  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  if (!zwFrame) {
    throw new Error("zwIframe not found before linked-create selection");
  }
  const relationIcon = zwFrame
    .locator("#field0014_id .cap4-text__relation, #field0014_id .cap-icon-zhubiaoxuanzeqi")
    .first();
  if ((await relationIcon.count()) === 0) {
    throw new Error("Linked-create relation icon not found");
  }

  await relationIcon.click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await captureAllFrames(page, runDir, "08-after-linked-create-picker-click");
  const { pickerFrame, probe: pickerReady } = await waitForLinkedCreatePickerReady(page, runDir);

  const filterInputs = pickerFrame.locator("input[placeholder]:visible, textarea[placeholder]:visible");
  const filterInputCount = await filterInputs.count();
  const filterInputIndex = Number.isInteger(linkedCreateSearchInputIndex)
    ? linkedCreateSearchInputIndex
    : 1;
  const actualFilterInputIndex =
    filterInputCount > filterInputIndex ? filterInputIndex : Math.max(0, filterInputCount - 1);
  await writeJson(path.join(runDir, "08-linked-create-picker-input-choice.json"), {
    requestedIndex: filterInputIndex,
    actualIndex: actualFilterInputIndex,
    inputCount: filterInputCount,
    pickerReady,
  });
  await filterInputs.nth(actualFilterInputIndex).fill(linkedCreateNo);
  const clickedFilter = await clickFirstVisibleInFrame(pickerFrame, [
    "button:has-text('筛选')",
    ".cap4-condition-button__filter",
    "button",
  ]);
  if (!clickedFilter) {
    await filterInputs.nth(actualFilterInputIndex).press("Enter").catch(() => {});
  }
  await page.waitForTimeout(2500);

  const matchedRows = await extractVisibleTextRows(
    pickerFrame,
    linkedCreateNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  await writeJson(path.join(runDir, "09-linked-create-search-matched-rows.json"), matchedRows);
  if (matchedRows.length === 0) {
    await captureAllFrames(page, runDir, "09-linked-create-search-no-match");
    throw new Error(`Linked-create row not found after filter: ${linkedCreateNo}`);
  }

  const checkboxCount = await pickerFrame.locator("input[type='checkbox']").count();
  if (checkboxCount >= 2) {
    await pickerFrame.locator("input[type='checkbox']").nth(1).click({ timeout: 5000 });
  } else {
    await pickerFrame.locator("tr,.v-easy-table-row").filter({ hasText: linkedCreateNo }).first().click({ timeout: 5000 });
  }
  await page.waitForTimeout(1000);
  await captureAllFrames(page, runDir, "09-linked-create-after-row-click");

  await page.locator("a:has-text('确定')").last().click({ timeout: 5000 });
  await page.waitForTimeout(8000);
  const summaries = await captureAllFrames(page, runDir, "10-after-linked-create-confirm");
  await writeJson(path.join(runDir, "10-after-linked-create-field-map.json"), await collectVisibleFieldMap(zwFrame));
  const zwSummary = summaries.find((item) => item.name === "zwIframe")?.summary || {};

  return {
    linkedCreateNo,
    matchedRows,
    formTextIncludesLinkedCreate: (zwSummary.text || "").includes(linkedCreateNo),
  };
}

async function selectFrameOption(page, frame, fieldSelector, value, fieldName, runDir) {
  if (!value) {
    return null;
  }

  const field = frame.locator(fieldSelector).first();
  if ((await field.count()) === 0) {
    throw new Error(`Base field not found: ${fieldName}`);
  }

  await field.scrollIntoViewIfNeeded().catch(() => {});
  await field.click({ timeout: 5000 });
  await page.waitForTimeout(800);

  const fieldBox = await field.boundingBox().catch(() => null);
  const clicked = await clickExactVisibleText([frame, page], value, { nearBox: fieldBox });
  if (!clicked) {
    await captureAllFrames(page, runDir, `11-base-field-option-missing-${fieldName}`);
    throw new Error(`Base field option not found: ${fieldName}=${value}`);
  }

  await page.waitForTimeout(800);
  return { fieldName, value, clicked };
}

async function fillProjectBaseFieldsAndObserve(page, runDir) {
  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  if (!zwFrame) {
    throw new Error("zwIframe not found before base-field fill");
  }

  const filled = [];
  const writableInputs = zwFrame.locator("input:visible:not([readonly])");
  if (baseFieldValues.buildUnit) {
    await writableInputs.nth(0).fill(baseFieldValues.buildUnit);
    filled.push({ fieldName: "buildUnit", value: baseFieldValues.buildUnit });
  }
  if (baseFieldValues.constructionUnit) {
    await writableInputs.nth(1).fill(baseFieldValues.constructionUnit);
    filled.push({
      fieldName: "constructionUnit",
      value: baseFieldValues.constructionUnit,
    });
  }

  const selected = [];
  selected.push(
    await selectFrameOption(
      page,
      zwFrame,
      "#field0024, #field0024_inner",
      baseFieldValues.needDelivery,
      "needDelivery",
      runDir
    )
  );
  selected.push(
    await selectFrameOption(
      page,
      zwFrame,
      "#field0090, #field0090_inner",
      baseFieldValues.priceSystem,
      "priceSystem",
      runDir
    )
  );
  selected.push(
    await selectFrameOption(
      page,
      zwFrame,
      "#field0089, #field0089_inner",
      baseFieldValues.softwareConfirm,
      "softwareConfirm",
      runDir
    )
  );
  selected.push(
    await selectFrameOption(
      page,
      zwFrame,
      "#field0028, .cap4-multiselect, .cap4-multi_select__input",
      baseFieldValues.supervisionNeed,
      "supervisionNeed",
      runDir
    )
  );
  selected.push(
    await selectFrameOption(
      page,
      zwFrame,
      "#field0131, #field0131_inner",
      baseFieldValues.business,
      "business",
      runDir
    )
  );
  selected.push(
    await selectFrameOption(
      page,
      zwFrame,
      "#field0135, #field0135_inner",
      baseFieldValues.industry,
      "industry",
      runDir
    )
  );

  await page.mouse.click(20, 20).catch(() => {});
  await page.waitForTimeout(1000);
  const fieldMap = await collectVisibleFieldMap(zwFrame);
  await writeJson(path.join(runDir, "11-after-base-field-fill-map.json"), fieldMap);
  await captureAllFrames(page, runDir, "11-after-base-field-fill");

  return {
    filled,
    selected: selected.filter(Boolean),
    fieldValues: fieldMap
      .filter((item) =>
        [
          "field0024_inner",
          "field0090_inner",
          "field0089_inner",
          "field0131_inner",
          "field0135_inner",
        ].includes(item.id)
      )
      .map((item) => ({ id: item.id, value: item.value })),
  };
}

async function selectMaterialAndObserve(page, runDir) {
  if (!shouldObserveMaterialPicker) {
    await observeMaterialPicker(page, runDir);
  }
  const pickerFrame = page.frames().find((frame) => frame.name() === "layui-layer-iframe1");
  if (!pickerFrame) {
    throw new Error("Material picker iframe not found");
  }

  const filterInputs = pickerFrame.locator("input[placeholder='搜索关键字']");
  if ((await filterInputs.count()) === 0) {
    throw new Error("Material picker filter input not found");
  }
  await filterInputs.nth(0).fill(targetMaterialNo);
  await pickerFrame.getByText("筛选", { exact: true }).click({ timeout: 5000 });
  await page.waitForTimeout(5000);

  const matchedRows = await extractVisibleTextRows(pickerFrame, targetMaterialNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  await writeJson(path.join(runDir, "09-material-search-matched-rows.json"), matchedRows);
  if (matchedRows.length === 0) {
    await captureAllFrames(page, runDir, "09-material-search-no-match");
    await closeMaterialPickerOverlays(page, runDir, "09-material-search-no-match-close");
    const warning = buildMaterialManualReviewWarning(
      { ...materialItems[0], code: targetMaterialNo },
      "material-not-found-in-picker",
      "Row is preserved and left for manual review in the wait-send draft."
    );
    return {
      skipped: true,
      reason: "material-not-found-in-picker",
      materialNo: targetMaterialNo,
      matchedRows,
      warning,
      warnings: [warning],
    };
  }

  const checkboxCount = await pickerFrame.locator("input[type='checkbox']").count();
  if (checkboxCount < 2) {
    throw new Error(`Expected row checkbox in picker, got ${checkboxCount}`);
  }
  await pickerFrame.locator("input[type='checkbox']").nth(1).click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await captureAllFrames(page, runDir, "10-after-material-checkbox");

  await page.locator("a:has-text('确定')").last().click({ timeout: 5000 });
  await page.waitForTimeout(8000);
  const summaries = await captureAllFrames(page, runDir, "11-after-material-confirm");
  const zwSummary = summaries.find((item) => item.name === "zwIframe")?.summary || {};

  const backfillRows = await page
    .frames()
    .find((frame) => frame.name() === "zwIframe")
    ?.evaluate(() => {
      function isVisible(el) {
        const style = getComputedStyle(el);
        return (
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      }
      function textOf(el) {
        return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      }
      return [...document.querySelectorAll("tr,.cap4-table-row,[class*='table'] [class*='row']")]
        .filter((el) => isVisible(el))
        .map((el) => textOf(el))
        .filter((text) => /WG_|090|产品编号|含税单价|数量/.test(text))
        .slice(0, 120);
    })
    .catch((error) => [`error: ${String(error)}`]);
  await writeJson(path.join(runDir, "12-backfill-visible-rows.json"), backfillRows);

  return {
    materialNo: targetMaterialNo,
    matchedRows,
    backfilledTextIncludesMaterial: (zwSummary.text || "").includes(targetMaterialNo),
    backfillRows,
  };
}

async function selectMaterialAndObserveStable(page, runDir, materialItem = materialItems[0], options = {}) {
  const materialNo = materialItem.code;
  if (!materialNo) {
    return {
      skipped: true,
      reason: "blank-material-code",
      label: materialItem.label || "",
    };
  }
  if (options.openPicker || !shouldObserveMaterialPicker) {
    await observeMaterialPicker(page, runDir);
  }
  const { pickerFrame, probe: pickerReady } = await waitForMaterialPickerReady(page, runDir, {
    artifactPrefix: options.artifactPrefix || "09",
  });

  const filterInputs = pickerFrame.locator("input[placeholder]:visible");
  const filterInputIndex = Number.isInteger(materialSearchInputIndex)
    ? materialSearchInputIndex
    : 1;
  const filterInputCount = await filterInputs.count();
  if (filterInputCount <= filterInputIndex) {
    await writeJson(
      path.join(
        runDir,
        options.artifactPrefix
          ? `${options.artifactPrefix}-material-picker-input-choice-failed.json`
          : "09-material-picker-input-choice-failed.json"
      ),
      {
        requestedIndex: filterInputIndex,
        inputCount: filterInputCount,
        pickerReady,
      },
      { critical: true }
    );
    throw new Error(`Material picker filter input index ${filterInputIndex} not found`);
  }

  await filterInputs.nth(filterInputIndex).fill(materialNo);
  const clickedFilter = await clickFirstVisibleInFrame(pickerFrame, [
    "button:has-text('筛选')",
    "button:has-text('绛涢€?)",
    ".cap4-condition-button__filter",
    "button",
  ]);
  if (!clickedFilter) {
    await filterInputs.nth(filterInputIndex).press("Enter").catch(() => {});
  }
  await page.waitForTimeout(5000);

  const matchedRows = await extractVisibleTextRows(
    pickerFrame,
    materialNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  await writeJson(
    path.join(runDir, options.artifactPrefix ? `${options.artifactPrefix}-material-search-matched-rows.json` : "09-material-search-matched-rows.json"),
    matchedRows
  );
  if (matchedRows.length === 0) {
    await captureAllFrames(page, runDir, options.artifactPrefix ? `${options.artifactPrefix}-material-search-no-match` : "09-material-search-no-match");
    await closeMaterialPickerOverlays(
      page,
      runDir,
      options.artifactPrefix ? `${options.artifactPrefix}-material-search-no-match-close` : "09-material-search-no-match-close"
    );
    const warning = buildMaterialManualReviewWarning(
      materialItem,
      "material-not-found-in-picker",
      "Row is preserved and left for manual review in the wait-send draft."
    );
    return {
      skipped: true,
      reason: "material-not-found-in-picker",
      materialNo,
      label: materialItem.label || "",
      matchedRows,
      warning,
      warnings: [warning],
    };
  }

  const checkboxCount = await pickerFrame.locator("input[type='checkbox']").count();
  if (checkboxCount < 2) {
    throw new Error(`Expected row checkbox in picker, got ${checkboxCount}`);
  }
  await pickerFrame.locator("input[type='checkbox']").nth(1).click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await captureAllFrames(page, runDir, "10-after-material-checkbox");

  const clickedConfirm = await clickFirstVisible(page, [
    "a:has-text('确定')",
    "button:has-text('确定')",
    "a:has-text('纭畾')",
    "button:has-text('纭畾')",
  ]);
  if (!clickedConfirm) {
    throw new Error("Material picker confirm button not found");
  }

  await page.waitForTimeout(8000);
  const summaries = await captureAllFrames(page, runDir, "11-after-material-confirm");
  const zwSummary = summaries.find((item) => item.name === "zwIframe")?.summary || {};

  const backfillRows = await page
    .frames()
    .find((frame) => frame.name() === "zwIframe")
    ?.evaluate(() => {
      function isVisible(el) {
        const style = getComputedStyle(el);
        return (
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      }
      function textOf(el) {
        return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      }
      return [...document.querySelectorAll("tr,.cap4-table-row,[class*='table'] [class*='row']")]
        .filter((el) => isVisible(el))
        .map((el) => textOf(el))
        .filter((text) => /WG_|090|浜у搧缂栧彿|产品编号|含税单价|数量/.test(text))
        .slice(0, 120);
    })
    .catch((error) => [`error: ${String(error)}`]);
  await writeJson(path.join(runDir, "12-backfill-visible-rows.json"), backfillRows);

  return {
    materialNo,
    matchedRows,
    backfilledTextIncludesMaterial: (zwSummary.text || "").includes(materialNo),
    backfillRows,
  };
}

async function readMaterialRowState(frame, materialNo, options = {}) {
  return frame.evaluate(({ code, rowIndex }) => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    function textOf(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }
    const allRows = [...document.querySelectorAll("tr,.cap4-table-row,[class*='table'] [class*='row']")]
      .filter((el) => isVisible(el));
    const formsonRows = [...document.querySelectorAll("tr.formson-line")].filter((el) => isVisible(el));
    const candidates = formsonRows.length ? formsonRows : allRows;
    const rows = code
      ? candidates.filter((el) => textOf(el).includes(code))
      : Number.isInteger(rowIndex) && rowIndex >= 0
        ? candidates.slice(rowIndex, rowIndex + 1)
        : [];
    return rows.map((row) => ({
      tag: row.tagName,
      className: String(row.className || ""),
      text: textOf(row),
      inputs: [...row.querySelectorAll("input,textarea,select")]
        .filter((el) => isVisible(el))
        .map((el, index) => {
          const rect = el.getBoundingClientRect();
          return {
            index,
            tag: el.tagName,
            type: el.getAttribute("type") || "",
            id: el.id || "",
            className: String(el.className || ""),
            value: el.value || el.getAttribute("value") || "",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        }),
    }));
  }, { code: materialNo, rowIndex: options.rowIndex });
}

function buildMaterialManualReviewWarning(materialItem = {}, reason, action, extra = {}) {
  return {
    type: reason === "material-not-found-in-picker" ? "material-picker-no-match" : "material-manual-review",
    reason,
    source: materialItem.source || "",
    sourceRows: materialItem.sourceRows || [],
    sourceRow: materialItem.sourceRow || "",
    label: materialItem.label || "",
    code: materialItem.code || "",
    quantity: materialItem.qty ?? "",
    taxPrice: materialItem.taxPrice ?? "",
    inputCount: extra.inputCount ?? null,
    action,
  };
}

function isBlankMaterialValue(value) {
  return String(value ?? "").trim() === "";
}

function isSourceOnlyMaterialItem(item = {}) {
  return (
    item.allowBlankCode &&
    item.allowBlankQty &&
    item.allowBlankTaxPrice &&
    isBlankMaterialValue(item.code) &&
    isBlankMaterialValue(item.qty) &&
    isBlankMaterialValue(item.taxPrice)
  );
}

async function observeMaterialManualReviewRow(page, runDir, materialItem = {}, options = {}) {
  const beforeFile = options.artifactPrefix
    ? `${options.artifactPrefix}-material-row-before-fill.json`
    : "13-material-row-before-fill.json";
  const afterFile = options.artifactPrefix
    ? `${options.artifactPrefix}-material-row-after-fill.json`
    : "14-material-row-after-fill.json";
  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  if (!zwFrame) {
    throw new Error("zwIframe not found before observing manual-review material row");
  }
  const row = zwFrame.locator("tr.formson-line").nth(options.rowIndex || 0);
  const inputCount = (await row.count()) > 0
    ? await row.locator("input:visible:not([readonly])").count()
    : 0;
  const rowState = await readMaterialRowState(zwFrame, "", { rowIndex: options.rowIndex });
  await writeJson(path.join(runDir, beforeFile), rowState);
  await writeJson(path.join(runDir, afterFile), rowState);
  const warning = buildMaterialManualReviewWarning(
    materialItem,
    options.reason || "material-manual-review",
    options.action || "Row is preserved and left for manual review in the wait-send draft.",
    { inputCount }
  );
  return {
    materialNo: materialItem.code || "",
    quantity: materialItem.qty ?? "",
    taxPrice: materialItem.taxPrice ?? "",
    inputCount,
    skipped: true,
    warning,
    warnings: [warning],
    rowState,
    rowStateText: rowState.map((item) => item.text).join("\n"),
  };
}

function numbersMatch(actual, expected) {
  const actualNumber = Number.parseFloat(String(actual || "").replace(/,/g, ""));
  const expectedNumber = Number.parseFloat(String(expected || "").replace(/,/g, ""));
  if (Number.isNaN(actualNumber) || Number.isNaN(expectedNumber)) {
    return String(actual || "").trim() === String(expected || "").trim();
  }
  return Math.abs(actualNumber - expectedNumber) < 0.0001;
}

function assertMaterialValues(materialItem, rowState) {
  const values = rowState.flatMap((row) => (row.inputs || []).map((input) => input.value));
  const shouldAssertQuantity = !(materialItem.allowBlankQty && String(materialItem.qty || "") === "");
  const shouldAssertTaxPrice = !(materialItem.allowBlankTaxPrice && String(materialItem.taxPrice || "") === "");
  const hasQuantity = !shouldAssertQuantity || values.some((value) => numbersMatch(value, materialItem.qty));
  const hasTaxPrice = !shouldAssertTaxPrice || values.some((value) => numbersMatch(value, materialItem.taxPrice));
  if (!hasQuantity || !hasTaxPrice) {
    throw new Error(
      `Material row sanity failed for ${materialItem.code || materialItem.label}: quantity=${materialItem.qty}, taxPrice=${materialItem.taxPrice}, values=${values.join("|")}`
    );
  }
}

async function fillMaterialValuesAndObserve(page, runDir, materialItem = materialItems[0], options = {}) {
  const materialNo = materialItem.code;
  const quantity = materialItem.qty;
  const taxPrice = materialItem.taxPrice;
  const beforeFile = options.artifactPrefix
    ? `${options.artifactPrefix}-material-row-before-fill.json`
    : "13-material-row-before-fill.json";
  const afterFile = options.artifactPrefix
    ? `${options.artifactPrefix}-material-row-after-fill.json`
    : "14-material-row-after-fill.json";
  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  if (!zwFrame) {
    throw new Error("zwIframe not found before filling material values");
  }
  const row = materialNo
    ? zwFrame.locator("tr").filter({ hasText: materialNo }).first()
    : zwFrame.locator("tr.formson-line").nth(options.rowIndex || 0);
  if ((await row.count()) === 0) {
    if (materialItem.allowBlankCode || materialItem.allowBlankQty || materialItem.allowBlankTaxPrice) {
      const warning = buildMaterialManualReviewWarning(
        materialItem,
        "material-row-not-found-for-partial-or-blank-row",
        "Expected A8 quote-list row was not found; source row is reported for manual review in the wait-send draft.",
        { inputCount: 0 }
      );
      await writeJson(path.join(runDir, beforeFile), []);
      await writeJson(path.join(runDir, afterFile), []);
      return {
        materialNo,
        quantity,
        taxPrice,
        inputCount: 0,
        skipped: true,
        warning,
        warnings: [warning],
        rowState: [],
        rowStateText: "",
      };
    }
    throw new Error(`Material row not found for filling: ${materialNo || materialItem.label || options.rowIndex}`);
  }
  const rowInputs = row.locator("input:visible:not([readonly])");
  const inputCount = await rowInputs.count();
  const beforeState = await readMaterialRowState(zwFrame, materialNo, { rowIndex: options.rowIndex });
  await writeJson(path.join(runDir, beforeFile), beforeState);
  if (inputCount < 2) {
    if (materialItem.allowBlankCode || materialItem.allowBlankQty || materialItem.allowBlankTaxPrice) {
      const warning = {
        type: "material-row-fill-skipped",
        reason: "insufficient-editable-inputs-for-blank-or-partial-row",
        source: materialItem.source || "",
        label: materialItem.label || "",
        code: materialItem.code || "",
        quantity,
        taxPrice,
        inputCount,
        action: "Row is preserved and left for manual review in the wait-send draft.",
      };
      await writeJson(path.join(runDir, afterFile), beforeState);
      return {
        materialNo,
        quantity,
        taxPrice,
        inputCount,
        skipped: true,
        warning,
        warnings: [warning],
        rowState: beforeState,
        rowStateText: beforeState.map((item) => item.text).join("\n"),
      };
    }
    throw new Error(`Expected at least 2 visible inputs in material row, got ${inputCount}`);
  }

  if (String(quantity || "").trim()) {
    await rowInputs.nth(0).fill(quantity);
    await rowInputs.nth(0).press("Tab").catch(() => {});
    await page.waitForTimeout(500);
  }
  if (String(taxPrice || "").trim()) {
    await rowInputs.nth(1).fill(taxPrice);
    await rowInputs.nth(1).press("Tab").catch(() => {});
    await page.waitForTimeout(3000);
  }

  const after = await readMaterialRowState(zwFrame, materialNo, { rowIndex: options.rowIndex });
  assertMaterialValues(materialItem, after);
  await writeJson(path.join(runDir, afterFile), after);
  if (!options.skipScreenshot) {
    await captureAllFrames(page, runDir, "15-after-material-fill");
  }
  return {
    materialNo,
    quantity,
    taxPrice,
    inputCount,
    rowState: after,
    rowStateText: after.map((item) => item.text).join("\n"),
  };
}

async function addProjectQuoteRow(page, runDir, rowIndex) {
  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  if (!zwFrame) {
    throw new Error("zwIframe not found before adding material row");
  }
  const newButton = zwFrame.getByText("新建", { exact: true }).first();
  if ((await newButton.count()) === 0) {
    await captureAllFrames(page, runDir, `material-${String(rowIndex).padStart(2, "0")}-new-row-button-missing`);
    throw new Error("Project quote-list New button not found");
  }
  try {
    await newButton.click({ timeout: 5000 });
  } catch (error) {
    await captureAllFrames(page, runDir, `material-${String(rowIndex).padStart(2, "0")}-new-row-click-blocked`);
    await closeMaterialPickerOverlays(page, runDir, `material-${String(rowIndex).padStart(2, "0")}-new-row-close-blocking-layer`);
    await newButton.click({ timeout: 5000 });
  }
  await page.waitForTimeout(2000);
  return { rowIndex, clicked: true };
}

async function processMaterialItemsAndObserve(page, runDir) {
  const results = [];
  for (let index = 0; index < materialItems.length; index += 1) {
    const item = materialItems[index];
    const artifactKey = String(item.code || item.label || `row-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, "_");
    const artifactPrefix = `material-${String(index + 1).padStart(2, "0")}-${artifactKey}`;
    const sourceOnly = isSourceOnlyMaterialItem(item);
    const sourceOnlyWarning = sourceOnly
      ? buildMaterialManualReviewWarning(
          item,
          "source-row-has-no-fillable-material-values",
          "Source row has no material code, quantity, or tax price; it was not added as an A8 quote-list row and is reported for manual review.",
          { inputCount: 0 }
        )
      : null;
    console.log(`material ${index + 1}/${materialItems.length}: ${item.code || item.label}`);
    const newRow = sourceOnly
      ? { skipped: true, reason: "source-row-has-no-fillable-material-values" }
      : index === 0
        ? null
        : await addProjectQuoteRow(page, runDir, index + 1);
    const selected = shouldSelectMaterial
      ? sourceOnly
        ? { skipped: true, reason: "source-row-has-no-fillable-material-values", label: item.label || "" }
        : item.allowBlankCode
          ? { skipped: true, reason: "blank-material-code", label: item.label || "" }
          : await selectMaterialAndObserveStable(page, runDir, item, {
              openPicker: true,
              artifactPrefix,
            })
      : null;
    const filled = shouldFillMaterial
      ? sourceOnly
        ? {
            materialNo: item.code || "",
            quantity: item.qty ?? "",
            taxPrice: item.taxPrice ?? "",
            inputCount: 0,
            skipped: true,
            warning: sourceOnlyWarning,
            warnings: [sourceOnlyWarning],
            rowState: [],
            rowStateText: "",
          }
        : selected?.reason === "material-not-found-in-picker"
          ? await observeMaterialManualReviewRow(page, runDir, item, {
              artifactPrefix,
              rowIndex: index,
              reason: selected.reason,
              action: "Material was not found in the A8 picker. Row is preserved for manual review in the wait-send draft.",
            })
          : await fillMaterialValuesAndObserve(page, runDir, item, {
              artifactPrefix,
              rowIndex: index,
              skipScreenshot: index < materialItems.length - 1,
            })
      : null;
    results.push({
      index: index + 1,
      item,
      newRow,
      selected,
      filled,
    });
  }

  const zwFrame = page.frames().find((frame) => frame.name() === "zwIframe");
  const finalRows = {};
  if (zwFrame) {
    for (let index = 0; index < materialItems.length; index += 1) {
      const item = materialItems[index];
      const key = `${index + 1}:${item.code || item.label || ""}`;
      finalRows[key] = await readMaterialRowState(zwFrame, item.code, { rowIndex: index });
    }
  }
  await writeJson(path.join(runDir, "15-all-material-row-states.json"), finalRows);
  await captureAllFrames(page, runDir, "15-after-all-material-fill");
  return {
    count: materialItems.length,
    items: materialItems,
    results,
    finalRows,
  };
}

async function readMainSaveState(page) {
  return page.evaluate(() => {
    const ids = [
      "formRecordid",
      "formAppid",
      "contentSaveId",
      "contentDataId",
      "contentTemplateId",
      "contentRightId",
      "contentZWID",
      "subject",
      "saveAsFlag",
      "currentaffairId",
    ];
    const fields = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      fields[id] = el ? el.value || el.getAttribute("value") || "" : null;
    }
    const saveBtn = document.querySelector("#saveDraft_a");
    return {
      href: location.href,
      title: document.title,
      fields,
      saveButton: saveBtn
        ? {
            text: (saveBtn.innerText || saveBtn.textContent || "").trim(),
            className: saveBtn.className || "",
            visible:
              !!(saveBtn.offsetWidth || saveBtn.offsetHeight || saveBtn.getClientRects().length) &&
              getComputedStyle(saveBtn).visibility !== "hidden" &&
              getComputedStyle(saveBtn).display !== "none",
          }
        : null,
    };
  });
}

function parseEndSaveDraft(text) {
  const match = String(text || "").match(/endSaveDraft\('([^']*)','([^']*)','([^']*)'/);
  if (!match) return null;
  return {
    summaryId: match[1],
    contentId: match[2],
    affairId: match[3],
  };
}

async function saveDraftAndObserve(page, runDir) {
  const responses = [];
  const handler = async (response) => {
    const url = response.url();
    if (!/saveDraft|saveOrUpdate|endSaveDraft|collaboration\.do/i.test(url)) return;
    let body = "";
    try {
      body = (await response.text()).slice(0, 4000);
    } catch (_error) {
      body = "";
    }
    responses.push({
      url,
      status: response.status(),
      method: response.request().method(),
      body,
      endSaveDraft: parseEndSaveDraft(body),
    });
  };
  page.on("response", handler);

  const before = await readMainSaveState(page);
  await writeJson(path.join(runDir, "16-before-save-draft-main-state.json"), before);
  await page.locator("#saveDraft_a").click({ timeout: 5000 });
  await page.waitForTimeout(10000);
  const after = await readMainSaveState(page);
  await writeJson(path.join(runDir, "17-after-save-draft-main-state.json"), after);
  await writeJson(path.join(runDir, "18-save-draft-responses.json"), responses);
  await captureAllFrames(page, runDir, "19-after-save-draft");
  page.off("response", handler);

  const endSaveDraft =
    responses.map((item) => item.endSaveDraft).find(Boolean) || parseEndSaveDraft(JSON.stringify(responses));
  return {
    before,
    after,
    responseCount: responses.length,
    saveDraftResponses: responses.map((item) => ({
      url: item.url,
      status: item.status,
      method: item.method,
      endSaveDraft: item.endSaveDraft,
      bodySnippet: item.body.slice(0, 500),
    })),
    endSaveDraft,
  };
}

function summarizeRowsForFast(rows) {
  if (!Array.isArray(rows)) return rows;
  if (rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    return {
      count: rows.length,
      sample: rows.slice(0, 5).map((row) => String(row).slice(0, 220)),
    };
  }
  return {
    count: rows.length,
    sample: rows.slice(0, 3).map((row) => ({
      text: String(row.text || "").slice(0, 180),
      inputs: (row.inputs || []).map((input) => ({
        id: input.id || "",
        value: input.value || "",
        cx: input.rect?.cx,
      })),
    })),
  };
}

function compactSaveDraftObservation(saveDraftObservation) {
  if (!saveDraftObservation) return null;
  return {
    responseCount: saveDraftObservation.responseCount,
    endSaveDraft: saveDraftObservation.endSaveDraft || null,
    afterHref: saveDraftObservation.after?.href || "",
    saveButtonVisible: saveDraftObservation.after?.saveButton?.visible ?? null,
  };
}

function compactMaterialAction(action, index) {
  const item = action?.item || {};
  const selectedWarnings = [
    ...(Array.isArray(action?.selected?.warnings) ? action.selected.warnings : []),
    ...(action?.selected?.warning ? [action.selected.warning] : []),
  ];
  const fillWarnings = [
    ...(Array.isArray(action?.filled?.warnings) ? action.filled.warnings : []),
    ...(action?.filled?.warning ? [action.filled.warning] : []),
  ];
  return {
    index: index + 1,
    code: item.code || "",
    label: item.label || "",
    qty: item.qty ?? "",
    taxPrice: item.taxPrice ?? "",
    source: item.source || "",
    sourceRows: item.sourceRows || [],
    allowBlankCode: !!item.allowBlankCode,
    allowBlankQty: !!item.allowBlankQty,
    allowBlankTaxPrice: !!item.allowBlankTaxPrice,
    materialSelected: action?.selected?.skipped ? false : action?.selected ? true : null,
    materialBackfilled: action?.selected?.backfilledTextIncludesMaterial ?? action?.selected?.backfilled ?? null,
    selectedReason: action?.selected?.reason || "",
    selectedWarnings,
    inputCount: action?.filled?.inputCount ?? null,
    fillSkipped: !!action?.filled?.skipped,
    fillWarnings,
  };
}

function collectMaterialObservationWarnings(observation) {
  if (!observation) return [];
  return (observation.results || []).flatMap((action) => [
    ...(Array.isArray(action?.selected?.warnings) ? action.selected.warnings : []),
    ...(action?.selected?.warning ? [action.selected.warning] : []),
    ...(Array.isArray(action?.filled?.warnings) ? action.filled.warnings : []),
    ...(action?.filled?.warning ? [action.filled.warning] : []),
  ]);
}

function compactMaterialListObservation(observation) {
  if (!observation) return null;
  return {
    count: observation.count,
    results: (observation.results || []).map(compactMaterialAction),
    finalRowsCount: observation.finalRows ? Object.keys(observation.finalRows).length : null,
  };
}

function compactInitOutput(output) {
  const materialObservationWarnings = collectMaterialObservationWarnings(output.materialListObservation);
  return {
    success: output.success,
    traceLevel: output.traceLevel,
    waitScale: output.waitScale,
    materialItemWarnings: output.materialItemWarnings || [],
    materialObservationWarnings,
    linkedCreateObservation: output.linkedCreateObservation
      ? {
          linkedCreateNo: output.linkedCreateObservation.linkedCreateNo || "",
          clicked: output.linkedCreateObservation.clicked ?? null,
          backfilled: output.linkedCreateObservation.backfilledTextIncludesCreateNo ?? null,
        }
      : null,
    baseFieldObservation: output.baseFieldObservation
      ? {
          filledCount: output.baseFieldObservation.filled?.length ?? null,
          selectedCount: output.baseFieldObservation.selected?.length ?? null,
        }
      : null,
    materialSelectionObservation: output.materialSelectionObservation
      ? {
          materialNo: output.materialSelectionObservation.materialNo || "",
          skipped: !!output.materialSelectionObservation.skipped,
          backfilled: output.materialSelectionObservation.backfilledTextIncludesMaterial ?? null,
        }
      : null,
    materialFillObservation: output.materialFillObservation
      ? {
          materialNo: output.materialFillObservation.materialNo || "",
          quantity: output.materialFillObservation.quantity,
          taxPrice: output.materialFillObservation.taxPrice,
          inputCount: output.materialFillObservation.inputCount,
        }
      : null,
    materialListObservation: compactMaterialListObservation(output.materialListObservation),
    saveDraftObservation: compactSaveDraftObservation(output.saveDraftObservation),
  };
}

function compactForConsole(value) {
  if (traceAt("debug")) return value;
  if (Object.prototype.hasOwnProperty.call(value || {}, "materialItemWarnings")) {
    return compactInitOutput(value);
  }
  return JSON.parse(
    JSON.stringify(value, (key, current) => {
      if (
        [
          "rowState",
          "finalRows",
          "matchedRows",
          "backfillRows",
          "fieldValues",
          "fieldMap",
          "rowStateText",
        ].includes(key)
      ) {
        if (key === "finalRows" && current && typeof current === "object" && !Array.isArray(current)) {
          return Object.fromEntries(
            Object.entries(current).map(([rowKey, rows]) => [rowKey, summarizeRowsForFast(rows)])
          );
        }
        if (Array.isArray(current)) return summarizeRowsForFast(current);
        if (typeof current === "string") return current.slice(0, 300);
      }
      if (key === "saveDraftResponses" && Array.isArray(current)) {
        return current.map((item) => ({
          url: item.url,
          status: item.status,
          method: item.method,
          endSaveDraft: item.endSaveDraft,
        }));
      }
      if (key === "bodySnippet" && typeof current === "string") {
        return current.slice(0, 200);
      }
      return current;
    })
  );
}

async function main() {
  const runDir = path.join(runtimeRoot, "observations", timestamp());
  await ensureDir(runDir);

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-gpu"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
    locale: "zh-CN",
  });
  const page = await context.newPage();
  installTraceHooks(page);

  try {
    const loginResult = await login(page, runDir);
    const observeResult = await observeInitApply(page, runDir);
    const linkedCreateObservation = shouldSelectLinkedCreate
      ? await selectLinkedCreateAndObserve(page, runDir)
      : null;
    const baseFieldObservation = shouldFillBaseFields
      ? await fillProjectBaseFieldsAndObserve(page, runDir)
      : null;
    let materialPickerObservation = null;
    let materialSelectionObservation = null;
    let materialFillObservation = null;
    let materialListObservation = null;
    if (materialItems.length > 1 && (shouldSelectMaterial || shouldFillMaterial)) {
      materialListObservation = await processMaterialItemsAndObserve(page, runDir);
    } else {
      const firstMaterialItem = materialItems[0];
      materialPickerObservation = shouldObserveMaterialPicker && !firstMaterialItem.allowBlankCode
        ? await observeMaterialPicker(page, runDir)
        : null;
      materialSelectionObservation = shouldSelectMaterial
        ? firstMaterialItem.allowBlankCode
          ? { skipped: true, reason: "blank-material-code", label: firstMaterialItem.label || "" }
          : await selectMaterialAndObserveStable(page, runDir)
        : null;
      materialFillObservation = shouldFillMaterial
        ? materialSelectionObservation?.reason === "material-not-found-in-picker"
          ? await observeMaterialManualReviewRow(page, runDir, firstMaterialItem, {
              rowIndex: 0,
              reason: materialSelectionObservation.reason,
              action: "Material was not found in the A8 picker. Row is preserved for manual review in the wait-send draft.",
            })
          : await fillMaterialValuesAndObserve(page, runDir)
        : null;
    }
    const saveDraftObservation = shouldSaveDraft
      ? await saveDraftAndObserve(page, runDir)
      : null;
    const output = {
      success: true,
      chromePath,
      traceLevel: traceLevelName,
      waitScale: Number.isFinite(configuredWaitScale) && configuredWaitScale > 0 ? configuredWaitScale : null,
      login: loginResult,
      observation: observeResult,
      materialItemWarnings,
      linkedCreateObservation,
      baseFieldObservation,
      materialPickerObservation,
      materialSelectionObservation,
      materialFillObservation,
      materialListObservation,
      saveDraftObservation,
    };
    const persistedOutput = traceLevelName === "fast" ? compactInitOutput(output) : output;
    await writeJson(path.join(runDir, "result.json"), persistedOutput, {
      critical: true,
      compact: traceLevelName === "fast",
    });
    console.log(JSON.stringify(compactForConsole(output), null, 2));
  } catch (error) {
    await captureAllFrames(page, runDir, "error-final").catch(() => {});
    const output = {
      success: false,
      chromePath,
      traceLevel: traceLevelName,
      error: String(error),
      stack: error?.stack || "",
      artifactDir: runDir,
    };
    await writeJson(path.join(runDir, "error.json"), output, { critical: true });
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
