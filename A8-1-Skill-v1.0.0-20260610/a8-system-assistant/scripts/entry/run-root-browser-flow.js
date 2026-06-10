"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  createRunContext,
  writeRequest,
  writeResult,
  writeError,
} = require("../core/artifacts");

function parseInputJson() {
  const inputFile = String(process.env.A8_ASSISTANT_INPUT_JSON_FILE || "").trim();
  if (inputFile) {
    return JSON.parse(fsSync.readFileSync(path.resolve(inputFile), "utf8"));
  }
  const raw = String(process.env.A8_ASSISTANT_INPUT_JSON || "").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["fast", "normal", "debug"].includes(mode) ? mode : "fast";
}

function getProjectRoot() {
  const candidates = [
    process.env.A8_PROJECT_ROOT,
    path.resolve(__dirname, "..", "..", ".."),
    path.resolve(__dirname, "..", "..", "..", "A8-1号项目"),
  ].filter(Boolean);
  const found = candidates.find((candidate) =>
    fsSync.existsSync(path.join(candidate, "scripts", "observe-init-apply.js"))
  );
  if (!found) {
    throw new Error(`A8 project root not found. Checked: ${candidates.join("; ")}`);
  }
  return found;
}

function materialRows(input) {
  return Array.isArray(input.materials)
    ? input.materials
    : Array.isArray(input.rows)
      ? input.rows
      : [];
}

function normalizeMaterialRows(rows) {
  return rows.map((item, index) => {
    const allowBlankCode = Boolean(item.allowBlankCode || item.blankCode || item.skipMaterialPicker);
    let code = String(item.code ?? item.materialNo ?? item.productNo ?? "").trim();
    if (allowBlankCode && code === "0") {
      code = "";
    }
    return {
      code,
      materialNo: code,
      productNo: code,
      qty: String(item.qty ?? item.quantity ?? item.addedQty ?? "").trim(),
      quantity: String(item.quantity ?? item.qty ?? item.addedQty ?? "").trim(),
      addedQty: String(item.addedQty ?? item.qty ?? item.quantity ?? "").trim(),
      taxPrice: String(item.taxPrice ?? item.unitPrice ?? item.price ?? "").trim(),
      unitPrice: String(item.unitPrice ?? item.taxPrice ?? item.price ?? "").trim(),
      price: String(item.price ?? item.taxPrice ?? item.unitPrice ?? "").trim(),
      changeType: String(item.changeType ?? item.type ?? "").trim(),
      label: String(item.label ?? item.productName ?? item.device ?? item.code ?? `row-${index + 1}`).trim(),
      sourceRow: item.sourceRow ?? item.excelRow ?? item.row ?? "",
      sourceRows: Array.isArray(item.sourceRows) ? item.sourceRows : [],
      allowBlankCode,
      allowBlankQty: Boolean(item.allowBlankQty || item.blankQty || item.allowBlankValues),
      allowBlankTaxPrice: Boolean(item.allowBlankTaxPrice || item.blankTaxPrice || item.allowBlankValues),
    };
  });
}

async function listObservationDirs(projectRoot) {
  const root = path.join(projectRoot, "runtime", "observations");
  if (!fsSync.existsSync(root)) return new Set();
  const entries = await fs.readdir(root, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)));
}

async function findNewestArtifact(projectRoot, beforeDirs) {
  const root = path.join(projectRoot, "runtime", "observations");
  if (!fsSync.existsSync(root)) return null;
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => !beforeDirs.has(dir));
  if (dirs.length === 0) {
    return null;
  }
  const candidates = dirs;
  let newest = null;
  for (const dir of candidates) {
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { dir, mtimeMs: stat.mtimeMs };
    }
  }
  if (!newest) return null;
  const resultPath = path.join(newest.dir, "result.json");
  const errorPath = path.join(newest.dir, "error.json");
  let result = null;
  if (fsSync.existsSync(resultPath)) {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } else if (fsSync.existsSync(errorPath)) {
    result = JSON.parse(await fs.readFile(errorPath, "utf8"));
  }
  return {
    artifactDir: newest.dir,
    resultPath: fsSync.existsSync(resultPath) ? resultPath : "",
    errorPath: fsSync.existsSync(errorPath) ? errorPath : "",
    result,
  };
}

async function writeRowsFile(runContext, rows, name) {
  const filePath = path.join(runContext.runRoot, name);
  await fs.writeFile(filePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  return filePath;
}

function buildInitEnv(input, rowsFile) {
  return {
    A8_MATERIAL_ITEMS_JSON_FILE: rowsFile,
    A8_LINKED_CREATE_NO: String(input.relatedProjectCreateCode || "").trim(),
    A8_BUILD_UNIT: String(input.buildUnit || "").trim(),
    A8_CONSTRUCTION_UNIT: String(input.constructionUnit || "").trim(),
    A8_NEED_DELIVERY: String(input.needDelivery || "").trim(),
    A8_PRICE_SYSTEM: String(input.priceSystem || "").trim(),
    A8_SOFTWARE_CONFIRM: String(input.softwareIntegrationConfirm || "").trim(),
    A8_SUPERVISION_NEED: Array.isArray(input.regulatorDemand)
      ? input.regulatorDemand.join(",")
      : String(input.regulatorDemand || "").trim(),
    A8_BUSINESS: String(input.businessType || input.business || "").trim(),
    A8_INDUSTRY: String(input.industryType || input.industry || "").trim(),
    A8_LINK_CREATE: "1",
    A8_SAVE_DRAFT: "1",
  };
}

function buildChangeEnv(input, rows, rowsFile) {
  const firstType = rows.find((item) => item.changeType)?.changeType || String(input.changeType || "").trim() || "变更";
  const projectNameKeyword = String(input.projectNameKeyword || input.projectName || input.projectCodeOrQuotationNo || "").trim();
  return {
    A8_CHANGE_ITEMS_JSON_FILE: rowsFile,
    A8_CHANGE_PROJECT_NAME: projectNameKeyword,
    A8_CHANGE_PROJECT_NO: String(input.projectNo || input.projectNumber || "auto").trim(),
    A8_CHANGE_ACCOUNT: String(input.accountName || input.account || "").trim(),
    A8_CHANGE_BUSINESS: String(input.businessName || input.business || "").trim(),
    A8_CHANGE_INDUSTRY: String(input.industryName || input.industry || "").trim(),
    A8_CHANGE_TYPE: firstType,
    A8_CHANGE_AFTER_FILLER: String(input.changedAuxMaterial ?? input.changedAccessoryMaterial ?? "0").trim(),
    A8_CHANGE_AFTER_INSTALL_FEE: String(input.changedInstallDebugFee ?? input.installDebugFee ?? "0").trim(),
    A8_CHANGE_DELIVERY_FEE: String(input.deliveryFee ?? input.estimatedDeliveryServiceFee ?? "0").trim(),
    A8_SAVE_DRAFT: "1",
  };
}

function runChild(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [scriptPath, "--save-draft"], {
      cwd: path.dirname(scriptPath),
      env,
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        code,
        signal,
        durationMs: Date.now() - startedAt,
        stdoutTail: stdout.slice(-12000),
        stderrTail: stderr.slice(-12000),
      });
    });
  });
}

async function main() {
  const rootBrowserFlow = String(process.env.A8_ROOT_BROWSER_FLOW || "").trim();
  const mode = normalizeMode(process.env.A8_TRACE_LEVEL || process.env.A8_RUN_MODE || "fast");
  const input = parseInputJson();
  const projectRoot = getProjectRoot();
  const rows = normalizeMaterialRows(materialRows(input));
  if (rows.length === 0) {
    throw new Error("A8_ASSISTANT_INPUT_JSON.materials or rows is required");
  }

  const flow = rootBrowserFlow === "init_apply"
    ? "init_apply_save_draft"
    : rootBrowserFlow === "change_existing"
      ? "change_add_save_draft"
      : rootBrowserFlow || "unknown";
  const runContext = await createRunContext({ flow, label: mode });
  const rowsFile = await writeRowsFile(runContext, rows, "material-rows.json");
  const scriptName = rootBrowserFlow === "init_apply"
    ? "observe-init-apply.js"
    : rootBrowserFlow === "change_existing"
      ? "observe-change-existing-project.js"
      : "";
  if (!scriptName) {
    throw new Error(`Unsupported A8_ROOT_BROWSER_FLOW: ${rootBrowserFlow}`);
  }
  const scriptPath = path.join(projectRoot, "scripts", scriptName);
  const flowEnv = rootBrowserFlow === "init_apply"
    ? buildInitEnv(input, rowsFile)
    : buildChangeEnv(input, rows, rowsFile);

  await writeRequest(runContext, {
    flow,
    mode,
    projectRoot,
    scriptPath,
    input,
    normalizedRows: rows,
    note: "Unified assistant route wrapping the mature headless-Chrome A8-1 browser flow. Saves wait-send only; never sends.",
  });

  const beforeDirs = await listObservationDirs(projectRoot);
  const childResult = await runChild(scriptPath, {
    ...process.env,
    ...flowEnv,
    A8_TRACE_LEVEL: mode,
  });
  const browserArtifact = await findNewestArtifact(projectRoot, beforeDirs);
  const result = {
    success: childResult.code === 0,
    flow,
    mode,
    stage: childResult.code === 0 ? "root-browser-flow-completed" : "root-browser-flow-failed",
    durationMs: childResult.durationMs,
    projectRoot,
    scriptPath,
    wrapperRunRoot: runContext.runRoot,
    browserArtifact,
    child: childResult,
  };
  await writeResult(runContext, result);
  process.stdout.write(`${JSON.stringify({ resultPath: runContext.resultPath, ...result }, null, 2)}\n`);
  if (childResult.code !== 0) {
    process.exitCode = childResult.code || 1;
  }
}

main().catch(async (error) => {
  const payload = {
    success: false,
    stage: "root-browser-entry",
    error: String(error),
    stack: error?.stack || "",
    saveDraftTouched: false,
  };
  try {
    const runContext = await createRunContext({
      flow: process.env.A8_ROOT_BROWSER_FLOW || "root_browser_flow",
      label: "entry-error",
    });
    await writeError(runContext, payload);
  } catch (_writeError) {
    // Ignore artifact write failures in the error path.
  }
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
