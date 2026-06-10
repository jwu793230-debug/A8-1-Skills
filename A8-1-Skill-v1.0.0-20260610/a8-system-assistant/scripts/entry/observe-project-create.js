"use strict";

const {
  createRunContext,
  writeRequest,
  writeResult,
  writeError,
} = require("../core/artifacts");
const {
  buildProjectCreateExecutionPlan,
  runProjectCreateObservation,
} = require("../flows/project-create/flow");

function parseInputJson() {
  const raw = String(process.env.A8_ASSISTANT_INPUT_JSON || "").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

async function main() {
  const input = parseInputJson();
  const executionPlan = buildProjectCreateExecutionPlan(input);
  const runContext = await createRunContext({
    flow: "project_create_observe",
    label: "entry",
  });

  await writeRequest(runContext, {
    flow: "project_create_observe",
    input,
    executionPlan,
    note: "Observation-only. This entry opens the project-create form and reads field/control metadata only. It does not save or send.",
  });

  const result = await runProjectCreateObservation({
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
    flow: "project_create_observe",
    label: "entry-error",
  }).catch(() => null);

  const payload = {
    success: false,
    stage: "entry",
    error: String(error),
    stack: error?.stack || "",
  };

  if (runContext) {
    await writeError(runContext, payload).catch(() => {});
  }

  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
