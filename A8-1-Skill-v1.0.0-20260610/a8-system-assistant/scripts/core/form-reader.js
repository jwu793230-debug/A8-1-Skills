"use strict";

function getControlValue(control) {
  if (!control) return "";
  if (control.showValue !== undefined && control.showValue !== null && control.showValue !== "") {
    return String(control.showValue).trim();
  }
  if (control.value !== undefined && control.value !== null) {
    return String(control.value).trim();
  }
  return "";
}

function buildChangeAddReadbackShape({
  projectCodeOrQuotationNo = "",
  changedAuxMaterial = "",
  changedInstallDebugFee = "",
  rows = [],
} = {}) {
  return {
    projectCodeOrQuotationNo: String(projectCodeOrQuotationNo ?? "").trim(),
    changedAuxMaterial: String(changedAuxMaterial ?? "").trim(),
    changedInstallDebugFee: String(changedInstallDebugFee ?? "").trim(),
    rows: rows.map((row) => ({
      materialNo: String(row?.materialNo || row?.code || "").trim(),
      quantity: String(row?.quantity ?? "").trim(),
      taxPrice: String(row?.taxPrice ?? row?.unitPrice ?? row?.price ?? "").trim(),
    })),
  };
}

function mergeDetailControlRows(...rowGroups) {
  const rowMap = new Map();
  for (const rows of rowGroups) {
    for (const row of rows || []) {
      const recordId = String(row?.recordId || row?.id || "").trim();
      if (!recordId) continue;
      rowMap.set(recordId, {
        ...(rowMap.get(recordId) || { recordId, id: recordId }),
        ...row,
        recordId,
        id: recordId,
      });
    }
  }
  return [...rowMap.values()];
}

function collectDetailRowsFromFormState(formState = {}, detailTableName = "") {
  const sons = formState.formsons || {};
  const directRows = Array.isArray(sons[detailTableName]) ? sons[detailTableName] : [];
  if (directRows.length > 0) {
    return directRows;
  }

  const formData = formState.formData || {};
  const tableDataEntry = formData.tableData?.[detailTableName] || formState.tableData?.[detailTableName];
  const tableInfoRows =
    (Array.isArray(formData.tableInfo?.formson)
      ? formData.tableInfo.formson.find((item) => item?.tableName === detailTableName)?.pageData?.items
      : null) || [];
  const addRows = Array.isArray(tableDataEntry?.add) ? tableDataEntry.add : [];
  const updateRows = Object.entries(tableDataEntry?.update || {}).map(([recordId, patch]) => ({
    recordId,
    id: recordId,
    ...patch,
  }));

  return mergeDetailControlRows(tableInfoRows, addRows, updateRows);
}

function buildChangeAddReadbackFromFormState(formState = {}, config = {}) {
  const mainTableName = config.mainTableName || "";
  const detailTableName = config.detailTableName || "";
  const mainFields = config.fields || {};
  const detailFields = config.detailFields || {};

  const mains = formState.formmains || {};

  const mainRow = mains[mainTableName] || {};
  const detailRows = collectDetailRowsFromFormState(formState, detailTableName);

  return buildChangeAddReadbackShape({
    projectCodeOrQuotationNo: getControlValue(mainRow[mainFields.projectCodeOrQuotationNo]),
    changedAuxMaterial: getControlValue(mainRow[mainFields.changedAuxMaterial]),
    changedInstallDebugFee: getControlValue(mainRow[mainFields.changedInstallDebugFee]),
    rows: detailRows.map((row) => ({
      materialNo: getControlValue(row[detailFields.productCode]),
      quantity: getControlValue(row[detailFields.addedQuantity]),
      taxPrice: getControlValue(row[detailFields.taxPrice]),
    })),
  });
}

module.exports = {
  getControlValue,
  buildChangeAddReadbackShape,
  buildChangeAddReadbackFromFormState,
};
