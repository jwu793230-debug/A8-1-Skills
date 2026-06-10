"use strict";

function buildRowPlan(materials = []) {
  const rows = materials.map((item, index) => ({
    rowIndex: index + 1,
    materialNo: String(item?.materialNo || item?.code || "").trim(),
    quantity: String(item?.quantity ?? "").trim(),
    taxPrice: String(item?.taxPrice ?? item?.unitPrice ?? item?.price ?? "").trim(),
    actions: [
      "select_change_type_new",
      "select_stock_source_new_inventory",
      "pick_material",
      "fill_quantity",
      "fill_tax_price",
      "wait_calculation",
      "verify_row",
    ],
  }));

  return {
    rowCount: rows.length,
    rows,
  };
}

function splitRowsIntoPages(materials = [], pageSize = 20) {
  const normalizedPageSize = Number(pageSize) > 0 ? Number(pageSize) : 20;
  const pages = [];
  for (let index = 0; index < materials.length; index += normalizedPageSize) {
    pages.push({
      pageIndex: pages.length + 1,
      startRowIndex: index + 1,
      rows: materials.slice(index, index + normalizedPageSize),
    });
  }
  return {
    pageSize: normalizedPageSize,
    pageCount: pages.length,
    pages,
  };
}

function buildCapacityPlan(materialCount, currentVisibleRows = 0, pageSize = 20) {
  const count = Number(materialCount) || 0;
  const visible = Number(currentVisibleRows) || 0;
  const additionsNeeded = Math.max(0, count - visible);
  return {
    targetCount: count,
    currentVisibleRows: visible,
    additionsNeeded,
    pagination: splitRowsIntoPages(new Array(count).fill(null), pageSize),
  };
}

module.exports = {
  buildRowPlan,
  splitRowsIntoPages,
  buildCapacityPlan,
};
