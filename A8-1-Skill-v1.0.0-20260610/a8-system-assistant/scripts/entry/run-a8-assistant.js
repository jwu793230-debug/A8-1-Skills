"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

function runChild(scriptPath, extraEnv = {}) {
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
      } else {
        reject(new Error(`Child exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const flow = process.env.A8_ASSISTANT_FLOW || "";
  const routes = {
    change_add_save_draft: {
      script: "run-root-browser-flow.js",
      env: { A8_ROOT_BROWSER_FLOW: "change_existing" },
    },
    init_apply_save_draft: {
      script: "run-root-browser-flow.js",
      env: { A8_ROOT_BROWSER_FLOW: "init_apply" },
    },
    project_create_observe: {
      script: "observe-project-create.js",
      env: {},
    },
    project_create_control_observe: {
      script: "observe-project-create-controls.js",
      env: {},
    },
    project_create_save_draft: {
      script: "save-project-create.js",
      env: {},
    },
    inventory_batch_observe: {
      script: "observe-inventory-batch-create.js",
      env: {},
    },
    inventory_batch_save_draft: {
      script: "save-inventory-batch-create.js",
      env: {},
    },
  };

  const route = routes[flow];
  if (!route) {
    process.stdout.write(
      `${JSON.stringify(
        {
          success: false,
          stage: "bootstrap",
          message: "Unsupported release route.",
          flow,
          supportedFlows: Object.keys(routes),
        },
        null,
        2
      )}\n`
    );
    process.exit(1);
    return;
  }

  await runChild(path.join(__dirname, route.script), route.env);
}

main().catch((error) => {
  const output = {
    success: false,
    stage: "bootstrap",
    error: String(error),
    stack: error?.stack || "",
  };
  process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
});
