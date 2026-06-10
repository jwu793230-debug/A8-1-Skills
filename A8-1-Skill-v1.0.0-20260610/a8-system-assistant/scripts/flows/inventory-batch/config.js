"use strict";

const baseUrl = "https://a8.uni-ubi.com";
const businessName =
  "\u5b58\u8d27\u6863\u6848\u65b0\u5efa\u7533\u8bf7-\u6279\u91cf";

const params = new URLSearchParams({
  method: "newColl",
  from: "bizconfig",
  firstName: "\u804c\u80fd\u7c7b",
  secondName: businessName,
  menuId: "1504114103205580015",
  templateId: "-6993008701521247865",
  showTab: "true",
});

const fields = {
  applicant: "field0001",
  applicantDepartment: "field0002",
  applyDate: "field0003",
  businessDepartment: "field0130",
};

const fieldLabels = {
  applicant: "\u7533\u8bf7\u4eba",
  applicantDepartment: "\u7533\u8bf7\u90e8\u95e8",
  applyDate: "\u7533\u8bf7\u65e5\u671f",
  businessDepartment: "\u4e8b\u4e1a\u90e8\u95e8",
};

const controlTypes = {
  applicant: "people-browse",
  applicantDepartment: "department-browse",
  applyDate: "date-browse",
  businessDepartment: "select-or-relation",
};

const detailFields = {
  materialCode: "field0089",
  businessDepartment: "field0090",
  applicationCategory: "field0091",
  researchMethod: "field0134",
  subsystem: "field0145",
  productSeries: "field0146",
  materialSegment: "field0103",
  productName: "field0100",
  model: "field0101",
  invoiceModel: "field0104",
  invoiceName: "field0125",
  productDescription: "field0126",
  designatedSupplier: "field0150",
  originalModel: "field0113",
  manufacturerName: "field0114",
  brand: "field0116",
  unit: "field0142",
  temporaryMaterial: "field0092",
  bomType: "field0107",
  bomStatus: "field0108",
  materialStatus: "field0109",
  tagType: "field0111",
  invoiceUnit: "field0144",
  invoiceTaxType: "field0137",
  outputTaxRate: "field0147",
  inputTaxRate: "field0148",
  cost: "field0099",
  freight: "field0102",
  totalCost: "field0105",
  channelPrice: "field0119",
  strategicPrice: "field0121",
  directPrice: "field0123",
  promotionAdvice: "field0127",
  remark: "field0128",
};

const detailFieldLabels = {
  materialCode: "\u7269\u6599\u7f16\u7801",
  businessDepartment: "\u4e8b\u4e1a\u90e8\u95e8",
  applicationCategory: "\u7533\u8bf7\u7c7b\u522b",
  researchMethod: "\u7814\u53d1\u65b9\u5f0f",
  subsystem: "\u5b50\u7cfb\u7edf-2025",
  productSeries: "\u4ea7\u54c1\u7cfb\u5217-2025",
  materialSegment: "\u6599\u53f7\u6bb5",
  productName: "\u4ea7\u54c1\u540d\u79f0",
  model: "\u89c4\u683c\u578b\u53f7",
  invoiceModel: "\u5f00\u7968\u89c4\u683c\u578b\u53f7",
  invoiceName: "\u5b58\u8d27\u5f00\u7968\u540d\u79f0",
  productDescription: "\u4ea7\u54c1\u63cf\u8ff0",
  designatedSupplier: "\u662f\u5426\u6307\u5b9a\u4f9b\u5e94\u5546",
  originalModel: "\u539f\u5382\u578b\u53f7",
  manufacturerName: "\u5382\u5bb6\u540d\u79f0",
  brand: "\u54c1\u724c",
  unit: "\u8ba1\u91cf\u5355\u4f4d",
  temporaryMaterial: "\u662f\u5426\u4e34\u65f6\u6599\u53f7",
  bomType: "BOM\u7c7b\u578b",
  bomStatus: "BOM\u72b6\u6001",
  materialStatus: "\u7269\u6599\u72b6\u6001",
  tagType: "\u6807\u7b7e\u7c7b\u578b",
  invoiceUnit: "\u5b58\u8d27\u5f00\u7968\u5355\u4f4d",
  invoiceTaxType: "\u5b58\u8d27\u7a0e\u5c40\u7c7b\u578b",
  outputTaxRate: "\u9500\u9879\u7a0e\u7387",
  inputTaxRate: "\u8fdb\u9879\u7a0e\u7387",
  cost: "\u6210\u672c",
  freight: "\u8fd0\u8f93\u8d39\u7528",
  totalCost: "\u6210\u672c\u5408\u8ba1",
  channelPrice: "\u6e20\u9053\u4ef7\u683c",
  strategicPrice: "\u6218\u7565\u5408\u4f5c\u4ef7",
  directPrice: "\u76f4\u9500\u4ef7\u683c",
  promotionAdvice: "\u63a8\u5e7f\u5efa\u8bae",
  remark: "\u5907\u6ce8",
};

const plannedDetailFieldGroups = {
  classification: [
    "\u7533\u8bf7\u7c7b\u522b",
    "\u7814\u53d1\u65b9\u5f0f",
    "\u5b50\u7cfb\u7edf",
    "\u4ea7\u54c1\u7cfb\u5217",
    "\u6599\u53f7\u6bb5",
    "\u6807\u7b7e\u7c7b\u578b",
    "\u63a8\u5e7f\u5efa\u8bae",
  ],
  commercial: [
    "\u5f00\u7968\u89c4\u683c\u578b\u53f7",
    "\u539f\u5382\u578b\u53f7",
    "\u54c1\u724c",
    "\u5382\u5bb6\u540d\u79f0",
  ],
  pricing: [
    "\u6210\u672c\u4ef7",
    "\u9500\u9879\u7a0e\u7387",
    "\u8fdb\u9879\u7a0e\u7387",
  ],
};

const toolbarLabels = [
  "\u65b0\u5efa",
  "\u590d\u5236",
  "\u5220\u9664",
  "\u5220\u9664\u5168\u90e8",
  "\u5bfc\u5165\u6570\u636e",
  "\u5bfc\u51fa\u6570\u636e",
];

const knownEnumValues = {
  applicationCategory: {
    "\u5916\u8d2d": "-4807814974710984923",
  },
  researchMethod: {
    "\u5916\u8d2d": "-2834828390536886903",
  },
  subsystem: {
    "\u5176\u4ed6\u5b50\u7cfb\u7edf": "-4528345614496544594",
  },
  productSeries: {
    "\u901a\u7528\u4ea7\u54c1": "9196554199095529120",
    "\u89c6\u9891\u76d1\u63a7\u914d\u4ef6": "-3755396256184512965",
    IPC: "7917067334678498121",
  },
  designatedSupplier: {
    "\u5426": "8662092600316086608",
  },
  temporaryMaterial: {
    "\u662f": "-2618037624300025135",
  },
  tagType: {
    "\u57fa\u7ebf": "-979734202431159576",
  },
  outputTaxRate: {
    "13%": "4175552475660633863",
  },
  inputTaxRate: {
    "13%": "4175552475660633863",
  },
  promotionAdvice: {
    "\u4e0d\u63a8\u8350": "5655853278232331313",
  },
};

module.exports = {
  flowName: "inventory_batch_observe",
  businessName,
  baseUrl,
  iframeId: "zwIframe",
  pageLoadTimeoutMs: 30000,
  iframeLoadTimeoutMs: 45000,
  templateId: "-6993008701521247865",
  menuId: "1504114103205580015",
  mainTableName: "formmain_0506",
  detailTableName: "formson_0507",
  targetUrl: `${baseUrl}/seeyon/collaboration/collaboration.do?${params.toString()}&showTab=true`,
  observedDraft: null,
  fields,
  fieldLabels,
  controlTypes,
  detailFields,
  detailFieldLabels,
  plannedDetailFieldGroups,
  toolbarLabels,
  knownEnumValues,
  importExportLabels: [
    "\u5bfc\u51fa\u6570\u636e",
    "\u5bfc\u5165\u6570\u636e",
  ],
};
