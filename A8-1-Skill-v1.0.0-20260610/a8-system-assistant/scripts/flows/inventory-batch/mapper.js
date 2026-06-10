"use strict";

const config = require("./config");

function normalizeBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y)$/i.test(String(value).trim());
}

function normalizeInventoryBatchItem(item = {}, index = 0) {
  const materialCode = item.materialCode ?? item.code ?? item.materialNo ?? "";
  const productName = item.productName ?? item.name ?? "";
  const invoiceModel =
    item.invoiceModel ?? item.invoiceSpec ?? item.model ?? item.specification ?? item.spec ?? "";
  const model = item.model ?? item.specification ?? item.spec ?? invoiceModel;
  const brand = item.brand ?? "";
  return {
    index: index + 1,
    sourceRow: item.sourceRow ?? "",
    materialCode: String(materialCode).trim(),
    productName: String(productName).trim(),
    model: String(model).trim(),
    invoiceModel: String(invoiceModel).trim(),
    businessDepartment: String(item.businessDepartment ?? "").trim(),
    applicationCategory: String(item.applicationCategory ?? "").trim(),
    researchMethod: String(item.researchMethod ?? "").trim(),
    subsystem: String(item.subsystem ?? "").trim(),
    productSeries: String(item.productSeries ?? "").trim(),
    materialSegment: String(item.materialSegment ?? "").trim(),
    originalModel: String(item.originalModel ?? invoiceModel).trim(),
    manufacturerName: String(item.manufacturerName ?? brand).trim(),
    brand: String(brand).trim(),
    tagType: String(item.tagType ?? "").trim(),
    designatedSupplier: String(item.designatedSupplier ?? "").trim(),
    temporaryMaterial: String(
      item.temporaryMaterial ?? item.isTemporaryMaterial ?? ""
    ).trim(),
    bomType: String(item.bomType ?? "").trim(),
    unit: String(item.unit ?? "").trim(),
    cost: item.cost == null ? "" : String(item.cost).trim(),
    freight: item.freight == null ? "" : String(item.freight).trim(),
    totalCost: item.totalCost == null ? "" : String(item.totalCost).trim(),
    channelPrice: item.channelPrice == null ? "" : String(item.channelPrice).trim(),
    strategicPrice: item.strategicPrice == null ? "" : String(item.strategicPrice).trim(),
    directPrice: item.directPrice == null ? "" : String(item.directPrice).trim(),
    outputTaxRate: item.outputTaxRate == null ? "" : String(item.outputTaxRate).trim(),
    inputTaxRate: item.inputTaxRate == null ? "" : String(item.inputTaxRate).trim(),
    promotionAdvice: String(item.promotionAdvice ?? "").trim(),
    raw: item,
  };
}

function buildInventoryBatchExecutionPlan(input = {}) {
  const rawItems = Array.isArray(input.items) ? input.items : [];
  return {
    flow: config.flowName,
    businessName: config.businessName,
    mode: "observation-only",
    saveDraft: false,
    send: false,
    templateId: config.templateId,
    mainTableName: config.mainTableName,
    detailTableName: config.detailTableName,
    itemCount: rawItems.length,
    probeImportExport: normalizeBoolean(
      input.probeImportExport ?? process.env.A8_INVENTORY_BATCH_PROBE_IMPORT_EXPORT,
      true
    ),
    fastModeDecision: "pending-import-export-observation",
    plannedFastStrategy:
      "Use detail-table import only if export/import proves template-compatible and imported rows can be read back before save.",
    fallbackStrategy:
      "Use browser/Vue row filling and verify SDKgetSubmitData().formson_0507 before saving.",
  };
}

function buildBatchFieldMapping() {
  return {
    main: {
      tableName: config.mainTableName,
      fields: Object.entries(config.fields).map(([key, fieldId]) => ({
        key,
        fieldId,
        label: config.fieldLabels[key] || key,
        controlType: config.controlTypes[key] || "unknown",
      })),
    },
    detail: {
      tableName: config.detailTableName,
      fields: Object.entries(config.detailFields).map(([key, fieldId]) => ({
        key,
        fieldId,
        label: config.detailFieldLabels[key] || key,
        requiredForMinimalSave: [
          "applicationCategory",
          "researchMethod",
          "subsystem",
          "productSeries",
          "materialSegment",
          "productName",
          "invoiceModel",
          "originalModel",
          "manufacturerName",
          "brand",
          "designatedSupplier",
          "tagType",
          "outputTaxRate",
          "inputTaxRate",
        ].includes(key),
        status: "live-observed-2026-06-09",
      })),
    },
  };
}

function buildMinimalSaveDraftSample() {
  return {
    flow: "inventory_batch_save_draft",
    note:
      "Placeholder only. Replace product rows with the user's actual inventory data before saving to wait-send.",
    input: {
      businessDepartment: "<事业部门>",
      items: [
        {
          sourceRow: 1,
          productName: "<产品名称>",
          invoiceModel: "<开票规格型号>",
          brand: "<品牌>",
          cost: "<成本>",
          applicationCategory: "外购",
          researchMethod: "外购",
          subsystem: "其他子系统",
          productSeries: "通用产品",
          materialSegment: "WG_LS",
          originalModel: "<原厂型号>",
          manufacturerName: "<厂家名称>",
          tagType: "基线",
          designatedSupplier: "否",
          temporaryMaterial: "是",
          bomType: "基线",
          outputTaxRate: "13%",
          inputTaxRate: "13%",
          promotionAdvice: "不推荐",
        },
        {
          sourceRow: 2,
          productName: "<产品名称>",
          invoiceModel: "<开票规格型号>",
          brand: "<品牌>",
          cost: "<成本>",
          applicationCategory: "外购",
          researchMethod: "外购",
          subsystem: "其他子系统",
          productSeries: "通用产品",
          materialSegment: "WG_LS",
          originalModel: "<原厂型号>",
          manufacturerName: "<厂家名称>",
          tagType: "基线",
          designatedSupplier: "否",
          temporaryMaterial: "是",
          bomType: "基线",
          outputTaxRate: "13%",
          inputTaxRate: "13%",
          promotionAdvice: "不推荐",
          freight: "0",
        },
      ],
    },
    gates: [
      "formmain_0506.field0130 must be AI安全生产事业部.",
      "SDKgetSubmitData() must contain exactly two formson_0507 rows before saving.",
      "Visible rows must show 外购/外购/其他子系统/通用产品/WG_LS and the requested product names.",
      "Only click 保存待发; never click 发送 for this sample.",
    ],
  };
}

function normalizeItems(items = []) {
  return items.map((item, index) => normalizeInventoryBatchItem(item, index));
}

function buildInventoryBatchSaveDraftInput(input = {}) {
  const allowSample = /^(1|true|yes|y)$/i.test(
    String(input.allowSample ?? process.env.A8_INVENTORY_BATCH_ALLOW_SAMPLE ?? "").trim()
  );
  const sampleInput = buildMinimalSaveDraftSample().input;
  const rawItems = Array.isArray(input.items) && input.items.length > 0
    ? input.items
    : allowSample
      ? sampleInput.items
      : [];
  const businessDepartment = String(
    input.businessDepartment ||
    input.department ||
    sampleInput.businessDepartment ||
    ""
  ).trim();
  const normalizedItems = normalizeItems(rawItems).map((item) => ({
    ...item,
    businessDepartment: item.businessDepartment || businessDepartment,
    applicationCategory: item.applicationCategory || "外购",
    researchMethod: item.researchMethod || "外购",
    subsystem: item.subsystem || "其他子系统",
    productSeries: item.productSeries || "通用产品",
    materialSegment: item.materialSegment || "WG_LS",
    originalModel: item.originalModel || item.invoiceModel || item.model,
    manufacturerName: item.manufacturerName || item.brand,
    designatedSupplier: item.designatedSupplier || "否",
    temporaryMaterial: item.temporaryMaterial || "是",
    bomType: item.bomType || "基线",
    unit: item.unit || "pcs",
    tagType: item.tagType || "基线",
    outputTaxRate: item.outputTaxRate || "13%",
    inputTaxRate: item.inputTaxRate || "13%",
    promotionAdvice: item.promotionAdvice || "不推荐",
    freight: item.freight === "" ? "0" : item.freight,
    totalCost: item.totalCost || item.cost,
  }));

  return {
    flow: "inventory_batch_save_draft",
    businessDepartment,
    items: normalizedItems,
    allowSample,
    rowCount: normalizedItems.length,
  };
}

module.exports = {
  normalizeInventoryBatchItem,
  normalizeItems,
  buildInventoryBatchExecutionPlan,
  buildBatchFieldMapping,
  buildMinimalSaveDraftSample,
  buildInventoryBatchSaveDraftInput,
};
