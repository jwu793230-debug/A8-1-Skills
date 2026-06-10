"use strict";

const config = require("./config");

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeProjectCreateInput(input = {}) {
  return {
    projectName: normalizeText(input.projectName),
    customerName: normalizeText(input.customerName),
    projectDescription: normalizeText(input.projectDescription),
    sales: normalizeText(input.sales),
    business: normalizeText(input.business),
    presales: normalizeText(input.presales),
    winRate: normalizeText(input.winRate),
    progress: normalizeText(input.progress),
    estimatedAmount: normalizeText(input.estimatedAmount),
    province: normalizeText(input.province),
    city: normalizeText(input.city),
    district: normalizeText(input.district),
  };
}

function buildProjectCreateExecutionPlan(input = {}) {
  const normalized = normalizeProjectCreateInput(input);
  return {
    flow: config.flowName,
    businessName: config.businessName,
    mode: "observation-only",
    templateId: config.templateId,
    targetUrl: config.targetUrl,
    mainTableName: config.mainTableName,
    fields: config.fields,
    requestedValues: normalized,
  };
}

function buildMinimalSaveDraftSample() {
  return {
    flow: "project_create_save_draft",
    status: "placeholder-only",
    note: "This placeholder is for documentation only. Replace every value with the user's actual project data before saving to wait-send.",
    input: {
      projectName: "<项目名称>",
      customerName: "<客户名称>",
      projectDescription: "<项目描述>",
      sales: "<销售>",
      business: "<商务>",
      presales: "<售前>",
      winRate: "25%",
      progress: "前期洽谈",
      estimatedAmount: "<项目预估金额>",
      province: "<项目所属省>",
      city: "<项目所属市>",
      district: "<项目所属区县>",
    },
    saveGate: [
      "项目名称已写入 field0005",
      "客户名称 relation field0006 已真实回填",
      "销售/商务/售前 people 控件显示值与输入一致",
      "成单率/进度/省市区县下拉显示值与输入一致",
      "项目预估金额 field0013 非空",
      "只点击保存待发，不点击发送",
    ],
  };
}

module.exports = {
  normalizeProjectCreateInput,
  buildProjectCreateExecutionPlan,
  buildMinimalSaveDraftSample,
};
