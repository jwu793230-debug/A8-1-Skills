"use strict";

const config = require("./config");

function validateMinimalSaveDraftSample(sampleInput = {}) {
  const errors = [];
  const items = Array.isArray(sampleInput.items) ? sampleInput.items : [];
  if (!String(sampleInput.businessDepartment || "").trim()) {
    errors.push("businessDepartment is required for the minimal sample.");
  }
  if (!items.length) {
    errors.push("At least one inventory detail row is required.");
  }
  items.forEach((item, index) => {
    for (const key of [
      "productName",
      "invoiceModel",
      "brand",
      "cost",
      "applicationCategory",
      "researchMethod",
      "subsystem",
      "productSeries",
      "materialSegment",
      "originalModel",
      "manufacturerName",
      "temporaryMaterial",
      "tagType",
      "outputTaxRate",
      "inputTaxRate",
    ]) {
      if (!String(item[key] || "").trim()) {
        errors.push(`items[${index}].${key} is required.`);
      }
    }
  });
  return {
    ok: errors.length === 0,
    errors,
  };
}

function summarizeObservationRisks() {
  return [
    {
      code: "captcha-required-for-browser-login",
      level: "medium",
      message:
        "A8 login may require a verification code after a failed attempt; HTTP-only login is insufficient in that state.",
    },
    {
      code: "fast-import-not-proven",
      level: "medium",
      message:
        "Import/export buttons exist, but export template stability and post-import formson_0507 readback are not proven.",
    },
    {
      code: "third-party-form-data-does-not-read-live-rows",
      level: "medium",
      message:
        "thirdPartyFormAPI.getFormData() did not expose live formson rows during browser filling; use SDKgetSubmitData() for pre-save gate.",
    },
    {
      code: "detail-cascade-required",
      level: "low",
      message:
        "产品系列-2025 is populated only after 子系统-2025 is selected; 其他子系统 -> 通用产品 was observed live.",
    },
  ];
}

function validateInventoryBatchSaveDraftInput(input = {}) {
  const errors = [];
  const warnings = [];
  const items = Array.isArray(input.items) ? input.items : [];

  if (!String(input.businessDepartment || "").trim()) {
    errors.push("businessDepartment is required.");
  }
  if (!items.length) {
    errors.push("items is required. Refuse to create an inventory batch draft without source rows.");
  }

  const materialCodes = new Map();
  items.forEach((item, index) => {
    const rowNo = item.index || index + 1;
    for (const key of [
      "productName",
      "invoiceModel",
      "brand",
      "cost",
      "applicationCategory",
      "researchMethod",
      "subsystem",
      "productSeries",
      "materialSegment",
      "originalModel",
      "manufacturerName",
      "designatedSupplier",
      "temporaryMaterial",
      "tagType",
      "outputTaxRate",
      "inputTaxRate",
    ]) {
      if (!String(item[key] || "").trim()) {
        errors.push(`row ${rowNo}: ${key} is required.`);
      }
    }
    const materialCode = String(item.materialCode || "").trim();
    if (!materialCode) {
      warnings.push({
        row: rowNo,
        code: "blank-material-code",
        message: "物料编码为空，按存货新建场景保留空值，待 A8 或人工后续生成/审核。",
      });
    } else if (materialCodes.has(materialCode)) {
      warnings.push({
        row: rowNo,
        code: "duplicate-material-code",
        message: `物料编码 ${materialCode} 与第 ${materialCodes.get(materialCode)} 行重复。`,
      });
    } else {
      materialCodes.set(materialCode, rowNo);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function compareInventoryBatchSubmitData({ input = {}, submitData = {} } = {}) {
  const errors = [];
  const warnings = [];
  const expectedRows = Array.isArray(input.items) ? input.items : [];
  const detailTableName = input.detailTableName || config.detailTableName || "formson_0507";
  const formsons =
    submitData?.formsons ||
    submitData?.data?.formsons ||
    submitData?.formson ||
    submitData?.data?.formson ||
    {};
  const rows = Array.isArray(formsons[detailTableName])
    ? formsons[detailTableName]
    : Array.isArray(submitData?.[detailTableName])
      ? submitData[detailTableName]
      : Array.isArray(submitData?.data?.[detailTableName])
        ? submitData.data[detailTableName]
        : [];

  if (rows.length !== expectedRows.length) {
    errors.push(`submit row count mismatch: expected ${expectedRows.length}, actual ${rows.length}`);
  }

  const pick = (row, fieldId) => {
    const value = row?.[fieldId] ?? row?.lists?.[fieldId] ?? "";
    if (value && typeof value === "object") {
      return String(value.showValue || value.value || value.display || "").trim();
    }
    return String(value || "").trim();
  };

  const fieldMap = {
    productName: "field0100",
    invoiceModel: "field0104",
    originalModel: "field0113",
    manufacturerName: "field0114",
    brand: "field0116",
    cost: "field0099",
    applicationCategory: "field0091",
    researchMethod: "field0134",
    subsystem: "field0145",
    productSeries: "field0146",
    materialSegment: "field0103",
    temporaryMaterial: "field0092",
    unit: "field0142",
    tagType: "field0111",
    outputTaxRate: "field0147",
    inputTaxRate: "field0148",
  };

  expectedRows.forEach((expected, index) => {
    const row = rows[index] || {};
    for (const [key, fieldId] of Object.entries(fieldMap)) {
      const wanted = String(expected[key] || "").trim();
      if (!wanted) continue;
      const actual = pick(row, fieldId);
      const knownEnumValue = String(config.knownEnumValues?.[key]?.[wanted] || "").trim();
      const matched =
        actual &&
        (
          actual.includes(wanted) ||
          wanted.includes(actual) ||
          (knownEnumValue && actual === knownEnumValue)
        );
      if (!matched) {
        errors.push(`row ${index + 1}: ${key} mismatch, expected ${wanted}, actual ${actual || "<blank>"}`);
      }
    }
    const materialCode = String(expected.materialCode || "").trim();
    if (!materialCode) {
      warnings.push({
        row: index + 1,
        code: "blank-material-code",
        message: "物料编码为空，保存待发后仍需人工复核。",
      });
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    expectedRowCount: expectedRows.length,
    actualRowCount: rows.length,
  };
}

module.exports = {
  validateMinimalSaveDraftSample,
  validateInventoryBatchSaveDraftInput,
  compareInventoryBatchSubmitData,
  summarizeObservationRisks,
};
