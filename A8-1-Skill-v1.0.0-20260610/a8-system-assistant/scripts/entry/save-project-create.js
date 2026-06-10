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
  runProjectCreateSaveDraft,
} = require("../flows/project-create/flow");

function parseInputJson() {
  const inputFile = String(process.env.A8_ASSISTANT_INPUT_JSON_FILE || "").trim();
  if (inputFile) {
    return JSON.parse(fs.readFileSync(path.resolve(inputFile), "utf8"));
  }
  const raw = String(process.env.A8_ASSISTANT_INPUT_JSON || "").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["fast", "normal", "debug"].includes(mode) ? mode : "fast";
}

async function main() {
  const mode = normalizeMode(process.env.A8_TRACE_LEVEL || process.env.A8_RUN_MODE || "fast");
  const input = parseInputJson();
  const runContext = await createRunContext({
    flow: "project_create_save_draft",
    label: mode,
  });

  await writeRequest(runContext, {
    flow: "project_create_save_draft",
    mode,
    input,
    note: "Creates a project-create draft, verifies the filled fields, then saves to wait-send. Does not send.",
  });

  const result = await runProjectCreateSaveDraft({
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
    flow: "project_create_save_draft",
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
