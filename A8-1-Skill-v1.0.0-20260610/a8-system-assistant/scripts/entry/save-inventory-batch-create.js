"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  createRunContext,
  writeRequest,
  writeResult,
  writeError,
} = require("../core/artifacts");
const {
  buildInventoryBatchSaveDraftInput,
} = require("../flows/inventory-batch/mapper");
const {
  runInventoryBatchSaveDraft,
} = require("../flows/inventory-batch/flow");

function parseJsonText(raw) {
  return JSON.parse(String(raw || "").replace(/^\uFEFF/, ""));
}

function parseInputJson() {
  const inputFile = String(process.env.A8_ASSISTANT_INPUT_JSON_FILE || "").trim();
  if (inputFile) {
    return parseJsonText(fs.readFileSync(path.resolve(inputFile), "utf8"));
  }
  const raw = String(process.env.A8_ASSISTANT_INPUT_JSON || "").trim();
  if (!raw) {
    return {};
  }
  return parseJsonText(raw);
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["fast", "normal", "debug"].includes(mode) ? mode : "normal";
}

async function main() {
  const mode = normalizeMode(process.env.A8_TRACE_LEVEL || process.env.A8_RUN_MODE || "normal");
  const input = parseInputJson();
  const executionPlan = buildInventoryBatchSaveDraftInput(input);
  const runContext = await createRunContext({
    flow: "inventory_batch_save_draft",
    label: mode,
  });

  await writeRequest(runContext, {
    flow: "inventory_batch_save_draft",
    mode,
    input,
    executionPlan,
    note:
      "Creates an inventory-batch wait-send draft only after input validation and SDKgetSubmitData readback pass. Does not send.",
  });

  const result = await runInventoryBatchSaveDraft({
    input,
    mode,
    runRoot: runContext.runRoot,
  });

  await writeResult(runContext, {
    success: Boolean(result?.ok),
    mode,
    ...result,
  });

  process.stdout.write(`${JSON.stringify({ resultPath: runContext.resultPath, ...result }, null, 2)}\n`);
  if (!result?.ok) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const runContext = await createRunContext({
    flow: "inventory_batch_save_draft",
    label: "entry-error",
  }).catch(() => null);

  const payload = {
    success: false,
    stage: "entry",
    error: String(error),
    stack: error?.stack || "",
    saveDraftTouched: false,
  };

  if (runContext) {
    await writeError(runContext, payload).catch(() => {});
  }

  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
