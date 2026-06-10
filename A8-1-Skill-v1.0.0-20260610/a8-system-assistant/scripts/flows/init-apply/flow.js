"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildRowPlan, buildCapacityPlan } = require("../../core/detail-grid");
const { mapInitApplyRequest } = require("./mapper");

function runCompatScript(scriptPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Compat script exited with code ${code}`));
    });
  });
}

async function runInitApplySaveDraft() {
  const scriptPath = path.resolve(__dirname, "..", "..", "compat", "init-apply-http.js");
  await runCompatScript(scriptPath);
}

function buildInitApplyExecutionPlan(input = {}) {
  const mapped = mapInitApplyRequest(input);
  return {
    ...mapped,
    detailPlan: buildRowPlan(mapped.rows),
    capacityPlan: buildCapacityPlan(mapped.rows.length, 1, 20),
  };
}

module.exports = {
  runInitApplySaveDraft,
  buildInitApplyExecutionPlan,
};
