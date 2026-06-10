"use strict";

const {
  createRunContext,
  writeRequest,
  writeResult,
  writeError,
} = require("../core/artifacts");
const {
  buildProjectCreateExecutionPlan,
  runProjectCreateControlObservation,
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
  const executionPlan = {
    ...buildProjectCreateExecutionPlan(input),
    flow: "project_create_control_observe",
    mode: "control-observation-only",
  };
  const runContext = await createRunContext({
    flow: "project_create_control_observe",
    label: "entry",
  });

  await writeRequest(runContext, {
    flow: "project_create_control_observe",
    input,
    executionPlan,
    note: "Control observation only. Opens relation, people, and select controls, reads popups/options, and closes them. It does not save or send.",
  });

  const result = await runProjectCreateControlObservation({
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
    flow: "project_create_control_observe",
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
