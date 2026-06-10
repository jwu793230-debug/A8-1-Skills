"use strict";

const fields = {
  documentNo: "field0016",
  applicant: "field0001",
  applicantDepartment: "field0002",
  applyDate: "field0003",
  projectNo: "field0004",
  projectName: "field0005",
  customerName: "field0006",
  projectDescription: "field0007",
  sales: "field0008",
  business: "field0009",
  presales: "field0010",
  winRate: "field0011",
  estimatedAmount: "field0013",
  province: "field0019",
  city: "field0014",
  progress: "field0020",
  district: "field0023",
};

const fieldLabels = {
  documentNo: "单据编号",
  applicant: "申请人",
  applicantDepartment: "申请部门",
  applyDate: "申请日期",
  projectNo: "项目编号",
  projectName: "项目名称",
  customerName: "客户名称",
  projectDescription: "项目描述",
  sales: "销售",
  business: "商务",
  presales: "售前",
  winRate: "项目成单率",
  estimatedAmount: "项目预估金额",
  province: "项目所属省",
  city: "项目所属市",
  progress: "项目进度",
  district: "项目所属区县",
};

const controlTypes = {
  documentNo: "text-browse",
  applicant: "people-browse",
  applicantDepartment: "field-choose-browse",
  applyDate: "date-browse",
  projectNo: "text-browse",
  projectName: "text-edit",
  customerName: "text-relation",
  projectDescription: "textarea-edit",
  sales: "people-picker",
  business: "people-picker",
  presales: "people-picker",
  winRate: "select",
  estimatedAmount: "number-edit",
  province: "select-cascade-root",
  city: "select-cascade-child",
  progress: "select",
  district: "select-cascade-child",
};

const observedOptions = {
  winRate: ["25%", "50%", "75%", "100%"],
  progress: ["前期洽谈", "方案介绍和商务报价", "项目已成单", "项目搁置"],
  province: [
    "浙江省",
    "北京市",
    "天津市",
    "河北省",
    "山西省",
    "内蒙古自治区",
    "辽宁省",
    "吉林省",
    "黑龙江省",
    "上海市",
    "江苏省",
    "安徽省",
    "福建省",
    "江西省",
    "山东省",
    "河南省",
    "湖北省",
    "湖南省",
    "广东省",
    "广西壮族自治区",
    "海南省",
    "重庆市",
    "四川省",
    "贵州省",
    "云南省",
    "西藏自治区",
    "陕西省",
    "甘肃省",
    "青海省",
    "宁夏回族自治区",
    "新疆维吾尔自治区",
    "台湾省",
    "香港特别行政区",
    "澳门特别行政区",
    "外贸",
  ],
};

const knownControlDefaults = {
  customers: [
    {
      aliases: ["葛洲坝建筑科技", "葛洲坝建筑科技（成都）有限公司"],
      value: "葛洲坝建筑科技（成都）有限公司",
      showValue: "葛洲坝建筑科技（成都）有限公司",
      showValue2: "葛洲坝建筑科技（成都）有限公司",
    },
  ],
  people: {
    sales: [
      {
        aliases: ["天列", "天列（林云）", "林云"],
        value: "-6612142102231366997",
        showValue: "天列（林云）",
        showValue2: "Member|-6612142102231366997",
      },
    ],
    business: [
      {
        aliases: ["辰星", "辰星（汪小燕）", "汪小燕"],
        value: "1663058545964237544",
        showValue: "辰星（汪小燕）",
        showValue2: "Member|1663058545964237544",
      },
    ],
    presales: [
      {
        aliases: ["维鹊", "维鹊（吴嘉玮）", "吴嘉玮"],
        value: "-8882299773290593788",
        showValue: "维鹊（吴嘉玮）",
        showValue2: "Member|-8882299773290593788",
      },
    ],
  },
};

const defaultTemplateId = "7182277106746279011";
const configuredTemplateId = String(process.env.A8_PROJECT_CREATE_TEMPLATE_ID || "").trim() || defaultTemplateId;
const configuredTargetUrl =
  String(process.env.A8_PROJECT_CREATE_TARGET_URL || "").trim() ||
  (configuredTemplateId !== defaultTemplateId
    ? `https://a8.uni-ubi.com/seeyon/collaboration/collaboration.do?method=newColl&from=templateNewColl&templateId=${encodeURIComponent(configuredTemplateId)}&showTab=true`
    : "https://a8.uni-ubi.com/seeyon/collaboration/collaboration.do?method=newColl&from=bizconfig&firstName=%E8%81%8C%E8%83%BD%E7%B1%BB&secondName=%E9%9B%86%E6%88%90%E9%A1%B9%E7%9B%AE%E5%88%9B%E5%BB%BA%E5%8D%95&menuId=1504114103205580015&templateId=7182277106746279011&showTab=true&showTab=true");

module.exports = {
  flowName: "project_create_observe",
  businessName: "集成项目创建单",
  baseUrl: "https://a8.uni-ubi.com",
  iframeId: "zwIframe",
  pageLoadTimeoutMs: 30000,
  iframeLoadTimeoutMs: 45000,
  mainTableName: "formmain_0035",
  templateId: configuredTemplateId,
  menuId: "1504114103205580015",
  targetUrl: configuredTargetUrl,
  fields,
  fieldLabels,
  controlTypes,
  observedOptions,
  knownControlDefaults,
  cascadeFields: {
    province: fields.province,
    city: fields.city,
    district: fields.district,
  },
};
