"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const flow = process.argv[2];
const forwardedArgs = process.argv.slice(3);

if (!flow || flow.startsWith("-")) {
  process.stderr.write(
    [
      "Usage: node scripts/run-a8-assistant-flow.js <flow-name> [args...]",
      "",
      "Examples:",
      "  node scripts/run-a8-assistant-flow.js project_create_save_draft",
      "  node scripts/run-a8-assistant-flow.js inventory_batch_observe",
      "",
    ].join("\n")
  );
  process.exit(1);
}

const assistantEntryCandidates = [
  path.resolve(
    __dirname,
    "..",
    "a8-system-assistant",
    "scripts",
    "entry",
    "run-a8-assistant.js"
  ),
  path.resolve(
    __dirname,
    "..",
    "..",
    "a8-system-assistant",
    "scripts",
    "entry",
    "run-a8-assistant.js"
  ),
];

const assistantEntry = assistantEntryCandidates.find((candidate) =>
  fs.existsSync(candidate)
);

if (!assistantEntry) {
  process.stderr.write(
    [
      "Cannot find a8-system-assistant entry.",
      "Checked:",
      ...assistantEntryCandidates.map((candidate) => `  ${candidate}`),
      "",
    ].join("\n")
  );
  process.exit(1);
}

const child = spawn(process.execPath, [assistantEntry, ...forwardedArgs], {
  cwd: path.dirname(assistantEntry),
  env: {
    ...process.env,
    A8_ASSISTANT_FLOW: flow,
    A8_PROJECT_ROOT: path.resolve(__dirname, ".."),
  },
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  process.stderr.write(`${error.stack || String(error)}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`A8 assistant exited by signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code || 0);
});
