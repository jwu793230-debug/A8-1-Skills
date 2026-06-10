"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const baseUrl = "https://a8.uni-ubi.com";
const loginUrl = `${baseUrl}/seeyon/main.do?method=index`;
const changeUrl =
  `${baseUrl}/seeyon/collaboration/collaboration.do?method=newColl` +
  `&from=bizconfig` +
  `&firstName=%E8%81%8C%E8%83%BD%E7%B1%BB` +
  `&secondName=%E6%8A%A5%E4%BB%B7%E6%B8%85%E5%8D%95%E5%8F%98%E6%9B%B4` +
  `&menuId=1504114103205580015` +
  `&templateId=-8080195825513903403` +
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

const projectNameKeyword = process.env.A8_CHANGE_PROJECT_NAME || "";
const projectNo = normalizeOptionalProjectNo(
  Object.prototype.hasOwnProperty.call(process.env, "A8_CHANGE_PROJECT_NO")
    ? process.env.A8_CHANGE_PROJECT_NO
    : ""
);
const accountName = process.env.A8_CHANGE_ACCOUNT || "";
const businessName = process.env.A8_CHANGE_BUSINESS || "AI安全事业部";
const industryName = process.env.A8_CHANGE_INDUSTRY || "基建数字化行业业务";
const materialNo = process.env.A8_CHANGE_MATERIAL_NO || "";
const addedQty = process.env.A8_CHANGE_ADDED_QTY || "";
const changeTaxPrice =
  process.env.A8_CHANGE_TAX_PRICE ??
  process.env.A8_CHANGE_UNIT_PRICE ??
  process.env.A8_CHANGE_MATERIAL_TAX_PRICE ??
  "";
const afterFiller = process.env.A8_CHANGE_AFTER_FILLER || "0";
const afterInstallFee = process.env.A8_CHANGE_AFTER_INSTALL_FEE || "0";
const deliveryFee = process.env.A8_CHANGE_DELIVERY_FEE || "0";
const changeTypeText = process.env.A8_CHANGE_TYPE || "变更";
const rowMaterialOptionText =
  process.env.A8_CHANGE_ROW_MATERIAL_OPTION ||
  (changeTypeText === "新增" ? "新增存货产品编号" : "变更项目产品型号");
const projectSearchInputIndex = Number.parseInt(
  process.env.A8_CHANGE_PROJECT_SEARCH_INPUT_INDEX || "1",
  10
);
const changeItems = parseChangeItems();
const itemWarnings = collectItemWarnings(changeItems);
const quotePageSize = parseQuotePageSize(changeItems.length);

const shouldOpenProjectPicker =
  process.argv.includes("--project-picker") ||
  process.argv.includes("--select-project") ||
  process.argv.includes("--save-draft");
const shouldSelectProject =
  process.argv.includes("--select-project") ||
  process.argv.includes("--save-draft");
const shouldFillBase =
  process.argv.includes("--fill-base") ||
  process.argv.includes("--save-draft");
const shouldFillRow =
  process.argv.includes("--fill-row") ||
  process.argv.includes("--save-draft");
const shouldSetQuotePageSize =
  shouldFillRow ||
  process.argv.includes("--set-quote-page-size") ||
  /^(1|true|yes)$/i.test(process.env.A8_SET_QUOTE_PAGE_SIZE || "");
const shouldSaveDraft =
  process.argv.includes("--save-draft") ||
  /^(1|true|yes)$/i.test(process.env.A8_SAVE_DRAFT || "");
const shouldCollectTiming = boolish(process.env.A8_TIMING || process.env.A8_ROW_TIMING || "");
const timingState = {
  enabled: shouldCollectTiming,
  traceLevel: traceLevelName,
  startedAt: new Date().toISOString(),
  rows: [],
  steps: [],
};

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

function isFast() {
  return traceLevelName === "fast";
}

function isDebug() {
  return traceLevelName === "debug";
}

function isErrorArtifactName(name) {
  return /error|missing|failed|fail|no-match|not-found|option-missing/i.test(String(name || ""));
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

function nowMs() {
  return Date.now();
}

function compactError(error) {
  return error ? String(error?.message || error).slice(0, 300) : "";
}

async function timedStep(name, fn, bucket = timingState.steps) {
  if (!shouldCollectTiming) {
    return fn();
  }
  const started = nowMs();
  try {
    const result = await fn();
    bucket.push({ name, ms: nowMs() - started, ok: true });
    return result;
  } catch (error) {
    bucket.push({ name, ms: nowMs() - started, ok: false, error: compactError(error) });
    throw error;
  }
}

async function waitUntil(page, predicate, options = {}) {
  const timeout = options.timeout ?? 8000;
  const interval = options.interval ?? 250;
  const started = nowMs();
  let lastValue = null;
  let lastError = "";
  while (nowMs() - started <= timeout) {
    try {
      lastValue = await predicate();
      if (lastValue) {
        return { ok: true, value: lastValue, elapsedMs: nowMs() - started };
      }
    } catch (error) {
      lastError = compactError(error);
    }
    await page.waitForTimeout(interval);
  }
  return { ok: false, value: lastValue, elapsedMs: nowMs() - started, error: lastError };
}

async function waitForMaterialPickerFrame(page, timeout = 8000) {
  return waitUntil(page, () => findMaterialPickerFrame(page), { timeout, interval: 250 });
}

async function waitForMaterialPickerClosed(page, timeout = 8000) {
  return waitUntil(page, () => !findMaterialPickerFrame(page), { timeout, interval: 250 });
}

async function waitForPickerMatchedRows(page, frame, term, timeout = 7000) {
  const escaped = escapeRegExp(term);
  return waitUntil(
    page,
    async () => {
      const rows = await extractVisibleTextRows(frame, escaped).catch(() => []);
      return rows.length ? rows : null;
    },
    { timeout, interval: 300 }
  );
}

async function waitForPickerSearchInput(page, inputs, timeout = 10000) {
  return waitUntil(
    page,
    async () => {
      const count = await inputs.count().catch(() => 0);
      return count > 0 ? count : null;
    },
    { timeout, interval: 250 }
  );
}

async function waitForMaterialRowState(page, code, recordId, timeout = 8000) {
  return waitUntil(
    page,
    async () => {
      const rows = await readMaterialRowState(findZwFrame(page), code, recordId).catch(() => []);
      return rows.length ? rows : null;
    },
    { timeout, interval: 300 }
  );
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function boolish(value) {
  return /^(1|true|yes|y)$/i.test(String(value || ""));
}

function parseQuotePageSize(itemCount) {
  if (Object.prototype.hasOwnProperty.call(process.env, "A8_CHANGE_QUOTE_PAGE_SIZE")) {
    const configured = Number.parseInt(process.env.A8_CHANGE_QUOTE_PAGE_SIZE || "", 10);
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }
  }
  return itemCount > 20 ? itemCount : 20;
}

function parseChangeItems() {
  const raw =
    process.env.A8_CHANGE_ITEMS_JSON ||
    (process.env.A8_CHANGE_ITEMS_JSON_FILE
      ? fsSync.readFileSync(path.resolve(process.env.A8_CHANGE_ITEMS_JSON_FILE), "utf8")
      : "");
  if (!raw) {
    return materialNo || addedQty || changeTaxPrice
      ? [{ code: materialNo, qty: addedQty, taxPrice: changeTaxPrice }]
      : [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid A8_CHANGE_ITEMS_JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("A8_CHANGE_ITEMS_JSON must be a non-empty array");
  }
  return parsed.map((item, index) => {
    const code = typeof item === "string" ? item : firstDefined(item.code, item.materialNo, item.productNo);
    const qty = typeof item === "string" ? addedQty : firstDefined(item.qty, item.quantity, item.addedQty);
    const itemTaxPrice =
      typeof item === "string"
        ? undefined
        : firstDefined(
            item.taxPrice,
            item.tax_price,
            item.price,
            item.unitPrice,
            item.unit_price,
            item.taxInclusivePrice,
            item.tax_inclusive_price
          );
    const rawTaxPrice =
      typeof item === "string"
        ? changeTaxPrice
        : itemTaxPrice !== undefined
          ? itemTaxPrice
          : changeTaxPrice;
    const codeText = code === undefined || code === null ? "" : String(code);
    const qtyText = qty === undefined || qty === null ? "" : String(qty);
    const rawTaxPriceIsBlank = rawTaxPrice === undefined || rawTaxPrice === null || String(rawTaxPrice) === "";
    const allowBlankCode =
      codeText === "" ||
      (typeof item !== "string" &&
        (boolish(item.allowBlankCode) || boolish(item.blankCode) || boolish(item.skipMaterialPicker)));
    const allowBlankQty =
      qtyText === "" ||
      (typeof item !== "string" &&
        (boolish(item.allowBlankQty) || boolish(item.blankQty) || boolish(item.allowBlankValues)));
    const allowBlankTaxPrice =
      rawTaxPriceIsBlank ||
      (typeof item !== "string" &&
        (boolish(item.allowBlankTaxPrice) || boolish(item.blankTaxPrice) || boolish(item.allowBlankValues)));
    const effectiveTaxPrice = rawTaxPriceIsBlank ? "" : String(rawTaxPrice);
    const sourceRow =
      typeof item === "string"
        ? ""
        : firstDefined(item.sourceRow, item.excelRow, item.excel_row, item.row, item.source);
    const sourceRows = typeof item === "string" ? [] : Array.isArray(item.sourceRows) ? item.sourceRows : [];
    const itemChangeType =
      typeof item === "string"
        ? changeTypeText
        : String(firstDefined(item.changeType, item.type, item.change_type, changeTypeText)).trim() ||
          changeTypeText;
    return {
      code: codeText,
      qty: qtyText,
      taxPrice: effectiveTaxPrice,
      changeType: itemChangeType,
      allowBlankCode,
      allowBlankQty,
      allowBlankTaxPrice,
      sourceRow,
      sourceRows,
      label:
        typeof item === "string"
          ? String(code)
          : String(item.label || item.name || item.device || item.productName || code || `row-${index + 1}`),
    };
  });
}

function itemSourceLabel(item, index) {
  if (item.sourceRows?.length) {
    return `sourceRows=${item.sourceRows.join(",")}`;
  }
  if (item.sourceRow !== undefined && item.sourceRow !== null && String(item.sourceRow) !== "") {
    return `sourceRow=${item.sourceRow}`;
  }
  return `index=${index + 1}`;
}

function collectItemWarnings(items) {
  const warnings = [];
  const byCode = new Map();
  items.forEach((item, index) => {
    if (item.code) {
      const bucket = byCode.get(item.code) || [];
      bucket.push({ index: index + 1, source: itemSourceLabel(item, index) });
      byCode.set(item.code, bucket);
    }
    const blankFields = [];
    if (!item.code) blankFields.push("material code");
    if (item.qty === undefined || item.qty === null || String(item.qty) === "") blankFields.push("quantity");
    if (item.taxPrice === undefined || item.taxPrice === null || String(item.taxPrice) === "") blankFields.push("tax price");
    if (blankFields.length) {
      warnings.push({
        type: "blank-fields-preserved",
        index: index + 1,
        source: itemSourceLabel(item, index),
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
  if (items.length > 20) {
    warnings.push({
      type: "quote-page-size-auto",
      itemCount: items.length,
      pageSize: parseQuotePageSize(items.length),
      action: "Quote detail page size is set to the item count before row entry.",
    });
  }
  return warnings;
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

async function clickFirstVisible(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1000 }))) {
        await locator.click({ timeout: 3000 });
        return selector;
      }
    } catch (_error) {
      // Try next selector.
    }
  }
  return "";
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeOptionalProjectNo(value) {
  const text = String(value || "").trim();
  if (/^(auto|__auto__|\*)$/i.test(text)) {
    return "";
  }
  return text;
}

function extractProjectNosFromRows(rows) {
  const projectNoPattern = /\b20\d{6}-\d{4}\b/g;
  return [...new Set(rows.flatMap((row) => row.text.match(projectNoPattern) || []))];
}

function changeTypeForItem(item = {}) {
  return String(item?.changeType || changeTypeText).trim() || changeTypeText;
}

function rowMaterialOptionTextForChangeType(targetChangeType = changeTypeText) {
  if (process.env.A8_CHANGE_ROW_MATERIAL_OPTION) return rowMaterialOptionText;
  return targetChangeType === "新增" ? "新增存货产品编号" : "变更项目产品型号";
}

function rowMaterialOptionCandidates(targetChangeType = changeTypeText) {
  const requestedOptionText = rowMaterialOptionTextForChangeType(targetChangeType);
  const addOptions = [
    requestedOptionText,
    "新增存货产品编号",
    "新增存货产品信息",
    "新增项目产品编号",
    "新增项目产品信息",
    "新增产品编号",
    "新增报价产品",
  ];
  const changeOptions = [
    requestedOptionText,
    "变更项目产品编号",
    "变更项目产品型号",
    "变更报价产品",
  ];
  const candidates = targetChangeType === "新增" ? addOptions : changeOptions;
  return [...new Set(candidates.filter(Boolean))];
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
      const count = Math.min(await locator.count().catch(() => 0), 40);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        try {
          if (await candidate.isVisible({ timeout: 500 })) {
            if (options.excludeTableRows) {
              const insideTableRow = await candidate
                .evaluate((el) => !!el.closest("tr,.cap4-table-row,[class*='formson-line']"))
                .catch(() => false);
              if (insideTableRow) {
                continue;
              }
            }
            const box = await candidate.boundingBox().catch(() => null);
            if (options.nearBox && box) {
              const belowField = box.y >= options.nearBox.y + options.nearBox.height - 8;
              const aboveField =
                options.allowAbove &&
                box.y + box.height <= options.nearBox.y + 8 &&
                box.y >= options.nearBox.y - 420;
              const closeVertically = box.y <= options.nearBox.y + options.nearBox.height + 420;
              const overlapsHorizontally =
                Math.min(box.x + box.width, options.nearBox.x + options.nearBox.width + 120) -
                  Math.max(box.x, options.nearBox.x - 120) >
                0;
              if (!(belowField || aboveField) || !closeVertically || !overlapsHorizontally) {
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
  for (const best of matches) {
    try {
      await best.candidate.click({ timeout: 4000 });
      return {
        text: best.text,
        scope: best.scope,
        index: best.index,
        box: best.box,
      };
    } catch (_error) {
      // Try the next visible match; some A8 row-menu labels are visually present
      // but covered by the table body after scroll.
    }
  }
  return null;
}

async function selectFrameOption(page, frame, fieldSelector, value, fieldName, runDir) {
  if (!value) {
    return null;
  }
  const field = frame.locator(fieldSelector).first();
  if ((await field.count()) === 0) {
    throw new Error(`Field not found: ${fieldName}`);
  }
  await field.scrollIntoViewIfNeeded().catch(() => {});
  await frame
    .locator(".transparent_mast:visible")
    .first()
    .waitFor({ state: "hidden", timeout: 15000 })
    .catch(() => {});
  try {
    await field.click({ timeout: 5000 });
  } catch (_error) {
    await field.click({ timeout: 5000, force: true });
  }
  await page.waitForTimeout(900);

  const fieldBox = await field.boundingBox().catch(() => null);
  const clicked = await clickExactVisibleText([frame, page], value, { nearBox: fieldBox });
  if (!clicked) {
    await captureAllFrames(page, runDir, `base-option-missing-${fieldName}`);
    throw new Error(`Option not found: ${fieldName}=${value}`);
  }
  await page.waitForTimeout(1200);
  return { fieldName, value, clicked };
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
      .slice(0, 100);
  }, pattern);
}

async function clickMatchedPickerRow(frame, exactText) {
  return frame.evaluate((text) => {
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
    function firstToken(el) {
      return textOf(el).split(/\s+/)[0] || "";
    }
    const rows = [...document.querySelectorAll("tr,.cap4-table-row,.el-table__row,[class*='row']")]
      .filter((el) => isVisible(el) && textOf(el).includes(text))
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const row = rows.find((el) => firstToken(el) === text) || rows[0];
    if (!row) return { clicked: false, reason: "row-not-found" };
    const directControl = [...row.querySelectorAll("input[type='radio'],input[type='checkbox']")].find(isVisible);
    if (directControl) {
      directControl.click();
      return {
        clicked: true,
        method: directControl.type || directControl.tagName,
        rowText: textOf(row).slice(0, 400),
      };
    }
    const clickable = [...row.querySelectorAll("a,button,[role='button'],td,div,span")].find(isVisible) || row;
    clickable.click();
    return {
      clicked: true,
      method: clickable.tagName,
      rowText: textOf(row).slice(0, 400),
    };
  }, exactText);
}

function findZwFrame(page) {
  const frame = page.frames().find((item) => item.name() === "zwIframe");
  if (!frame) {
    throw new Error("zwIframe not found");
  }
  return frame;
}

function findProjectPickerFrame(page) {
  return page.frames().find((frame) =>
    /fieldId=field0009|relationShipId=-583468583860482528/.test(frame.url())
  );
}

function findMaterialPickerFrame(page) {
  return [...page.frames()].reverse().find((frame) =>
    /fieldId=field0020|tbName=formson_0684|relationShipId=20315660318361378|relationShipId=5584020044383865991/.test(frame.url()) &&
    !/fieldId=field0009/.test(frame.url()) &&
    frame.name() !== "zwIframe"
  );
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
    ".login_button",
  ]);
  if (!clicked) {
    await passwordField.press("Enter");
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (traceAt("normal")) {
    await page.screenshot({ path: path.join(runDir, "02-after-login.png"), fullPage: true });
  }
  return { clicked, url: page.url(), title: await page.title().catch(() => "") };
}

async function summarizeFrame(frame) {
  return frame.evaluate(() => {
    function textOf(node) {
      return (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    }
    function visible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    const inputs = [...document.querySelectorAll("input,textarea,select")]
      .slice(0, 400)
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        name: el.getAttribute("name") || "",
        type: el.getAttribute("type") || "",
        title: el.getAttribute("title") || "",
        placeholder: el.getAttribute("placeholder") || "",
        value: el.tagName === "SELECT" ? el.value : (el.value || el.getAttribute("value") || "").slice(0, 160),
        visible: visible(el),
      }));
    const buttons = [...document.querySelectorAll("a,button,input[type='button'],input[type='submit']")]
      .slice(0, 300)
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        className: String(el.className || ""),
        text: textOf(el).slice(0, 120),
        value: el.getAttribute("value") || "",
        visible: visible(el),
      }));
    return {
      title: document.title,
      url: location.href,
      text: textOf(document.body).slice(0, 8000),
      inputs,
      buttons,
    };
  }).catch((error) => ({ error: String(error), url: frame.url() }));
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
      .map((el, index) => ({
        index,
        tag: el.tagName,
        id: el.id || "",
        className: String(el.className || ""),
        text: textOf(el).slice(0, 200),
        title: el.getAttribute("title") || "",
        role: el.getAttribute("role") || "",
        rect: rectOf(el),
      }))
      .filter((item) => {
        const key = item.text + item.title + item.id + item.className;
        return /项目|报价|账套|所属|产品|变更|辅料|安装|交付|browse|relation|select|field|icon|cap4/i.test(key);
      })
      .slice(0, 700);
  });
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

async function setQuoteTablePageSizeAndObserve(page, runDir, targetSize = quotePageSize) {
  const fallbackSize = parseQuotePageSize(changeItems.length);
  const requestedSize = Number.isFinite(targetSize) && targetSize > 0 ? targetSize : fallbackSize;
  const frame = findZwFrame(page);
  const observation = await frame.evaluate(async ({ requestedSize }) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    function safeText(value) {
      return value === undefined || value === null ? "" : String(value);
    }
    function summarize(vm, path = "") {
      const listTable = vm?.listTable || {};
      const pageData = vm?.pageData || {};
      const data = vm?.data || {};
      const el = vm?.$el || null;
      return {
        path,
        name: safeText(vm?.$options?.name),
        tableName: safeText(listTable.tableName),
        frontTableName: safeText(listTable.frontTableName),
        dataTableName: safeText(data.tableName),
        id: safeText(el?.id),
        className: safeText(el?.className),
        pageData: {
          pageSize: pageData.pageSize,
          page: pageData.page,
          total: pageData.total,
          maxPageSize: pageData.maxPageSize,
        },
        listPageData: {
          pageSize: listTable.pageData?.pageSize,
          page: listTable.pageData?.page,
          totalSize: listTable.pageData?.totalSize,
        },
        recordsLength: Array.isArray(listTable.records) ? listTable.records.length : null,
      };
    }
    function isQuoteFormson(vm) {
      const listTable = vm?.listTable || {};
      const data = vm?.data || {};
      const el = vm?.$el || null;
      return (
        listTable.tableName === "formson_0684" ||
        listTable.frontTableName === "front_formson_1" ||
        data.tableName === "front_formson_1" ||
        el?.id === "tableName-front_formson_1"
      );
    }
    const roots = [];
    const seenRoots = new Set();
    function addRoot(vm) {
      if (vm && !seenRoots.has(vm)) {
        seenRoots.add(vm);
        roots.push(vm);
      }
    }
    function addElementAndParents(el) {
      for (let node = el; node; node = node.parentElement) {
        if (node.__vue__) addRoot(node.__vue__);
      }
    }
    addElementAndParents(document.querySelector("#tableName-front_formson_1"));
    document.querySelectorAll(".formson_0684,[class*='formson_0684']").forEach(addElementAndParents);
    document.querySelectorAll("*").forEach((el) => {
      if (el.__vue__) addRoot(el.__vue__);
    });
    if (document.body?.__vue__) addRoot(document.body.__vue__);

    const visited = new Set();
    const candidates = [];
    function visit(vm, path = "root") {
      if (!vm || visited.has(vm)) return;
      visited.add(vm);
      if (isQuoteFormson(vm)) {
        candidates.push({ vm, path });
      }
      const children = Array.isArray(vm.$children) ? vm.$children : [];
      children.forEach((child, index) => visit(child, `${path}.${safeText(child?.$options?.name) || "child"}[${index}]`));
    }
    roots.forEach((root, index) => visit(root, `root[${index}]`));

    const selected =
      candidates.find((item) => item.vm?.listTable?.tableName === "formson_0684") ||
      candidates.find((item) => item.vm?.listTable?.frontTableName === "front_formson_1") ||
      candidates[0];
    const allCandidates = candidates.slice(0, 20).map((item) => summarize(item.vm, item.path));
    if (!selected) {
      return {
        changed: false,
        reason: "quote-formson-vue-not-found",
        requestedSize,
        roots: roots.length,
        candidates: allCandidates,
      };
    }

    const vm = selected.vm;
    const before = summarize(vm, selected.path);
    const maxPageSize = Number(vm.pageData?.maxPageSize || vm.listTable?.pageData?.maxPageSize || 200);
    const nextSize = Math.min(
      Math.max(Number(requestedSize) || 20, 1),
      Number.isFinite(maxPageSize) && maxPageSize > 0 ? maxPageSize : 200
    );
    let method = "";
    let error = "";
    try {
      if (typeof vm.pageEvent === "function") {
        vm.pageEvent({ pageSize: nextSize, page: 1 });
        method = "pageEvent";
      } else {
        if (vm.pageData) {
          vm.pageData.pageSize = nextSize;
          vm.pageData.page = 1;
        }
        if (vm.listTable?.pageData) {
          vm.listTable.pageData.pageSize = nextSize;
          vm.listTable.pageData.page = 1;
        }
        if (typeof vm.saveCachePageData === "function") vm.saveCachePageData();
        if (typeof vm.modifyInitTable === "function") vm.modifyInitTable();
        else if (typeof vm.updatePageData === "function") vm.updatePageData();
        method = "direct-pageData";
      }
      await wait(2200);
    } catch (err) {
      error = String(err);
    }
    const after = summarize(vm, selected.path);
    return {
      changed: Number(after.pageData.pageSize) === nextSize || Number(after.listPageData.pageSize) === nextSize,
      requestedSize,
      appliedSize: nextSize,
      method,
      error,
      before,
      after,
      candidates: allCandidates,
    };
  }, { requestedSize });
  await writeJson(path.join(runDir, "11-quote-page-size-observation.json"), observation);
  await page.waitForTimeout(1200);
  await captureAllFrames(page, runDir, "11-after-quote-page-size");
  return observation;
}

async function openChangePage(page, runDir) {
  await page.goto(changeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  if (traceAt("normal")) {
    await page.screenshot({ path: path.join(runDir, "03-change-page.png"), fullPage: true });
  }
  await writeText(path.join(runDir, "03-change-page.html"), await page.content());
  const frame = page.frames().find((item) => item.name() === "zwIframe");
  if (!frame) {
    throw new Error("zwIframe not found");
  }
  await writeJson(path.join(runDir, "04-visible-element-map.json"), await collectVisibleElementMap(frame));
  await captureAllFrames(page, runDir, "04-change-page");
  return { url: page.url(), title: await page.title().catch(() => "") };
}

async function clickByFramePoint(page, frame, point) {
  const frameHandle = await frame.frameElement();
  const frameBox = await frameHandle.boundingBox();
  if (!frameBox) {
    throw new Error("Unable to locate frame box");
  }
  await page.mouse.click(frameBox.x + point.x, frameBox.y + point.y);
}

async function openProjectPicker(page, runDir) {
  const frame = page.frames().find((item) => item.name() === "zwIframe");
  if (!frame) {
    throw new Error("zwIframe not found before project picker");
  }
  const pickerInfo = await frame.evaluate(() => {
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
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }
    const field = document.querySelector("#field0009_id");
    const input = document.querySelector("#field0009_id input, #field0009_id textarea");
    const inputRect = input ? rectOf(input) : field ? rectOf(field) : null;
    const visible = [...document.querySelectorAll("*")].filter(isVisible);
    const icon = field
      ? [...field.querySelectorAll(".cap4-text__relation,[class*='zhubiaoxuanzeqi'],[class*='mingxibiaoxuanzeqi'],i,div")]
          .filter(isVisible)
          .map((el) => ({ el, tag: el.tagName, id: el.id || "", className: String(el.className || ""), text: textOf(el), rect: rectOf(el) }))
          .sort((a, b) => {
            const rightA = Math.abs(a.rect.cx - (inputRect ? inputRect.x + inputRect.width - 8 : a.rect.cx));
            const rightB = Math.abs(b.rect.cx - (inputRect ? inputRect.x + inputRect.width - 8 : b.rect.cx));
            return rightA - rightB;
          })[0]
      : inputRect
      ? visible
          .map((el) => ({ el, tag: el.tagName, id: el.id || "", className: String(el.className || ""), text: textOf(el), rect: rectOf(el) }))
          .filter((item) => {
            const nearY = item.rect.cy >= inputRect.y - 5 && item.rect.cy <= inputRect.y + inputRect.height + 8;
            const nearRight = item.rect.cx >= inputRect.x + inputRect.width - 8 && item.rect.cx <= inputRect.x + inputRect.width + 35;
            return nearY && nearRight && !/^(INPUT|TEXTAREA|SELECT)$/.test(item.tag);
          })
          .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]
      : null;
    return {
      inputRect,
      icon: icon ? { tag: icon.tag, id: icon.id, className: icon.className, text: icon.text, rect: icon.rect } : null,
      clickPoint: icon
        ? { x: icon.rect.cx, y: icon.rect.cy }
        : inputRect
          ? { x: inputRect.x + inputRect.width + 12, y: inputRect.y + inputRect.height / 2 }
          : null,
    };
  });
  await writeJson(path.join(runDir, "05-project-picker-click-info.json"), pickerInfo);
  if (!pickerInfo.clickPoint) {
    throw new Error("Project picker click point not found");
  }
  await clickByFramePoint(page, frame, pickerInfo.clickPoint);
  await page.waitForTimeout(700);
  const menuOption = await frame.evaluate((point) => {
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
    const item = [...document.querySelectorAll("*")]
      .filter((el) => isVisible(el) && textOf(el) === "项目编号")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          cx: r.x + r.width / 2,
          cy: r.y + r.height / 2,
        };
      })
      .filter((rect) => rect.y > point.y && rect.y < point.y + 90 && rect.x >= point.x - 20 && rect.x <= point.x + 140)
      .sort((a, b) => a.y - b.y)[0];
    return item || null;
  }, pickerInfo.clickPoint);
  if (menuOption) {
    await clickByFramePoint(page, frame, { x: menuOption.cx, y: menuOption.cy });
  }
  await page.waitForTimeout(5000);
  await captureAllFrames(page, runDir, "06-after-project-picker-click");
  return { ...pickerInfo, menuOption };
}

async function selectProjectAndObserve(page, runDir) {
  const pickerFrame = findProjectPickerFrame(page);
  if (!pickerFrame) {
    await captureAllFrames(page, runDir, "07-project-picker-frame-missing");
    throw new Error("Project picker iframe not found after opening field0009 relation");
  }

  await pickerFrame
    .locator("input[placeholder]:visible")
    .first()
    .waitFor({ state: "visible", timeout: 30000 })
    .catch(() => {});
  const inputs = pickerFrame.locator("input[placeholder='搜索关键字']:visible, input[placeholder]:visible");
  const inputWait = isFast() ? await waitForPickerSearchInput(page, inputs, 10000) : null;
  const inputCount = await inputs.count();
  if (inputCount <= projectSearchInputIndex) {
    throw new Error(`Project picker search input ${projectSearchInputIndex} not found, visible count=${inputCount}`);
  }

  await inputs.nth(projectSearchInputIndex).fill(projectNameKeyword);
  await pickerFrame.getByText("筛选", { exact: true }).click({ timeout: 5000 });
  await page.waitForTimeout(5000);

  const matchedRows = await extractVisibleTextRows(
    pickerFrame,
    escapeRegExp(projectNo || projectNameKeyword)
  );
  await writeJson(path.join(runDir, "07-project-search-matched-rows.json"), matchedRows);
  if (matchedRows.length === 0) {
    await captureAllFrames(page, runDir, "07-project-search-no-match");
    throw new Error(`Project not found in picker: ${projectNo || projectNameKeyword} using keyword ${projectNameKeyword}`);
  }

  const resolvedProjectNo = projectNo || (() => {
    const projectNos = extractProjectNosFromRows(matchedRows);
    if (projectNos.length !== 1) {
      throw new Error(
        `Project keyword ${projectNameKeyword} matched ${projectNos.length} project numbers: ${projectNos.join(", ")}`
      );
    }
    return projectNos[0];
  })();
  const pickerClick = await clickMatchedPickerRow(pickerFrame, resolvedProjectNo);
  await writeJson(path.join(runDir, "08-project-picker-row-click.json"), pickerClick);
  if (!pickerClick.clicked) {
    throw new Error(`Unable to select project row: ${pickerClick.reason || resolvedProjectNo}`);
  }

  await page.waitForTimeout(1000);
  await captureAllFrames(page, runDir, "08-after-project-row-click");
  await page.locator("a:has-text('确定'), button:has-text('确定')").last().click({ timeout: 5000 });
  await page.waitForTimeout(9000);

  const summaries = await captureAllFrames(page, runDir, "09-after-project-confirm");
  const zwSummary = summaries.find((item) => item.name === "zwIframe")?.summary || {};
  const fieldValues = await readMainFormValues(findZwFrame(page), {
    projectNo: resolvedProjectNo,
    materialNo,
  });
  await writeJson(path.join(runDir, "09-after-project-field-values.json"), fieldValues);

  return {
    projectNameKeyword,
    projectNo: resolvedProjectNo,
    requestedProjectNo: projectNo,
    matchedRows,
    pickerClick,
    formTextIncludesProjectNo: (zwSummary.text || "").includes(resolvedProjectNo),
    fieldValues,
  };
}

async function readMainFormValues(frame, context = {}) {
  return frame.evaluate(({ projectNo, materialNo }) => {
    const ids = [
      "field0009",
      "field0009_inner",
      "field0010",
      "field0010_inner",
      "field0058",
      "field0058_inner",
      "field0096",
      "field0096_inner",
      "field0097",
      "field0097_inner",
      "field0019",
      "field0020",
    ];
    const values = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) {
        values[id] = null;
      } else {
        values[id] =
          el.value ||
          el.getAttribute("value") ||
          (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      }
    }
    const text = (document.body.innerText || document.body.textContent || "").replace(/\s+/g, " ").trim();
    return {
      values,
      textIncludes: {
        projectNo: projectNo ? text.includes(projectNo) : false,
        materialNo: materialNo ? text.includes(materialNo) : false,
      },
      textSnippet: text.slice(0, 3000),
    };
  }, {
    projectNo: String(context.projectNo || ""),
    materialNo: String(context.materialNo || ""),
  });
}

async function fillBaseFieldsAndObserve(page, runDir) {
  const frame = findZwFrame(page);
  const selected = [];
  selected.push(await selectFrameOption(page, frame, "#field0058_inner, #field0058", accountName, "account", runDir));
  selected.push(await selectFrameOption(page, frame, "#field0096_inner, #field0096", businessName, "business", runDir));
  await page.waitForTimeout(1800);
  selected.push(await selectFrameOption(page, frame, "#field0097_inner, #field0097", industryName, "industry", runDir));
  await page.waitForTimeout(2500);

  const summaries = await captureAllFrames(page, runDir, "10-after-base-fields");
  const fieldValues = await readMainFormValues(frame, { projectNo, materialNo });
  await writeJson(path.join(runDir, "10-after-base-field-values.json"), fieldValues);
  const zwText = summaries.find((item) => item.name === "zwIframe")?.summary?.text || "";
  return {
    selected,
    fieldValues,
    formTextIncludesBaseValues:
      zwText.includes(accountName) && zwText.includes(businessName) && zwText.includes(industryName),
  };
}

async function selectFirstRowChangeType(page, runDir) {
  const frame = findZwFrame(page);
  const info = await frame.evaluate(() => {
    function isVisible(el) {
      const style = getComputedStyle(el);
      return (
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }
    const candidates = [...document.querySelectorAll("input[id^='field0019_'][id$='_inner'],input[id^='field0019_']")]
      .filter(isVisible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.id || "",
          value: el.value || el.getAttribute("value") || "",
          readonly: el.hasAttribute("readonly"),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 },
        };
      })
      .filter((item) => item.rect.y > 300)
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    return candidates[0] || null;
  });
  await writeJson(path.join(runDir, "11-change-type-candidate.json"), info);
  if (!info) {
    return { selected: false, reason: "change-type-input-not-found" };
  }

  await clickByFramePoint(page, frame, { x: info.rect.cx, y: info.rect.cy });
  await page.waitForTimeout(900);
  const clicked = await clickExactVisibleText([frame, page], changeTypeText, {
    nearBox: { x: info.rect.x, y: info.rect.y, width: info.rect.width, height: info.rect.height },
  });
  if (!clicked) {
    await captureAllFrames(page, runDir, "11-change-type-option-missing");
    return { selected: false, reason: "change-type-option-not-found", candidate: info };
  }
  await page.waitForTimeout(1200);
  const after = await frame.evaluate((id) => {
    const el = document.getElementById(id);
    return el ? el.value || el.getAttribute("value") || "" : "";
  }, info.id);
  await captureAllFrames(page, runDir, "11-after-change-type");
  return { selected: true, value: changeTypeText, clicked, before: info, after };
}

async function collectRowProductPickerCandidates(frame) {
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
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }
    const visible = [...document.querySelectorAll("*")].filter(isVisible);
    const directFields = [...document.querySelectorAll("[id^='field0020_'][id$='_id'],#field0020_id,[class*='|field0020']")]
      .filter(isVisible)
      .map((el) => ({
        el,
        tag: el.tagName,
        id: el.id || "",
        className: String(el.className || ""),
        text: textOf(el).slice(0, 80),
        rect: rectOf(el),
      }))
      .filter((item) => item.rect.y > 300)
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const directField = directFields[0] || null;
    if (directField) {
      const icons = [...directField.el.querySelectorAll("[class*='mingxibiaoxuanzeqi'],[class*='relation'],i,span,div")]
        .filter(isVisible)
        .map((el) => ({
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className || ""),
          text: textOf(el).slice(0, 80),
          title: el.getAttribute("title") || "",
          role: el.getAttribute("role") || "",
          onclick: el.getAttribute("onclick") || "",
          rect: rectOf(el),
        }))
        .filter((item) => {
          const nearRight =
            item.rect.cx >= directField.rect.x + directField.rect.width - 28 &&
            item.rect.cx <= directField.rect.x + directField.rect.width + 20;
          const sameY = item.rect.cy >= directField.rect.y - 6 && item.rect.cy <= directField.rect.y + directField.rect.height + 6;
          const compact = item.rect.width <= 45 && item.rect.height <= 45;
          return nearRight && sameY && compact;
        })
        .sort((a, b) => {
          const iconA = /mingxibiaoxuanzeqi|relation/i.test(a.className) ? 0 : 1;
          const iconB = /mingxibiaoxuanzeqi|relation/i.test(b.className) ? 0 : 1;
          return iconA - iconB || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
        });
      const icon = icons[0] || null;
      return {
        directField: {
          tag: directField.tag,
          id: directField.id,
          className: directField.className,
          text: directField.text,
          rect: directField.rect,
        },
        directFields: directFields.slice(0, 10).map((item) => ({
          tag: item.tag,
          id: item.id,
          className: item.className,
          text: item.text,
          rect: item.rect,
        })),
        icons: icons.slice(0, 20),
        clickPoint: {
          x: icon?.rect.cx || directField.rect.x + directField.rect.width - 10,
          y: icon?.rect.cy || directField.rect.y + directField.rect.height / 2,
        },
      };
    }
    const headers = visible
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        className: String(el.className || ""),
        text: textOf(el).slice(0, 80),
        rect: rectOf(el),
      }))
      .filter((item) => /产品编号/.test(item.text));
    const header = headers.sort((a, b) => b.rect.width - a.rect.width)[0] || null;
    const inputs = [...document.querySelectorAll("input,textarea")]
      .filter(isVisible)
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        name: el.getAttribute("name") || "",
        className: String(el.className || ""),
        value: el.value || el.getAttribute("value") || "",
        readonly: el.hasAttribute("readonly"),
        rect: rectOf(el),
      }));
    const productInputs = header
      ? inputs.filter((item) => {
          const sameColumn =
            item.rect.cx >= header.rect.x - 20 && item.rect.cx <= header.rect.x + header.rect.width + 45;
          const firstDataRow = item.rect.y > header.rect.y && item.rect.y < header.rect.y + 120;
          return sameColumn && firstDataRow;
        })
      : [];
    const input = productInputs[0] || null;
    const icons = input
      ? visible
          .filter((el) => !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
          .map((el) => ({
            tag: el.tagName,
            id: el.id || "",
            className: String(el.className || ""),
            text: textOf(el).slice(0, 80),
            title: el.getAttribute("title") || "",
            role: el.getAttribute("role") || "",
            onclick: el.getAttribute("onclick") || "",
            rect: rectOf(el),
          }))
          .filter((item) => {
            const overlapsY = item.rect.cy >= input.rect.y - 4 && item.rect.cy <= input.rect.y + input.rect.height + 4;
            const nearRight =
              item.rect.cx >= input.rect.x + input.rect.width - 8 &&
              item.rect.cx <= input.rect.x + input.rect.width + 32;
            const compact = item.rect.width <= 40 && item.rect.height <= 40;
            return overlapsY && nearRight && compact;
          })
      : [];
    const fallbackInput = inputs
      .filter((item) => item.rect.x >= 190 && item.rect.x <= 380 && item.rect.y > 620)
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0];
    const clickPoint = input
      ? {
          x: icons[0]?.rect.cx || input.rect.x + input.rect.width + 12,
          y: icons[0]?.rect.cy || input.rect.y + input.rect.height / 2,
        }
      : header
        ? {
            x: header.rect.x + header.rect.width - 13,
            y: header.rect.y + 55,
          }
        : fallbackInput
          ? {
              x: fallbackInput.rect.x + fallbackInput.rect.width + 12,
              y: fallbackInput.rect.y + fallbackInput.rect.height / 2,
            }
          : null;
    return {
      header,
      headers: headers.slice(0, 20),
      productInputs: productInputs.slice(0, 20),
      fallbackInput: fallbackInput || null,
      icons: icons.slice(0, 20),
      clickPoint,
    };
  });
}

async function openExistingMaterialPicker(page, runDir) {
  const frame = findZwFrame(page);
  const candidates = await collectRowProductPickerCandidates(frame);
  await writeJson(path.join(runDir, "12-row-product-picker-candidates.json"), candidates);
  if (!candidates.clickPoint) {
    throw new Error("Unable to locate row-level product-number picker icon");
  }
  await clickByFramePoint(page, frame, candidates.clickPoint);
  await page.waitForTimeout(900);

  const optionTexts = rowMaterialOptionCandidates();
  let optionClick = null;
  for (const optionText of optionTexts) {
    const option = frame.getByText(optionText, { exact: true }).first();
    if ((await option.count()) > 0 && (await option.isVisible({ timeout: 1200 }).catch(() => false))) {
      await option.click({ timeout: 5000 });
      optionClick = { method: "row-menu-option", text: optionText, requestedText: rowMaterialOptionText };
      break;
    }
  }
  if (!optionClick) {
    await captureAllFrames(page, runDir, "12-row-material-option-missing");
    throw new Error(`Row material option not found: ${optionTexts.join(" / ")}`);
  }

  await page.waitForTimeout(6000);
  const summaries = await captureAllFrames(page, runDir, "13-after-existing-material-picker-click");
  const pickerLikeFrames = summaries
    .filter((item) => {
      const text = item.summary?.text || "";
      return /查询|搜索|产品编号|物料|料号|确定|取消|选择/.test(text);
    })
    .map((item) => ({
      name: item.name,
      url: item.url,
      text: (item.summary?.text || "").slice(0, 1200),
      visibleInputs: (item.summary?.inputs || []).filter((input) => input.visible).slice(0, 80),
      visibleButtons: (item.summary?.buttons || []).filter((button) => button.visible).slice(0, 80),
    }));
  await writeJson(path.join(runDir, "13-picker-like-frames.json"), pickerLikeFrames);
  return { candidates, optionClick, pickerLikeFrames };
}

async function searchPickerAndSelect(page, runDir, frame, term, filePrefix) {
  const inputs = frame.locator("input[placeholder='搜索关键字']:visible, input[placeholder]:visible");
  const inputCount = await inputs.count();
  if (inputCount === 0) {
    throw new Error(`No visible search input in picker for ${term}`);
  }

  const indexes = [...Array(Math.min(inputCount, 4)).keys()];
  const attempts = [];
  for (const index of indexes) {
    const reset = frame.getByText("重置", { exact: true }).first();
    if ((await reset.count()) > 0 && (await reset.isVisible({ timeout: 700 }).catch(() => false))) {
      await reset.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(700);
    }
    await inputs.nth(index).fill(term);
    await frame.getByText("筛选", { exact: true }).click({ timeout: 5000 });
    let matchedRows = [];
    if (isFast()) {
      matchedRows = (await waitForPickerMatchedRows(page, frame, term, 7000)).value || [];
    } else {
      await page.waitForTimeout(4500);
      matchedRows = await extractVisibleTextRows(frame, escapeRegExp(term));
    }
    attempts.push({ index, matchedRows });
    if (matchedRows.length > 0) {
      await writeJson(path.join(runDir, `${filePrefix}-matched-rows.json`), matchedRows);
      const rowClick = await clickMatchedPickerRow(frame, term);
      await writeJson(path.join(runDir, `${filePrefix}-row-click.json`), rowClick);
      if (!rowClick.clicked) {
        throw new Error(`Unable to click matched picker row: ${rowClick.reason || term}`);
      }
      await page.waitForTimeout(isFast() ? 300 : 1000);
      await captureAllFrames(page, runDir, `${filePrefix}-after-row-click`);
      await page.locator("a:has-text('确定'), button:has-text('确定')").last().click({ timeout: 5000 });
      const closeWait = isFast() ? await waitForMaterialPickerClosed(page, 8000) : null;
      if (!isFast()) {
        await page.waitForTimeout(9000);
      }
      return { inputIndex: index, matchedRows, rowClick, closeWait };
    }
  }
  await writeJson(path.join(runDir, `${filePrefix}-search-attempts.json`), attempts);
  await captureAllFrames(page, runDir, `${filePrefix}-search-no-match`);
  throw new Error(`Picker item not found: ${term}`);
}

async function selectExistingMaterialAndObserve(page, runDir) {
  const pickerFrame = findMaterialPickerFrame(page);
  if (!pickerFrame) {
    await captureAllFrames(page, runDir, "14-material-picker-frame-missing");
    throw new Error("Existing material picker iframe not found");
  }
  const selection = await searchPickerAndSelect(page, runDir, pickerFrame, materialNo, "14-material-search");
  const summaries = await captureAllFrames(page, runDir, "15-after-material-confirm");
  const zwSummary = summaries.find((item) => item.name === "zwIframe")?.summary || {};
  const rowState = await readMaterialRowState(findZwFrame(page), materialNo);
  await writeJson(path.join(runDir, "15-material-row-after-confirm.json"), rowState);
  return {
    materialNo,
    selection,
    backfilledTextIncludesMaterial: (zwSummary.text || "").includes(materialNo),
    rowState,
  };
}

async function readMaterialRowState(frame, code, preferredRecordId = "") {
  return frame.evaluate(({ materialCode, recordId }) => {
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
    function materialToken(el) {
      const tokens = textOf(el).split(/\s+/).filter(Boolean);
      return /^\d+$/.test(tokens[0] || "") ? tokens[1] || "" : tokens[0] || "";
    }
    function rowRecordId(row) {
      const field = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],input[id^='field0019_'],[class*='|field0020']")]
        .find(isVisible);
      const source = field ? `${field.id || ""} ${field.className || ""}` : String(row.className || "");
      return (
        source.match(/field0020_([^_|\s]+)_id/)?.[1] ||
        source.match(/field0019_([^_|\s]+)(?:_inner)?/)?.[1] ||
        source.match(/\|(-?\d+)\|field0020/)?.[1] ||
        source.match(/\|(-?\d+)\|/)?.[1] ||
        ""
      );
    }
    const allRows = [...document.querySelectorAll("tr,.cap4-table-row,[class*='table'] [class*='row']")]
      .filter(isVisible);
    const matchedRows = materialCode
      ? allRows.filter((el) => materialToken(el) === materialCode)
      : allRows;
    const rows = recordId
      ? matchedRows.filter((row) => rowRecordId(row) === recordId)
      : matchedRows;
    const effectiveRows = rows.length ? rows : matchedRows;
    return effectiveRows.map((row) => ({
      tag: row.tagName,
      className: String(row.className || ""),
      recordId: rowRecordId(row),
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
            readonly: el.hasAttribute("readonly"),
            value: el.value || el.getAttribute("value") || "",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              cx: Math.round(rect.x + rect.width / 2),
            },
          };
        }),
    }));
  }, { materialCode: code, recordId: preferredRecordId });
}

function hasTaxPrice(item) {
  return item.taxPrice !== undefined && item.taxPrice !== null && String(item.taxPrice) !== "";
}

function shouldFillQty(item) {
  return item.allowBlankQty || (item.qty !== undefined && item.qty !== null && String(item.qty) !== "");
}

function shouldFillTaxPrice(item) {
  return item.allowBlankTaxPrice || hasTaxPrice(item);
}

function numbersMatch(actual, expected) {
  const actualNumber = Number.parseFloat(String(actual || "").replace(/,/g, ""));
  const expectedNumber = Number.parseFloat(String(expected || "").replace(/,/g, ""));
  if (Number.isNaN(actualNumber) || Number.isNaN(expectedNumber)) {
    return String(actual || "").trim() === String(expected || "").trim();
  }
  return Math.abs(actualNumber - expectedNumber) < 0.0001;
}

function valuesAreBlank(values) {
  return values.length > 0 && values.every((value) => String(value ?? "").trim() === "");
}

function valuesInColumn(rowState, xMin, xMax) {
  return (rowState || []).flatMap((row) =>
    (row.inputs || [])
      .filter((input) => input.rect?.cx >= xMin && input.rect?.cx <= xMax)
      .map((input) => input.value)
  );
}

function readChangeTypeFromRowState(rowState) {
  const inputs = (rowState || []).flatMap((row) => row.inputs || []);
  return (
    inputs.find((input) => /^field0019_/.test(input.id || ""))?.value ||
    inputs[0]?.value ||
    ""
  );
}

function assertChangeRowSanity(item, rowState, context = "") {
  if (!rowState?.length) {
    throw new Error(`Final sanity failed: row not found ${item.code || item.label}${context ? ` (${context})` : ""}`);
  }
  const changeValue = readChangeTypeFromRowState(rowState);
  const expectedChangeType = changeTypeForItem(item);
  if (String(changeValue).trim() !== expectedChangeType) {
    if (item.allowBlankCode) {
      itemWarnings.push({
        type: "blank-code-change-type-not-visible",
        code: item.code || "",
        label: item.label || "",
        sourceRow: item.sourceRow ?? "",
        sourceRows: item.sourceRows || [],
        expected: expectedChangeType,
        actual: changeValue,
        context,
      });
      return;
    }
    throw new Error(
      `Final sanity failed: change type for ${item.code} is ${JSON.stringify(changeValue)}, expected ${JSON.stringify(expectedChangeType)}${context ? ` (${context})` : ""}`
    );
  }
  const qtyValues = valuesInColumn(rowState, 540, 700);
  if (item.allowBlankQty && String(item.qty) === "") {
    if (!valuesAreBlank(qtyValues)) {
      throw new Error(
        `Final sanity failed: quantity for ${item.code || item.label} expected blank, values=${qtyValues.join("|")}${context ? ` (${context})` : ""}`
      );
    }
  } else if (!qtyValues.some((value) => numbersMatch(value, item.qty))) {
    throw new Error(
      `Final sanity failed: quantity for ${item.code || item.label} expected ${item.qty}, values=${qtyValues.join("|")}${context ? ` (${context})` : ""}`
    );
  }
  if (shouldFillTaxPrice(item)) {
    const priceValues = valuesInColumn(rowState, 790, 950);
    if (item.allowBlankTaxPrice && String(item.taxPrice) === "") {
      if (!valuesAreBlank(priceValues)) {
        throw new Error(
          `Final sanity failed: tax price for ${item.code || item.label} expected blank, values=${priceValues.join("|")}${context ? ` (${context})` : ""}`
        );
      }
    } else if (!priceValues.some((value) => numbersMatch(value, item.taxPrice))) {
      throw new Error(
        `Final sanity failed: tax price for ${item.code || item.label} expected ${item.taxPrice}, values=${priceValues.join("|")}${context ? ` (${context})` : ""}`
      );
    }
  }
}

async function fillInputByColumnX(frame, code, xMin, xMax, value, preferredRecordId = "") {
  return frame.evaluate(
    ({ materialCode, min, max, fillValue, recordId }) => {
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
      function materialToken(el) {
        const tokens = textOf(el).split(/\s+/).filter(Boolean);
        return /^\d+$/.test(tokens[0] || "") ? tokens[1] || "" : tokens[0] || "";
      }
      function rowRecordId(row) {
        const field = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],input[id^='field0019_'],[class*='|field0020']")]
          .find(isVisible);
        const source = field ? `${field.id || ""} ${field.className || ""}` : String(row.className || "");
        return (
          source.match(/field0020_([^_|\s]+)_id/)?.[1] ||
          source.match(/field0019_([^_|\s]+)(?:_inner)?/)?.[1] ||
          source.match(/\|(-?\d+)\|field0020/)?.[1] ||
          source.match(/\|(-?\d+)\|/)?.[1] ||
          ""
        );
      }
      const allRows = [...document.querySelectorAll("tr,.cap4-table-row,[class*='table'] [class*='row']")]
        .filter(isVisible);
      const rows = materialCode ? allRows.filter((el) => materialToken(el) === materialCode) : allRows;
      const row = recordId ? rows.find((el) => rowRecordId(el) === recordId) || rows[0] : rows[0];
      if (!row) return { filled: false, reason: "row-not-found" };
      const candidates = [...row.querySelectorAll("input,textarea")]
        .filter((el) => isVisible(el) && !el.hasAttribute("readonly") && !el.disabled)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2 } };
        })
        .filter((item) => item.rect.cx >= min && item.rect.cx <= max)
        .sort((a, b) => {
          const activeA = String(a.el.className || "").includes("is-activeInput") ? 0 : 1;
          const activeB = String(b.el.className || "").includes("is-activeInput") ? 0 : 1;
          return activeA - activeB;
        });
      const target = candidates[0];
      if (!target) {
        return { filled: false, reason: "input-not-found", candidateCount: candidates.length };
      }
      target.el.focus();
      target.el.value = "";
      target.el.dispatchEvent(new Event("input", { bubbles: true }));
      target.el.value = fillValue;
      target.el.dispatchEvent(new Event("input", { bubbles: true }));
      target.el.dispatchEvent(new Event("change", { bubbles: true }));
      target.el.blur();
      return {
        filled: true,
        value: fillValue,
        recordId: rowRecordId(row),
        id: target.el.id || "",
        className: String(target.el.className || ""),
        rect: {
          x: Math.round(target.rect.x),
          y: Math.round(target.rect.y),
          width: Math.round(target.rect.width),
          height: Math.round(target.rect.height),
        },
      };
    },
    { materialCode: code, min: xMin, max: xMax, fillValue: value, recordId: preferredRecordId }
  );
}

async function fillInputByLabel(frame, labelText, value) {
  return frame.evaluate(
    ({ label, fillValue }) => {
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
        return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      }
      const labels = [...document.querySelectorAll("td,th,label,span,div,p")]
        .map((el) => ({ el, text: textOf(el), rect: rectOf(el) }))
        .filter((item) => item.text === label || item.text.includes(label))
        .filter((item) => item.rect.width > 8 && item.rect.width <= 280 && item.rect.height > 8 && item.rect.height <= 80)
        .sort((a, b) => {
          const exactA = a.text === label ? 0 : 1;
          const exactB = b.text === label ? 0 : 1;
          const areaA = a.rect.width * a.rect.height;
          const areaB = b.rect.width * b.rect.height;
          return exactA - exactB || areaA - areaB || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
        });
      const labelItem = labels[0];
      if (!labelItem) return { filled: false, reason: "label-not-found", label };
      const labelEl = labelItem.el;
      labelEl.scrollIntoView({ block: "center", inline: "nearest" });
      const labelRect = rectOf(labelEl);
      const candidates = [...document.querySelectorAll("input,textarea")]
        .filter((el) => !el.hasAttribute("readonly") && !el.disabled)
        .map((el) => ({ el, rect: rectOf(el), visible: isVisible(el), value: el.value || el.getAttribute("value") || "" }))
        .filter((item) => {
          const sameBand = item.rect.cy >= labelRect.y - 16 && item.rect.cy <= labelRect.y + labelRect.height + 24;
          const toRight = item.rect.x >= labelRect.x + labelRect.width - 8;
          const notTooFar = item.rect.x <= labelRect.x + labelRect.width + 520;
          return sameBand && toRight && notTooFar;
        })
        .sort((a, b) => {
          const visiblePenaltyA = a.visible ? 0 : 1000;
          const visiblePenaltyB = b.visible ? 0 : 1000;
          return visiblePenaltyA - visiblePenaltyB || Math.abs(a.rect.x - labelRect.x) - Math.abs(b.rect.x - labelRect.x);
        });
      const target = candidates[0];
      if (!target) {
        return { filled: false, reason: "input-not-found", label, labelRect };
      }
      target.el.focus();
      target.el.value = "";
      target.el.dispatchEvent(new Event("input", { bubbles: true }));
      target.el.value = fillValue;
      target.el.dispatchEvent(new Event("input", { bubbles: true }));
      target.el.dispatchEvent(new Event("change", { bubbles: true }));
      target.el.blur();
      return {
        filled: true,
        label,
        value: fillValue,
        id: target.el.id || "",
        className: String(target.el.className || ""),
        labelRect: {
          x: Math.round(labelRect.x),
          y: Math.round(labelRect.y),
          width: Math.round(labelRect.width),
          height: Math.round(labelRect.height),
        },
        rect: {
          x: Math.round(target.rect.x),
          y: Math.round(target.rect.y),
          width: Math.round(target.rect.width),
          height: Math.round(target.rect.height),
        },
      };
    },
    { label: labelText, fillValue: value }
  );
}

async function scrollQuoteRowsTowardBottom(frame) {
  return frame.evaluate(() => {
    function isRenderable(el) {
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
    for (const el of [...document.querySelectorAll("*")]) {
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 80) {
        el.scrollTop = el.scrollHeight;
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
    const rows = [...document.querySelectorAll("tr.formson-line,[class*='formson-line']")]
      .filter(isRenderable);
    const lastRow = rows.at(-1);
    if (lastRow) {
      lastRow.scrollIntoView({ block: "center", inline: "nearest" });
    }
    return { rowCount: rows.length, lastRowText: lastRow ? textOf(lastRow).slice(0, 220) : "" };
  });
}

async function clickQuoteNewRow(page, runDir, rowIndex, usedCodes = [], usedRecordIds = []) {
  const frame = findZwFrame(page);
  const beforeRows = await readQuoteRowSnapshot(frame);
  const attempts = [];

  async function recordAttempt(method, details = {}) {
    let blankRow = null;
    let rowSnapshot = [];
    const polls = [];
    for (let poll = 0; poll < 12; poll += 1) {
      await page.waitForTimeout(1000);
      const scrollInfo = await scrollQuoteRowsTowardBottom(frame).catch((error) => ({ error: String(error) }));
      blankRow = await findBlankQuoteRow(frame, usedCodes, usedRecordIds);
      rowSnapshot = await readQuoteRowSnapshot(frame);
      polls.push({ poll, scrollInfo, blankRow, rowSnapshotCount: rowSnapshot.length });
      if (blankRow) {
        break;
      }
    }
    const attempt = { method, details, blankRow, rowSnapshot };
    if (!blankRow) {
      attempt.polls = polls;
    }
    attempts.push(attempt);
    await writeJson(path.join(runDir, `row-${rowIndex + 1}-new-row-attempt-${attempts.length}.json`), attempt);
    return blankRow;
  }

  try {
    const quoteSection = frame.locator("#tableName-front_formson_1").first();
    const newButton = quoteSection.getByText("新建", { exact: true }).first();
    if ((await newButton.count()) > 0 && (await newButton.isVisible({ timeout: 1000 }).catch(() => false))) {
      await newButton.click({ timeout: 5000 });
      const blankRow = await recordAttempt("toolbar-text-new");
      if (blankRow) {
        return { beforeRows, attempts, selectedAttempt: attempts.at(-1) };
      }
    }
  } catch (error) {
    attempts.push({ method: "toolbar-text-new", error: String(error) });
  }

  const clickInfo = await frame.evaluate(() => {
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
    const section = document.querySelector("#tableName-front_formson_1") || document.body;
    const button = [...section.querySelectorAll("button,a,div,span")]
      .filter((el) => isVisible(el) && textOf(el) === "新建")
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: textOf(el),
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className || ""),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 },
        };
      })
      .filter((item) => item.rect.y > 600)
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)[0];
    return button || null;
  });
  await writeJson(path.join(runDir, `row-${rowIndex + 1}-new-row-click-info.json`), clickInfo);
  if (clickInfo) {
    await clickByFramePoint(page, frame, { x: clickInfo.rect.cx, y: clickInfo.rect.cy });
    const blankRow = await recordAttempt("toolbar-mouse-new", clickInfo);
    if (blankRow) {
      return { beforeRows, attempts, selectedAttempt: attempts.at(-1) };
    }
  }

  const inlineNew = await clickExactVisibleText([frame], "新建一行");
  if (inlineNew) {
    const blankRow = await recordAttempt("inline-text-new-row", inlineNew);
    if (blankRow) {
      return { beforeRows, attempts, selectedAttempt: attempts.at(-1) };
    }
  }

  const rowPlus = await frame.evaluate(() => {
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
    const candidates = [...document.querySelectorAll("*")]
      .filter(isVisible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className || ""),
          text: textOf(el),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 },
        };
      })
      .filter((item) => {
        const leftOfRows = item.rect.x >= 55 && item.rect.x <= 105;
        const rowBand = item.rect.y >= 300 && item.rect.y <= 860;
        const compact = item.rect.width <= 40 && item.rect.height <= 40;
        const plusLike = item.text === "+" || /jiahao|add|plus/i.test(item.className);
        return leftOfRows && rowBand && compact && plusLike;
      })
      .sort((a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x);
    return candidates[0] || null;
  });
  if (rowPlus) {
    await clickByFramePoint(page, frame, { x: rowPlus.rect.cx, y: rowPlus.rect.cy });
    await page.waitForTimeout(800);
    const menuClick = await clickExactVisibleText([frame], "新建一行");
    const blankRow = await recordAttempt("row-plus-new-row", { rowPlus, menuClick });
    if (blankRow) {
      return { beforeRows, attempts, selectedAttempt: attempts.at(-1) };
    }
  }

  await writeJson(path.join(runDir, `row-${rowIndex + 1}-new-row-failed.json`), { beforeRows, attempts });
  throw new Error(`Quote-list blank row was not created for row ${rowIndex + 1}`);
}

async function prepareFastBlankRows(page, runDir, itemCount) {
  if (!isFast() || itemCount <= 0) {
    return [];
  }
  const frame = findZwFrame(page);
  const rows = [];
  const firstBlank = await findBlankQuoteRow(frame, [], []);
  if (!firstBlank) {
    await captureAllFrames(page, runDir, "fast-batch-first-blank-row-not-found");
    throw new Error("Fast batch row preparation failed: first blank quote row not found");
  }
  rows.push({ index: 1, recordId: firstBlank.recordId || "", rowInfo: firstBlank, created: false });

  for (let index = 1; index < itemCount; index += 1) {
    const usedRecordIds = rows.map((row) => row.recordId).filter(Boolean);
    const addResult = await clickQuoteNewRow(page, runDir, index, [], usedRecordIds);
    const blankRow =
      addResult?.selectedAttempt?.blankRow ||
      (await findBlankQuoteRow(frame, [], usedRecordIds));
    if (!blankRow) {
      await captureAllFrames(page, runDir, `fast-batch-row-${index + 1}-not-created`);
      throw new Error(`Fast batch row preparation failed: row ${index + 1} not created`);
    }
    rows.push({
      index: index + 1,
      recordId: blankRow.recordId || "",
      rowInfo: blankRow,
      created: true,
    });
  }

  await writeJson(path.join(runDir, "fast-batch-blank-rows.json"), {
    itemCount,
    rows: rows.map((row) => ({ index: row.index, recordId: row.recordId, created: row.created })),
  });
  return rows;
}

async function readQuoteRowSnapshot(frame) {
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
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }
    return [...document.querySelectorAll("[id^='field0020_'][id$='_id'],[class*='|field0020']")]
      .filter(isVisible)
      .map((field) => {
        const row = field.closest("tr") || field.closest(".formson-line") || field.parentElement;
        return {
          id: field.id || "",
          className: String(field.className || ""),
          fieldText: textOf(field),
          rowText: row ? textOf(row).slice(0, 500) : textOf(field),
          rect: rectOf(field),
        };
      })
      .filter((item) => item.rect.y > 600)
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  });
}

async function findBlankQuoteRow(frame, usedCodes = [], usedRecordIds = []) {
  return frame.evaluate(({ codes, recordIds }) => {
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
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }
    const fields = [...document.querySelectorAll("[id^='field0020_'][id$='_id'],[class*='|field0020']")]
      .filter(isVisible)
      .map((field) => {
        const recordMatch = (field.id || String(field.className || "")).match(/field0020_([^_|\s]+)|\|(-?\d+)\|field0020/);
        const recordId = recordMatch ? recordMatch[1] || recordMatch[2] || "" : "";
        const fieldRect = rectOf(field);
        const row = field.closest("tr") || field.closest(".formson-line") || field.parentElement;
        const rowText = row ? textOf(row) : textOf(field);
        const icons = [...field.querySelectorAll("[class*='mingxibiaoxuanzeqi'],[class*='relation'],i,span,div")]
          .filter(isVisible)
          .map((el) => ({
            tag: el.tagName,
            className: String(el.className || ""),
            rect: rectOf(el),
          }))
          .filter((item) => {
            const nearRight = item.rect.cx >= fieldRect.x + fieldRect.width - 30 && item.rect.cx <= fieldRect.x + fieldRect.width + 24;
            const sameY = item.rect.cy >= fieldRect.y - 6 && item.rect.cy <= fieldRect.y + fieldRect.height + 6;
            return nearRight && sameY && item.rect.width <= 45 && item.rect.height <= 45;
          })
          .sort((a, b) => {
            const iconA = /mingxibiaoxuanzeqi|relation/i.test(a.className) ? 0 : 1;
            const iconB = /mingxibiaoxuanzeqi|relation/i.test(b.className) ? 0 : 1;
            return iconA - iconB || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
          });
        const changeInput = recordId
          ? document.getElementById(`field0019_${recordId}_inner`) ||
            document.getElementById(`field0019_${recordId}`)
          : row
            ? [...row.querySelectorAll("input[id^='field0019_']")][0]
            : null;
        const changeRect = changeInput ? rectOf(changeInput) : null;
        return {
          recordId,
          fieldId: field.id || "",
          fieldText: textOf(field),
          rowText,
          fieldRect,
          iconRect: icons[0]?.rect || {
            x: fieldRect.x + fieldRect.width - 18,
            y: fieldRect.y,
            width: 18,
            height: fieldRect.height,
            cx: fieldRect.x + fieldRect.width - 9,
            cy: fieldRect.y + fieldRect.height / 2,
          },
          changeInputId: changeInput?.id || "",
          changeRect,
          hasUsedCode: codes.some((code) => rowText.includes(code)),
          hasUsedRecord: recordIds.includes(recordId),
        };
      })
      .filter((item) => item.fieldRect.y > 300 && !item.hasUsedCode && !item.hasUsedRecord)
      .sort((a, b) => a.fieldRect.y - b.fieldRect.y || a.fieldRect.x - b.fieldRect.x);
    if (fields[0]) return fields[0];

    const rowFallbacks = [...document.querySelectorAll("tr.formson-line,[class*='formson-line']")]
      .filter(isVisible)
      .map((row) => {
        const rowRect = rectOf(row);
        const rowText = textOf(row);
        const recordFromClass = String(row.className || "").match(/\|(-?\d+)\|/)?.[1] || "";
        const productField = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],[class*='|field0020']")].find(isVisible);
        const productRect = productField ? rectOf(productField) : {
          x: 213,
          y: rowRect.y + 7,
          width: 137,
          height: 30,
          cx: 281.5,
          cy: rowRect.y + 22,
        };
        const productIcon = productField
          ? [...productField.querySelectorAll("[class*='mingxibiaoxuanzeqi'],[class*='relation'],i,span,div")]
              .filter(isVisible)
              .map((el) => ({ className: String(el.className || ""), rect: rectOf(el) }))
              .sort((a, b) => {
                const iconA = /mingxibiaoxuanzeqi|relation/i.test(a.className) ? 0 : 1;
                const iconB = /mingxibiaoxuanzeqi|relation/i.test(b.className) ? 0 : 1;
                return iconA - iconB || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
              })[0]
          : null;
        const changeInput = [...row.querySelectorAll("input[id^='field0019_']")].find(isVisible);
        const changeRect = changeInput ? rectOf(changeInput) : {
          x: 154,
          y: rowRect.y + 8,
          width: 35,
          height: 28,
          cx: 171.5,
          cy: rowRect.y + 22,
        };
        return {
          recordId: recordFromClass || (changeInput?.id || "").match(/field0019_([^_]+)_inner/)?.[1] || "",
          fieldId: productField?.id || "",
          fieldText: productField ? textOf(productField) : "产品编号",
          rowText,
          fieldRect: productRect,
          iconRect: productIcon?.rect || {
            x: productRect.x + productRect.width - 17,
            y: productRect.y,
            width: 16,
            height: 28,
            cx: productRect.x + productRect.width - 8,
            cy: productRect.y + productRect.height / 2,
          },
          changeInputId: changeInput?.id || "",
          changeRect,
          hasUsedCode: codes.some((code) => rowText.includes(code)),
          hasUsedRecord: recordIds.includes(recordFromClass || (changeInput?.id || "").match(/field0019_([^_]+)_inner/)?.[1] || ""),
        };
      })
      .filter((item) => item.fieldRect.y > 300 && !item.hasUsedCode && !item.hasUsedRecord)
      .filter((item) => (item.rowText ? /^\d+\s/.test(item.rowText) || item.recordId : !!item.recordId))
      .filter((item) => !/合价汇总|原辅料|变更后辅料|节点名称/.test(item.rowText))
      .sort((a, b) => a.fieldRect.y - b.fieldRect.y || a.fieldRect.x - b.fieldRect.x);
    return rowFallbacks[0] || null;
  }, { codes: usedCodes, recordIds: usedRecordIds });
}

async function findQuoteRowByRecordId(frame, preferredRecordId = "") {
  if (!preferredRecordId) return null;
  return frame.evaluate((recordId) => {
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
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }
    function rowRecordId(row) {
      const field = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],input[id^='field0019_'],[class*='|field0020']")]
        .find(isVisible);
      const source = field ? `${field.id || ""} ${field.className || ""}` : String(row.className || "");
      return (
        source.match(/field0020_([^_|\s]+)_id/)?.[1] ||
        source.match(/field0019_([^_|\s]+)(?:_inner)?/)?.[1] ||
        source.match(/\|(-?\d+)\|field0020/)?.[1] ||
        source.match(/\|(-?\d+)\|/)?.[1] ||
        ""
      );
    }

    const rows = [...document.querySelectorAll("tr.formson-line,[class*='formson-line'],tr,.cap4-table-row")]
      .filter((el) => isVisible(el) && rowRecordId(el) === recordId)
      .sort((a, b) => rectOf(a).y - rectOf(b).y);
    const row = rows[0];
    if (!row) return null;
    const rowRect = rectOf(row);
    const rowText = textOf(row);
    const productField = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],[class*='|field0020']")].find(isVisible);
    const productRect = productField
      ? rectOf(productField)
      : {
          x: 213,
          y: rowRect.y + 7,
          width: 137,
          height: 30,
          cx: 281.5,
          cy: rowRect.y + 22,
        };
    const productIcon = productField
      ? [...productField.querySelectorAll("[class*='mingxibiaoxuanzeqi'],[class*='relation'],i,span,div")]
          .filter(isVisible)
          .map((el) => ({ className: String(el.className || ""), rect: rectOf(el) }))
          .sort((a, b) => {
            const iconA = /mingxibiaoxuanzeqi|relation/i.test(a.className) ? 0 : 1;
            const iconB = /mingxibiaoxuanzeqi|relation/i.test(b.className) ? 0 : 1;
            return iconA - iconB || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
          })[0]
      : null;
    const changeInput = [...row.querySelectorAll("input[id^='field0019_']")].find(isVisible);
    const changeRect = changeInput
      ? rectOf(changeInput)
      : {
          x: 154,
          y: rowRect.y + 8,
          width: 35,
          height: 28,
          cx: 171.5,
          cy: rowRect.y + 22,
        };
    return {
      recordId: rowRecordId(row),
      fieldId: productField?.id || "",
      fieldText: productField ? textOf(productField) : "莠ｧ蜩∫ｼ門捷",
      rowText,
      fieldRect: productRect,
      iconRect: productIcon?.rect || {
        x: productRect.x + productRect.width - 17,
        y: productRect.y,
        width: 16,
        height: 28,
        cx: productRect.x + productRect.width - 8,
        cy: productRect.y + productRect.height / 2,
      },
      changeInputId: changeInput?.id || "",
      changeRect,
      hasUsedCode: false,
    };
  }, preferredRecordId);
}

async function scrollQuoteRowIntoView(frame, preferredRecordId = "") {
  if (!preferredRecordId) {
    return { scrolled: false, reason: "missing-record-id" };
  }
  return frame.evaluate((recordId) => {
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
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }
    function rowRecordId(row) {
      const field = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],input[id^='field0019_'],[class*='|field0020']")]
        .find(isVisible);
      const source = field ? `${field.id || ""} ${field.className || ""}` : String(row.className || "");
      return (
        source.match(/field0020_([^_|\s]+)_id/)?.[1] ||
        source.match(/field0019_([^_|\s]+)(?:_inner)?/)?.[1] ||
        source.match(/\|(-?\d+)\|field0020/)?.[1] ||
        source.match(/\|(-?\d+)\|/)?.[1] ||
        ""
      );
    }

    const row = [...document.querySelectorAll("tr.formson-line,[class*='formson-line'],tr,.cap4-table-row")]
      .find((el) => isVisible(el) && rowRecordId(el) === recordId);
    if (!row) {
      return { scrolled: false, reason: "row-not-found", recordId };
    }
    const before = rectOf(row);
    row.scrollIntoView({ block: "center", inline: "nearest" });
    const after = rectOf(row);
    return { scrolled: true, recordId, before, after, rowText: textOf(row).slice(0, 200) };
  }, preferredRecordId);
}

async function findQuoteRowByMaterialCode(frame, code, preferredRecordId = "") {
  return frame.evaluate(({ materialCode, recordId }) => {
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
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }
    function materialToken(el) {
      const tokens = textOf(el).split(/\s+/).filter(Boolean);
      return /^\d+$/.test(tokens[0] || "") ? tokens[1] || "" : tokens[0] || "";
    }
    function rowRecordId(row) {
      const field = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],input[id^='field0019_'],[class*='|field0020']")]
        .find(isVisible);
      const source = field ? `${field.id || ""} ${field.className || ""}` : String(row.className || "");
      return (
        source.match(/field0020_([^_|\s]+)_id/)?.[1] ||
        source.match(/field0019_([^_|\s]+)(?:_inner)?/)?.[1] ||
        source.match(/\|(-?\d+)\|field0020/)?.[1] ||
        source.match(/\|(-?\d+)\|/)?.[1] ||
        ""
      );
    }
    const rows = [...document.querySelectorAll("tr.formson-line,[class*='formson-line'],tr,.cap4-table-row")]
      .filter((el) => isVisible(el) && materialToken(el) === materialCode)
      .sort((a, b) => rectOf(a).y - rectOf(b).y);
    const row = recordId ? rows.find((el) => rowRecordId(el) === recordId) || rows[0] : rows[0];
    if (!row) return null;
    const rowRect = rectOf(row);
    const rowText = textOf(row);
    const productField = [...row.querySelectorAll("[id^='field0020_'][id$='_id'],[class*='|field0020']")].find(isVisible);
    const productRect = productField
      ? rectOf(productField)
      : {
          x: 213,
          y: rowRect.y + 7,
          width: 137,
          height: 30,
          cx: 281.5,
          cy: rowRect.y + 22,
        };
    const productIcon = productField
      ? [...productField.querySelectorAll("[class*='mingxibiaoxuanzeqi'],[class*='relation'],i,span,div")]
          .filter(isVisible)
          .map((el) => ({ className: String(el.className || ""), rect: rectOf(el) }))
          .sort((a, b) => {
            const iconA = /mingxibiaoxuanzeqi|relation/i.test(a.className) ? 0 : 1;
            const iconB = /mingxibiaoxuanzeqi|relation/i.test(b.className) ? 0 : 1;
            return iconA - iconB || a.rect.width * a.rect.height - b.rect.width * b.rect.height;
          })[0]
      : null;
    const changeInput = [...row.querySelectorAll("input[id^='field0019_']")].find(isVisible);
    const changeRect = changeInput ? rectOf(changeInput) : {
      x: 154,
      y: rowRect.y + 8,
      width: 35,
      height: 28,
      cx: 171.5,
      cy: rowRect.y + 22,
    };
    return {
      recordId: rowRecordId(row),
      fieldId: productField?.id || "",
      fieldText: productField ? textOf(productField) : "产品编号",
      rowText,
      fieldRect: productRect,
      iconRect: productIcon?.rect || {
        x: productRect.x + productRect.width - 17,
        y: productRect.y,
        width: 16,
        height: 28,
        cx: productRect.x + productRect.width - 8,
        cy: productRect.y + productRect.height / 2,
      },
      changeInputId: changeInput?.id || "",
      changeRect,
      hasUsedCode: true,
    };
  }, { materialCode: code, recordId: preferredRecordId });
}

async function selectChangeTypeForRow(page, runDir, rowInfo, rowIndex, item = {}) {
  if (!rowInfo?.changeRect) {
    throw new Error(`Change-type field not found for row ${rowIndex + 1}`);
  }
  const targetChangeType = changeTypeForItem(item);
  const frame = findZwFrame(page);
  let targetRowInfo = rowInfo;
  let scrollResult = null;
  if (rowInfo.recordId) {
    scrollResult = await scrollQuoteRowIntoView(frame, rowInfo.recordId);
    if (scrollResult.scrolled) {
      await page.waitForTimeout(isFast() ? 150 : 500);
      targetRowInfo = (await findQuoteRowByRecordId(frame, rowInfo.recordId)) || rowInfo;
    }
  }
  await clickByFramePoint(page, frame, { x: targetRowInfo.changeRect.cx, y: targetRowInfo.changeRect.cy });
  await page.waitForTimeout(900);
  const clicked = await clickExactVisibleText([frame, page], targetChangeType, {
    nearBox: {
      x: targetRowInfo.changeRect.x,
      y: targetRowInfo.changeRect.y,
      width: targetRowInfo.changeRect.width,
      height: targetRowInfo.changeRect.height,
    },
    allowAbove: true,
    excludeTableRows: true,
  });
  if (!clicked) {
    const directSet = await frame.evaluate(
      ({ id, value }) => {
        const el = document.getElementById(id);
        if (!el) return { set: false, reason: "input-not-found", id };
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
        return { set: true, id, value: el.value };
      },
      { id: targetRowInfo.changeInputId, value: targetChangeType }
    );
    await writeJson(path.join(runDir, `row-${rowIndex + 1}-change-type-direct-set.json`), directSet);
    if (!directSet.set) {
      await captureAllFrames(page, runDir, `row-${rowIndex + 1}-change-type-option-missing`);
      throw new Error(`Change-type option not found for row ${rowIndex + 1}: ${targetChangeType}`);
    }
    await page.waitForTimeout(800);
    return { selected: true, value: targetChangeType, clicked: null, directSet, scrollResult, before: targetRowInfo, after: directSet.value };
  }
  await page.waitForTimeout(1200);
  const after = await frame.evaluate((id) => {
    const el = document.getElementById(id);
    return el ? el.value || el.getAttribute("value") || "" : "";
  }, targetRowInfo.changeInputId);
  if (String(after).trim() !== targetChangeType) {
    const directSet = await frame.evaluate(
      ({ id, value }) => {
        const el = document.getElementById(id);
        if (!el) return { set: false, reason: "input-not-found", id };
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
        return { set: true, id, value: el.value };
      },
      { id: targetRowInfo.changeInputId, value: targetChangeType }
    );
    await writeJson(path.join(runDir, `row-${rowIndex + 1}-change-type-after-click-direct-set.json`), directSet);
    if (directSet.set) {
      await page.waitForTimeout(500);
      return { selected: true, value: targetChangeType, clicked, directSet, scrollResult, before: targetRowInfo, after: directSet.value };
    }
  }
  return { selected: true, value: targetChangeType, clicked, scrollResult, before: targetRowInfo, after };
}

async function openExistingMaterialPickerForRow(page, runDir, rowInfo, rowIndex, item = {}) {
  const frame = findZwFrame(page);
  if (!rowInfo?.iconRect) {
    throw new Error(`Product-number relation icon not found for row ${rowIndex + 1}`);
  }
  let targetRowInfo = rowInfo;
  let scrollResult = null;
  if (rowInfo.recordId) {
    scrollResult = await scrollQuoteRowIntoView(frame, rowInfo.recordId);
    if (scrollResult.scrolled) {
      await page.waitForTimeout(isFast() ? 150 : 500);
      targetRowInfo = (await findQuoteRowByRecordId(frame, rowInfo.recordId)) || rowInfo;
    }
  }
  await writeJson(path.join(runDir, `row-${rowIndex + 1}-target-row.json`), targetRowInfo);

  const targetChangeType = changeTypeForItem(item);
  const requestedOptionText = rowMaterialOptionTextForChangeType(targetChangeType);
  const optionTexts = rowMaterialOptionCandidates(targetChangeType);
  let optionClick = null;
  const menuAttempts = [];
  for (let attempt = 0; attempt < (isFast() ? 3 : 1); attempt += 1) {
    if (attempt > 0 && targetRowInfo.recordId) {
      await scrollQuoteRowIntoView(frame, targetRowInfo.recordId);
      await page.waitForTimeout(200);
      targetRowInfo = (await findQuoteRowByRecordId(frame, targetRowInfo.recordId)) || targetRowInfo;
    }
    await clickByFramePoint(page, frame, { x: targetRowInfo.iconRect.cx, y: targetRowInfo.iconRect.cy });
    await page.waitForTimeout(isFast() ? 350 + attempt * 350 : 900);
    for (const optionText of optionTexts) {
      const option = frame.getByText(optionText, { exact: true }).first();
      if ((await option.count()) > 0 && (await option.isVisible({ timeout: 1200 }).catch(() => false))) {
        await option.click({ timeout: 5000 });
        optionClick = {
          method: "row-menu-option",
          text: optionText,
          requestedText: requestedOptionText,
          changeType: targetChangeType,
          attempt: attempt + 1,
        };
        break;
      }
    }
    menuAttempts.push({
      attempt: attempt + 1,
      recordId: targetRowInfo.recordId || "",
      iconRect: targetRowInfo.iconRect,
      clicked: !!optionClick,
    });
    if (optionClick) {
      break;
    }
  }
  if (!optionClick) {
    await captureAllFrames(page, runDir, `row-${rowIndex + 1}-row-material-option-missing`);
    throw new Error(`Row material option not found for row ${rowIndex + 1}: ${optionTexts.join(" / ")}`);
  }
  const pickerWait = isFast() ? await waitForMaterialPickerFrame(page, 8000) : null;
  if (!isFast()) {
    await page.waitForTimeout(6000);
  }
  await captureAllFrames(page, runDir, `row-${rowIndex + 1}-after-existing-material-picker-click`);
  return { rowInfo: targetRowInfo, requestedRowInfo: rowInfo, scrollResult, optionClick, menuAttempts, pickerWait };
}

async function selectExistingMaterialForItem(page, runDir, item, rowIndex, preferredRecordId = "") {
  const pickerFrame = findMaterialPickerFrame(page);
  if (!pickerFrame) {
    await captureAllFrames(page, runDir, `row-${rowIndex + 1}-material-picker-frame-missing`);
    throw new Error(`Existing material picker iframe not found for row ${rowIndex + 1}`);
  }
  const prefix = `row-${rowIndex + 1}-material-search-${item.code}`;
  if (isFast()) {
    await waitForPickerSearchInput(page, pickerFrame.locator("input[placeholder]:visible"), 10000);
  }
  const selection = await searchPickerAndSelect(page, runDir, pickerFrame, item.code, prefix);
  const rowStateWait = isFast() ? await waitForMaterialRowState(page, item.code, preferredRecordId, 8000) : null;
  if (!isFast()) {
    await page.waitForTimeout(1200);
  }
  const rowState = rowStateWait?.value || await readMaterialRowState(findZwFrame(page), item.code, preferredRecordId);
  await writeJson(path.join(runDir, `row-${rowIndex + 1}-material-row-after-confirm.json`), rowState);
  return {
    materialNo: item.code,
    selection,
    backfilled: rowState.length > 0,
    rowStateWait,
    rowState,
  };
}

async function fillAllChangeRowsAndObserve(page, runDir) {
  const frame = findZwFrame(page);
  const rowActions = [];
  const usedCodes = [];
  const usedRecordIds = [];
  const preparedRows = isFast()
    ? await timedStep("prepare-fast-blank-rows", () => prepareFastBlankRows(page, runDir, changeItems.length))
    : [];

  for (let index = 0; index < changeItems.length; index += 1) {
    const item = changeItems[index];
    const rowTiming = shouldCollectTiming ? { index: index + 1, code: item.code || "", steps: [] } : null;
    const rowSteps = rowTiming?.steps || timingState.steps;
    try {
      if (!isFast() && index > 0) {
        await timedStep("add-row", () => clickQuoteNewRow(page, runDir, index, usedCodes, usedRecordIds), rowSteps);
      }

      const preparedRow = preparedRows[index] || null;
      const rowInfo = await timedStep(
        "find-target-row",
        async () => {
          const preparedRecordId = preparedRow?.recordId || "";
          if (isFast() && preparedRecordId) {
            const rowByRecordId = await findQuoteRowByRecordId(frame, preparedRecordId);
            if (rowByRecordId) return rowByRecordId;
          }
          if (isFast() && preparedRow?.rowInfo) {
            return preparedRow.rowInfo;
          }
          return findBlankQuoteRow(frame, usedCodes, usedRecordIds);
        },
        rowSteps
      );
      await writeJson(path.join(runDir, `row-${index + 1}-blank-row-before-fill.json`), rowInfo);
      if (!rowInfo) {
        await captureAllFrames(page, runDir, `row-${index + 1}-blank-row-not-found`);
        throw new Error(`Blank quote row not found for item ${item.code}`);
      }

      const changeTypeObservation = isDebug()
        ? await timedStep("pre-change-type", () => selectChangeTypeForRow(page, runDir, rowInfo, index, item), rowSteps)
        : { skipped: true, mode: traceLevelName, reason: "final-change-type-only" };
      const productRowInfo = isDebug()
        ? await timedStep("find-row-after-pre-change-type", () => findBlankQuoteRow(frame, usedCodes, usedRecordIds), rowSteps)
        : rowInfo;
      await writeJson(path.join(runDir, `row-${index + 1}-blank-row-before-product-picker.json`), productRowInfo);
      if (!productRowInfo) {
        await captureAllFrames(page, runDir, `row-${index + 1}-blank-row-before-product-picker-missing`);
        throw new Error(`Blank quote row not found before product picker for item ${item.code}`);
      }
      const rowRecordId = productRowInfo.recordId || rowInfo.recordId || preparedRow?.recordId || "";
      let materialPickerObservation = null;
      let materialSelectionObservation = null;
      let selectedRowInfo = productRowInfo;

      if (item.allowBlankCode) {
        materialSelectionObservation = await timedStep(
          "blank-code-row-state",
          async () => ({
            materialNo: "",
            skipped: true,
            backfilled: true,
            reason: "blank-code-item",
            rowState: await readMaterialRowState(frame, "", rowRecordId),
          }),
          rowSteps
        );
      } else {
        materialPickerObservation = await timedStep(
          "open-picker",
          () => openExistingMaterialPickerForRow(page, runDir, productRowInfo, index, item),
          rowSteps
        );
        materialSelectionObservation = await timedStep(
          "select-material",
          () => selectExistingMaterialForItem(page, runDir, item, index, rowRecordId),
          rowSteps
        );
        selectedRowInfo = await timedStep(
          "find-selected-row",
          () => findQuoteRowByMaterialCode(frame, item.code, rowRecordId),
          rowSteps
        );
      }
      await writeJson(path.join(runDir, `row-${index + 1}-selected-row-before-final-change-type.json`), selectedRowInfo);
      if (!selectedRowInfo) {
        await captureAllFrames(page, runDir, `row-${index + 1}-selected-row-not-found`);
        throw new Error(`Selected quote row not found after material picker for item ${item.code}`);
      }
      const finalChangeTypeObservation = await timedStep(
        "final-change-type",
        () => selectChangeTypeForRow(page, runDir, selectedRowInfo, index, item),
        rowSteps
      );
      const effectiveRecordId = selectedRowInfo.recordId || rowRecordId;
      const targetChangeType = changeTypeForItem(item);
      const blankCodeChangeTypeFill = item.allowBlankCode
        ? await timedStep(
            "fill-blank-code-change-type",
            () => fillInputByColumnX(frame, item.code, 145, 220, targetChangeType, effectiveRecordId),
            rowSteps
          )
        : null;
      const addedQtyResult = shouldFillQty(item)
        ? await timedStep(
            "fill-quantity",
            () => fillInputByColumnX(frame, item.code, 540, 700, item.qty, effectiveRecordId),
            rowSteps
          )
        : null;
      await page.waitForTimeout(isFast() ? 250 : 800);
      const taxPriceResult = shouldFillTaxPrice(item)
        ? await timedStep(
            "fill-tax-price",
            () => fillInputByColumnX(frame, item.code, 790, 950, item.taxPrice, effectiveRecordId),
            rowSteps
          )
        : null;
      await page.waitForTimeout(isFast() ? 500 : 1500);
      const blankCodeChangeTypeAfterValues = item.allowBlankCode
        ? await timedStep(
            "fill-blank-code-change-type-after-values",
            () => fillInputByColumnX(frame, item.code, 145, 220, targetChangeType, effectiveRecordId),
            rowSteps
          )
        : null;
      if (blankCodeChangeTypeAfterValues) {
        await page.waitForTimeout(isFast() ? 250 : 800);
      }
      const rowStateAfterValues = await timedStep(
        "read-row-after-values",
        () => readMaterialRowState(frame, item.code, effectiveRecordId),
        rowSteps
      );
      await writeJson(path.join(runDir, `row-${index + 1}-after-value-fill.json`), {
        addedQtyResult,
        taxPriceResult,
        rowStateAfterValues,
      });
      if (!materialSelectionObservation.backfilled) {
        throw new Error(`Material row not backfilled for ${item.code}`);
      }
      if (shouldFillQty(item) && !addedQtyResult?.filled) {
        throw new Error(`Failed to fill added quantity for ${item.code}: ${JSON.stringify(addedQtyResult)}`);
      }
      if (shouldFillTaxPrice(item) && !taxPriceResult?.filled) {
        throw new Error(`Failed to fill tax price for ${item.code}: ${JSON.stringify(taxPriceResult)}`);
      }
      await timedStep(
        "row-sanity",
        async () => {
          assertChangeRowSanity(item, rowStateAfterValues, `row ${index + 1}`);
          return true;
        },
        rowSteps
      );
      if (item.code) {
        usedCodes.push(item.code);
      }
      if (effectiveRecordId) {
        usedRecordIds.push(effectiveRecordId);
      }
      rowActions.push({
        item,
        changeTypeObservation,
        finalChangeTypeObservation,
        blankCodeChangeTypeFill,
        blankCodeChangeTypeAfterValues,
        selectedRowInfo,
        effectiveRecordId,
        materialPickerObservation,
        materialSelectionObservation,
        addedQtyResult,
        taxPriceResult,
        rowStateAfterValues,
      });
    } finally {
      if (rowTiming) {
        timingState.rows.push(rowTiming);
      }
    }
  }

  const afterFillerResult = await fillInputByLabel(frame, "变更后辅料", afterFiller);
  await page.waitForTimeout(800);
  const afterInstallFeeResult = await fillInputByLabel(frame, "变更后安装调试费", afterInstallFee);
  await page.waitForTimeout(800);
  const deliveryFeeResult = await fillInputByLabel(frame, "预估交付实施服务费", deliveryFee);
  await page.waitForTimeout(3000);

  const finalRows = {};
  for (let index = 0; index < rowActions.length; index += 1) {
    const action = rowActions[index];
    const key = `${index + 1}:${action.item.code}`;
    finalRows[key] = await readMaterialRowState(frame, action.item.code, action.effectiveRecordId);
    assertChangeRowSanity(action.item, finalRows[key], "final");
  }
  await writeJson(path.join(runDir, "17-multi-row-actions.json"), {
    preparedRows: preparedRows.map((row) => ({ index: row.index, recordId: row.recordId, created: row.created })),
    rowActions,
    afterFillerResult,
    afterInstallFeeResult,
    deliveryFeeResult,
    finalRows,
  });
  await captureAllFrames(page, runDir, "17-after-multi-row-and-fee-fill");

  for (const result of [afterFillerResult, afterInstallFeeResult, deliveryFeeResult]) {
    if (!result.filled) {
      throw new Error(`Failed to fill fee field: ${JSON.stringify(result)}`);
    }
  }

  return {
    items: changeItems,
    rowActions,
    afterFiller,
    afterInstallFee,
    deliveryFee,
    afterFillerResult,
    afterInstallFeeResult,
    deliveryFeeResult,
    finalRows,
  };
}

async function fillRowValuesAndObserve(page, runDir) {
  const frame = findZwFrame(page);
  await writeJson(path.join(runDir, "16-material-row-before-fill.json"), await readMaterialRowState(frame, materialNo));

  const singleItem = { code: materialNo, qty: addedQty, taxPrice: changeTaxPrice };
  const addedQtyResult = await fillInputByColumnX(frame, materialNo, 540, 700, addedQty);
  await page.waitForTimeout(800);
  const taxPriceResult = hasTaxPrice(singleItem)
    ? await fillInputByColumnX(frame, materialNo, 790, 950, singleItem.taxPrice)
    : null;
  await page.waitForTimeout(1200);
  const afterFillerResult = await fillInputByLabel(frame, "变更后辅料", afterFiller);
  await page.waitForTimeout(800);
  const afterInstallFeeResult = await fillInputByLabel(frame, "变更后安装调试费", afterInstallFee);
  await page.waitForTimeout(800);
  const deliveryFeeResult = await fillInputByLabel(frame, "预估交付实施服务费", deliveryFee);
  await page.waitForTimeout(2500);

  const after = await readMaterialRowState(frame, materialNo);
  const formValues = await readMainFormValues(frame, { projectNo, materialNo });
  await writeJson(path.join(runDir, "17-fill-row-actions.json"), {
    addedQtyResult,
    taxPriceResult,
    afterFillerResult,
    afterInstallFeeResult,
    deliveryFeeResult,
  });
  await writeJson(path.join(runDir, "17-material-row-after-fill.json"), after);
  await writeJson(path.join(runDir, "17-main-form-values-after-fill.json"), formValues);
  await captureAllFrames(page, runDir, "17-after-row-and-fee-fill");

  if (!addedQtyResult.filled) {
    throw new Error(`Failed to fill added quantity: ${JSON.stringify(addedQtyResult)}`);
  }
  if (hasTaxPrice(singleItem) && !taxPriceResult?.filled) {
    throw new Error(`Failed to fill tax price: ${JSON.stringify(taxPriceResult)}`);
  }
  assertChangeRowSanity(singleItem, after, "single-row");
  for (const result of [afterFillerResult, afterInstallFeeResult, deliveryFeeResult]) {
    if (!result.filled) {
      throw new Error(`Failed to fill fee field: ${JSON.stringify(result)}`);
    }
  }
  return {
    materialNo,
    addedQty,
    afterFiller,
    afterInstallFee,
    deliveryFee,
    addedQtyResult,
    taxPriceResult,
    afterFillerResult,
    afterInstallFeeResult,
    deliveryFeeResult,
    rowState: after,
    formValues,
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
  await writeJson(path.join(runDir, "18-before-save-draft-main-state.json"), before);
  await page.locator("#saveDraft_a").click({ timeout: 5000 });
  await page.waitForTimeout(11000);
  const after = await readMainSaveState(page);
  await writeJson(path.join(runDir, "19-after-save-draft-main-state.json"), after);
  await writeJson(path.join(runDir, "20-save-draft-responses.json"), responses);
  await captureAllFrames(page, runDir, "21-after-save-draft");
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
      recordId: row.recordId || "",
      text: String(row.text || "").slice(0, 180),
      inputs: (row.inputs || []).map((input) => ({
        id: input.id || "",
        value: input.value || "",
        readonly: !!input.readonly,
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

function compactChangeAction(action, index) {
  const item = action?.item || {};
  return {
    index: index + 1,
    code: item.code || "",
    label: item.label || "",
    qty: item.qty ?? "",
    taxPrice: item.taxPrice ?? "",
    changeType: item.changeType ?? changeTypeText,
    sourceRow: item.sourceRow ?? "",
    sourceRows: item.sourceRows || [],
    allowBlankCode: !!item.allowBlankCode,
    allowBlankQty: !!item.allowBlankQty,
    allowBlankTaxPrice: !!item.allowBlankTaxPrice,
    recordId: action?.effectiveRecordId || action?.selectedRowInfo?.recordId || "",
    materialSelected: action?.materialSelectionObservation?.skipped
      ? false
      : action?.materialSelectionObservation
        ? true
        : null,
    materialBackfilled: action?.materialSelectionObservation?.backfilled ?? null,
    changeTypeAfter: action?.finalChangeTypeObservation?.after || action?.finalChangeTypeObservation?.value || "",
    quantityFilled: action?.addedQtyResult?.filled ?? null,
    taxPriceFilled: action?.taxPriceResult?.filled ?? null,
  };
}

function compactFillObservation(fillObservation) {
  if (!fillObservation) return null;
  return {
    itemCount: fillObservation.items?.length || fillObservation.rowActions?.length || 0,
    rowActionCount: fillObservation.rowActions?.length || 0,
    rowActions: (fillObservation.rowActions || []).map(compactChangeAction),
    finalRowsCount: fillObservation.finalRows ? Object.keys(fillObservation.finalRows).length : null,
    feeResults: {
      afterFiller: fillObservation.afterFillerResult?.filled ?? null,
      afterInstallFee: fillObservation.afterInstallFeeResult?.filled ?? null,
      deliveryFee: fillObservation.deliveryFeeResult?.filled ?? null,
    },
  };
}

function compactChangeItems(items) {
  return (items || []).map((item, index) => ({
    index: index + 1,
    code: item.code || "",
    label: item.label || "",
    qty: item.qty ?? "",
    taxPrice: item.taxPrice ?? "",
    changeType: item.changeType ?? changeTypeText,
    sourceRow: item.sourceRow ?? "",
    sourceRows: item.sourceRows || [],
    allowBlankCode: !!item.allowBlankCode,
    allowBlankQty: !!item.allowBlankQty,
    allowBlankTaxPrice: !!item.allowBlankTaxPrice,
  }));
}

function compactQuotePageSizeObservation(observation) {
  if (!observation) return null;
  return {
    changed: observation.changed ?? null,
    requestedSize: observation.requestedSize ?? null,
    nextSize: observation.nextSize ?? observation.after?.pageData?.pageSize ?? null,
    beforePageSize: observation.before?.pageData?.pageSize ?? null,
    afterPageSize: observation.after?.pageData?.pageSize ?? null,
    method: observation.method || "",
    reason: observation.reason || "",
  };
}

function compactChangeOutput(output) {
  const fillObservation = output.multiRowFillObservation || output.rowFillObservation || null;
  return {
    success: output.success,
    traceLevel: output.traceLevel,
    waitScale: output.waitScale,
    artifactDir: output.artifactDir,
    parameters: {
      projectNameKeyword: output.parameters?.projectNameKeyword || "",
      projectNo: output.parameters?.projectNo || "",
      requestedProjectNo: output.parameters?.requestedProjectNo || "",
      accountName: output.parameters?.accountName || "",
      businessName: output.parameters?.businessName || "",
      industryName: output.parameters?.industryName || "",
      changeTypeText: output.parameters?.changeTypeText || "",
      rowMaterialOptionText: output.parameters?.rowMaterialOptionText || "",
      quotePageSize: output.parameters?.quotePageSize,
      itemCount: output.parameters?.changeItems?.length || 0,
      changeItems: compactChangeItems(output.parameters?.changeItems || []),
      afterFiller: output.parameters?.afterFiller,
      afterInstallFee: output.parameters?.afterInstallFee,
      deliveryFee: output.parameters?.deliveryFee,
    },
    itemWarnings: output.itemWarnings || [],
    projectSelectionObservation: output.projectSelectionObservation
      ? {
          projectNo: output.projectSelectionObservation.projectNo || output.parameters?.projectNo || "",
          clicked: output.projectSelectionObservation.pickerClick?.clicked ?? null,
        }
      : null,
    baseFieldObservation: output.baseFieldObservation
      ? {
          selectedCount: output.baseFieldObservation.selected?.length ?? null,
        }
      : null,
    quotePageSizeObservation: compactQuotePageSizeObservation(output.quotePageSizeObservation),
    rowFillObservation: compactFillObservation(fillObservation),
    saveDraftObservation: compactSaveDraftObservation(output.saveDraftObservation),
  };
}

function compactForConsole(value) {
  if (traceAt("debug")) return value;
  if (value?.parameters?.changeItems) {
    return compactChangeOutput(value);
  }
  return JSON.parse(
    JSON.stringify(value, (key, current) => {
      if (
        [
          "rowState",
          "rowStateAfterValues",
          "finalRows",
          "matchedRows",
          "backfillRows",
          "fieldValues",
          "allCandidates",
          "rowSnapshot",
          "polls",
        ].includes(key)
      ) {
        if (key === "finalRows" && current && typeof current === "object" && !Array.isArray(current)) {
          return Object.fromEntries(
            Object.entries(current).map(([rowKey, rows]) => [rowKey, summarizeRowsForFast(rows)])
          );
        }
        if (Array.isArray(current)) return summarizeRowsForFast(current);
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

async function writeTiming(runDir, status, error = null) {
  if (!shouldCollectTiming) {
    return;
  }
  const startedMs = Date.parse(timingState.startedAt);
  timingState.finishedAt = new Date().toISOString();
  timingState.status = status;
  timingState.totalMs = Number.isFinite(startedMs) ? Date.now() - startedMs : null;
  if (error) {
    timingState.error = compactError(error);
  }
  await writeJson(path.join(runDir, "timing.json"), timingState, { critical: true, compact: true });
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
    const pageResult = await openChangePage(page, runDir);
    const projectPickerObservation = shouldOpenProjectPicker
      ? await openProjectPicker(page, runDir)
      : null;
    const projectSelectionObservation = shouldSelectProject
      ? await selectProjectAndObserve(page, runDir)
      : null;
    const baseFieldObservation = shouldFillBase
      ? await fillBaseFieldsAndObserve(page, runDir)
      : null;
    const quotePageSizeObservation = shouldSetQuotePageSize
      ? await setQuoteTablePageSizeAndObserve(page, runDir)
      : null;
    const multiRowFillObservation = shouldFillRow
      ? await timedStep("fill-all-change-rows", () => fillAllChangeRowsAndObserve(page, runDir))
      : null;
    const firstRowAction = multiRowFillObservation?.rowActions?.[0] || null;
    const changeTypeObservation = firstRowAction?.changeTypeObservation || null;
    const existingMaterialPickerObservation = firstRowAction?.materialPickerObservation || null;
    const materialSelectionObservation = firstRowAction?.materialSelectionObservation || null;
    const rowFillObservation = multiRowFillObservation;
    const saveDraftObservation = shouldSaveDraft
      ? await timedStep("save-draft", () => saveDraftAndObserve(page, runDir))
      : null;
    const output = {
      success: true,
      chromePath,
      traceLevel: traceLevelName,
      waitScale: Number.isFinite(configuredWaitScale) && configuredWaitScale > 0 ? configuredWaitScale : null,
      artifactDir: runDir,
      parameters: {
        projectNameKeyword,
        projectNo: projectSelectionObservation?.projectNo || projectNo,
        requestedProjectNo: projectNo,
        accountName,
        businessName,
        industryName,
        materialNo,
        addedQty,
        changeTaxPrice,
        changeItems,
        afterFiller,
        afterInstallFee,
        deliveryFee,
        changeTypeText,
        rowMaterialOptionText,
        quotePageSize,
      },
      itemWarnings,
      login: loginResult,
      page: pageResult,
      projectPickerObservation,
      projectSelectionObservation,
      baseFieldObservation,
      quotePageSizeObservation,
      changeTypeObservation,
      existingMaterialPickerObservation,
      materialSelectionObservation,
      rowFillObservation,
      multiRowFillObservation,
      saveDraftObservation,
    };
    await writeTiming(runDir, "success");
    const persistedOutput = traceLevelName === "fast" ? compactChangeOutput(output) : output;
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
    await writeTiming(runDir, "error", error).catch(() => {});
    await writeJson(path.join(runDir, "error.json"), output, { critical: true });
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
