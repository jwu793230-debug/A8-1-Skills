"use strict";

const { validateChangeAddInput } = require("./rules");

function mapChangeAddRequest(input = {}) {
  const validation = validateChangeAddInput(input);
  if (!validation.ok) {
    const error = new Error(`Invalid change-add input: ${validation.errors.join("; ")}`);
    error.code = "A8_CHANGE_ADD_INPUT_INVALID";
    error.details = validation;
    throw error;
  }

  const { baseInfo, rows } = validation.normalized;
  return {
    flow: "change_add_save_draft",
    baseInfo,
    rows,
    rowCount: rows.length,
    compareTarget: {
      projectCodeOrQuotationNo: baseInfo.projectCodeOrQuotationNo,
      changedAuxMaterial: baseInfo.changedAuxMaterial,
      changedInstallDebugFee: baseInfo.changedInstallDebugFee,
      rows,
    },
  };
}

module.exports = {
  mapChangeAddRequest,
};
