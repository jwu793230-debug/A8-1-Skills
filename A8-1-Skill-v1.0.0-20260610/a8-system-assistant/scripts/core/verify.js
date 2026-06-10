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

function normalizeExpectedRow(row = {}) {
  return {
    materialNo: normalizeText(row.materialNo || row.code || row.productCode || ""),
    quantity: normalizeNumberString(row.quantity),
    taxPrice: normalizeNumberString(row.taxPrice ?? row.unitPrice ?? row.price ?? ""),
  };
}

function normalizeActualRow(row = {}) {
  return {
    materialNo: normalizeText(
      row.materialNo || row.code || row.productCode || row.productNo || row.productCodeText || ""
    ),
    quantity: normalizeNumberString(row.quantity),
    taxPrice: normalizeNumberString(row.taxPrice ?? row.unitPrice ?? row.price ?? ""),
  };
}

function compareRows(expectedRows = [], actualRows = []) {
  const diffs = [];
  const maxLength = Math.max(expectedRows.length, actualRows.length);

  for (let index = 0; index < maxLength; index += 1) {
    const expected = normalizeExpectedRow(expectedRows[index] || {});
    const actual = normalizeActualRow(actualRows[index] || {});
    const rowDiff = {
      rowIndex: index + 1,
      expected,
      actual,
      fields: [],
    };

    if (expected.materialNo !== actual.materialNo) {
      rowDiff.fields.push("materialNo");
    }
    if (expected.quantity !== actual.quantity) {
      rowDiff.fields.push("quantity");
    }
    if (expected.taxPrice !== actual.taxPrice) {
      rowDiff.fields.push("taxPrice");
    }

    if (rowDiff.fields.length > 0) {
      diffs.push(rowDiff);
    }
  }

  return {
    ok: diffs.length === 0,
    diffCount: diffs.length,
    diffs,
  };
}

function compareHeader(expected = {}, actual = {}) {
  const diff = {};

  const pairs = [
    ["projectCodeOrQuotationNo", normalizeText],
    ["changedAuxMaterial", normalizeNumberString],
    ["changedInstallDebugFee", normalizeNumberString],
  ];

  for (const [field, normalizer] of pairs) {
    const expectedValue = normalizer(expected[field]);
    const actualValue = normalizer(actual[field]);
    if (expectedValue !== actualValue) {
      diff[field] = {
        expected: expectedValue,
        actual: actualValue,
      };
    }
  }

  return {
    ok: Object.keys(diff).length === 0,
    diff,
  };
}

function verifyChangeAddReadback(compareTarget = {}, actual = {}) {
  const header = compareHeader(compareTarget, actual);
  const rows = compareRows(compareTarget.rows || [], actual.rows || []);
  return {
    ok: header.ok && rows.ok,
    header,
    rows,
  };
}

module.exports = {
  normalizeText,
  normalizeNumberString,
  normalizeExpectedRow,
  normalizeActualRow,
  compareRows,
  compareHeader,
  verifyChangeAddReadback,
};
