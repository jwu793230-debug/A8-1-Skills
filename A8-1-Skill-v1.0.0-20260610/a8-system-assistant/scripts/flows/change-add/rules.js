"use strict";

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNumberString(value) {
  const text = normalizeText(value).replace(/,/g, "");
  if (!text) return "";
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return text;
  }
  return numeric.toString();
}

function normalizeMaterialRow(row = {}) {
  return {
    materialNo: normalizeText(row.materialNo || row.code || row.productCode || ""),
    quantity: normalizeNumberString(row.quantity),
    taxPrice: normalizeNumberString(row.taxPrice ?? row.unitPrice ?? row.price ?? ""),
  };
}

function normalizeBaseInfo(input = {}) {
  return {
    projectCodeOrQuotationNo: normalizeText(
      input.projectCodeOrQuotationNo || input.projectCode || input.quotationNo || ""
    ),
    changedAuxMaterial: normalizeNumberString(
      input.changedAuxMaterial ?? input.changedAccessoryMaterial ?? ""
    ),
    changedInstallDebugFee: normalizeNumberString(
      input.changedInstallDebugFee ?? input.installDebugFee ?? ""
    ),
  };
}

function validateChangeAddInput(input = {}) {
  const errors = [];
  const baseInfo = normalizeBaseInfo(input);
  const rawRows = Array.isArray(input.materials)
    ? input.materials
    : Array.isArray(input.rows)
      ? input.rows
      : [];
  const rows = rawRows.map(normalizeMaterialRow);

  if (!baseInfo.projectCodeOrQuotationNo) {
    errors.push("projectCodeOrQuotationNo is required");
  }
  if (rows.length === 0) {
    errors.push("at least one material row is required");
  }

  rows.forEach((row, index) => {
    const line = index + 1;
    if (!row.materialNo) {
      errors.push(`row ${line}: materialNo is required`);
    }
    if (!row.quantity) {
      errors.push(`row ${line}: quantity is required`);
    }
    if (row.taxPrice === "") {
      errors.push(`row ${line}: taxPrice is required`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      baseInfo,
      rows,
    },
  };
}

module.exports = {
  normalizeText,
  normalizeNumberString,
  normalizeMaterialRow,
  normalizeBaseInfo,
  validateChangeAddInput,
};
