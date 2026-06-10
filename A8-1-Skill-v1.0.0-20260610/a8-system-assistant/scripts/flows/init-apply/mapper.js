"use strict";

const { validateInitApplyInput } = require("./rules");

function mapInitApplyRequest(input = {}) {
  const validation = validateInitApplyInput(input);
  if (!validation.ok) {
    const error = new Error(`Invalid init-apply input: ${validation.errors.join("; ")}`);
    error.code = "A8_INIT_APPLY_INPUT_INVALID";
    error.details = validation;
    throw error;
  }

  const { baseInfo, rows } = validation.normalized;
  return {
    flow: "init_apply_save_draft",
    baseInfo,
    rows,
    rowCount: rows.length,
  };
}

module.exports = {
  mapInitApplyRequest,
};
