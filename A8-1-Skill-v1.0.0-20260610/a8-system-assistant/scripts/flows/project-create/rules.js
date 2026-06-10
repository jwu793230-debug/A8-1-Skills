"use strict";

const config = require("./config");

const requiredForMinimalSave = [
  "projectName",
  "customerName",
  "sales",
  "business",
  "presales",
  "winRate",
  "progress",
  "estimatedAmount",
  "province",
  "city",
];

function validateProjectCreateInput(input = {}) {
  const errors = [];
  for (const key of requiredForMinimalSave) {
    if (!String(input[key] ?? "").trim()) {
      errors.push({
        key,
        fieldId: config.fields[key] || "",
        label: config.fieldLabels[key] || key,
        message: "minimal-save sample requires this value",
      });
    }
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

function summarizeObservationRisks() {
  return [
    {
      key: "customerName",
      fieldId: config.fields.customerName,
      risk: "客户名称是 text relation 控件，保存前必须确认 relation 元数据真实回填，不能只写可见文字。",
    },
    {
      key: "peopleControls",
      fieldIds: [config.fields.sales, config.fields.business, config.fields.presales],
      risk: "销售、商务、售前是 people picker 控件，必须通过人员选择器或确认后的组件 API 回填。",
    },
    {
      key: "regionCascade",
      fieldIds: [config.fields.province, config.fields.city, config.fields.district],
      risk: "市、区县依赖上一级选择；未选省时市/区县菜单为空。",
    },
    {
      key: "saveScope",
      risk: "本阶段只做 observation-only 和样本设计；保存待发入口必须单独实现并加保存前 readback gate。",
    },
  ];
}

module.exports = {
  requiredForMinimalSave,
  validateProjectCreateInput,
  summarizeObservationRisks,
};
