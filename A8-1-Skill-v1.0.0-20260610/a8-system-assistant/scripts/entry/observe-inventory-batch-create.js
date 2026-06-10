"use strict";

const {
  createRunContext,
  writeRequest,
  writeResult,
  writeError,
} = require("../core/artifacts");
const {
  buildInventoryBatchExecutionPlan,
  runInventoryBatchObservation,
} = require("../flows/inventory-batch/flow");

function parseInputJson() {
  const raw = String(process.env.A8_ASSISTANT_INPUT_JSON || "").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function main() {
  const input = parseInputJson();
  const executionPlan = buildInventoryBatchExecutionPlan(input);
  const runContext = await createRunContext({
    flow: "inventory_batch_observe",
    label: "entry",
  });

  await writeRequest(runContext, {
    flow: "inventory_batch_observe",
    input,
    executionPlan,
    note: "Observation-only. Opens inventory batch create form, reads formson_0507 and import/export controls. Does not save or send.",
  });

  const result = await runInventoryBatchObservation({
    input,
    runRoot: runContext.runRoot,
  });

  await writeResult(runContext, {
    success: Boolean(result?.ok),
    ...result,
  });

  process.stdout.write(`${JSON.stringify({ resultPath: runContext.resultPath, ...result }, null, 2)}\n`);
}

main().catch(async (error) => {
  const runContext = await createRunContext({
    flow: "inventory_batch_observe",
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
