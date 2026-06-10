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

function normalizeInitApplyBaseInfo(input = {}) {
  return {
    relatedProjectCreateCode: normalizeText(input.relatedProjectCreateCode || ""),
    buildUnit: normalizeText(input.buildUnit || ""),
    constructionUnit: normalizeText(input.constructionUnit || ""),
    needDelivery: normalizeText(input.needDelivery || ""),
    softwareIntegrationConfirm: normalizeText(input.softwareIntegrationConfirm || ""),
    regulatorDemand: Array.isArray(input.regulatorDemand)
      ? input.regulatorDemand.map((item) => normalizeText(item)).filter(Boolean)
      : normalizeText(input.regulatorDemand || ""),
    priceSystem: normalizeText(input.priceSystem || ""),
    businessType: normalizeText(input.businessType || ""),
    industryType: normalizeText(input.industryType || ""),
  };
}

function validateInitApplyInput(input = {}) {
  const errors = [];
  const baseInfo = normalizeInitApplyBaseInfo(input);
  const rows = Array.isArray(input.materials) ? input.materials.map(normalizeMaterialRow) : [];

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
  normalizeInitApplyBaseInfo,
  validateInitApplyInput,
};
