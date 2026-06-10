"use strict";

module.exports = {
  flowName: "change_add_save_draft",
  baseUrl: "https://a8.uni-ubi.com",
  iframeId: "zwIframe",
  pageLoadTimeoutMs: 30000,
  iframeLoadTimeoutMs: 45000,
  mainTableName: "formmain_0683",
  detailTableName: "formson_0684",
  fields: {
    projectCodeOrQuotationNo: "field0009",
    projectName: "field0010",
    customerCode: "field0011",
    customerName: "field0012",
    changedAuxMaterial: "field0038",
    changedInstallDebugFee: "field0042",
    mainChangeType: "field0099",
    addType: "field0098",
  },
  detailFields: {
    changeType: "field0019",
    productCode: "field0020",
    productName: "field0021",
    originalQuantity: "field0022",
    addedQuantity: "field0023",
    changedQuantity: "field0024",
    taxPrice: "field0025",
  },
  relationButtons: {
    projectProduct: "多选项目产品信息",
    inventoryProduct: "多选存货产品编号",
    rawMaterial: "多选原材料信息",
    productCode: "多选产品编号",
  },
  relationShipIdForProjectCode: "-583468583860482528",
  relationShipIdForQuotation: "3859070028047142169",
  relationShipIdForInventoryProduct: "7447512736147392347",
  targetUrl:
    "https://a8.uni-ubi.com/seeyon/collaboration/collaboration.do?method=newColl&from=bizconfig&firstName=%E8%81%8C%E8%83%BD%E7%B1%BB&secondName=%E6%8A%A5%E4%BB%B7%E6%B8%85%E5%8D%95%E5%8F%98%E6%9B%B4&menuId=1504114103205580015&templateId=-8080195825513903403&showTab=true&showTab=true",
};
