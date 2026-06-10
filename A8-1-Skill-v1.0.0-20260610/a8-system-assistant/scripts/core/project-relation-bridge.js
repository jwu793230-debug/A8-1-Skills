"use strict";

function normalizeOptionalText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeComparisonText(value) {
  return normalizeOptionalText(value).toLowerCase();
}

function collectRelationCellTexts(cell) {
  if (!cell || typeof cell !== "object") return [];
  return [
    cell.value,
    cell.showValue,
    cell.display,
    cell.text,
    cell.name,
  ]
    .map((value) => normalizeOptionalText(value))
    .filter(Boolean);
}

function getRelationRowCandidateTexts(item, preferredFieldNames = []) {
  const texts = [];
  const pushValue = (value) => {
    const normalized = normalizeOptionalText(value);
    if (normalized) texts.push(normalized);
  };

  for (const fieldName of preferredFieldNames) {
    const cell = item?.showData?.[fieldName];
    for (const text of collectRelationCellTexts(cell)) {
      pushValue(text);
    }
    if (fieldName in (item || {})) {
      pushValue(item[fieldName]);
    }
  }

  for (const [fieldName, cell] of Object.entries(item?.showData || {})) {
    if (preferredFieldNames.includes(fieldName)) continue;
    for (const text of collectRelationCellTexts(cell)) {
      pushValue(text);
    }
  }

  for (const [key, value] of Object.entries(item || {})) {
    if (key === "showData" || key === "recordId" || key === "groupSort") continue;
    if (value && typeof value === "object") {
      for (const text of collectRelationCellTexts(value)) {
        pushValue(text);
      }
      continue;
    }
    pushValue(value);
  }

  return [...new Set(texts)];
}

function extractFieldValue(control) {
  if (!control || typeof control !== "object") {
    return "";
  }
  if ("value" in control) {
    return control.value ?? "";
  }
  return "";
}

function buildRowFromPageItem(item) {
  const row = {
    id: item.recordId,
    recordId: item.recordId,
  };
  if (item.groupSort !== undefined) {
    row.groupSort = item.groupSort;
  }
  for (const [key, value] of Object.entries(item || {})) {
    if (key === "recordId" || key === "groupSort") continue;
    if (value && typeof value === "object" && "value" in value) {
      row[key] = value.value;
    }
  }
  return row;
}

function buildRowFromVmRecord(record) {
  const row = {
    id: record?.recordId || "",
    recordId: record?.recordId || "",
  };
  if (record?.groupSort !== undefined) {
    row.groupSort = record.groupSort;
  }
  for (const [key, value] of Object.entries(record?.lists || {})) {
    if (value && typeof value === "object" && "value" in value) {
      row[key] = value.value;
    }
  }
  return row;
}

function buildRowFromPatch(recordId, patch) {
  const row = {
    id: recordId,
    recordId,
  };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && "value" in value) {
      row[key] = value.value;
    }
  }
  return row;
}

function mergeRowsByRecordId(...rowGroups) {
  const rowMap = new Map();
  for (const rows of rowGroups) {
    for (const row of rows || []) {
      const recordId = String(row?.recordId || row?.id || "").trim();
      if (!recordId) continue;
      const current = rowMap.get(recordId) || {
        id: recordId,
        recordId,
      };
      rowMap.set(recordId, {
        ...current,
        ...row,
        id: recordId,
        recordId,
      });
    }
  }
  return [...rowMap.values()];
}

function extractSonRowsFromPageState(sonTableInfo, tableDataEntry) {
  const pageRows = Array.isArray(sonTableInfo?.pageData?.items)
    ? sonTableInfo.pageData.items.map((item) => buildRowFromPageItem(item))
    : [];
  const addRows = Array.isArray(tableDataEntry?.add)
    ? tableDataEntry.add.map((item) => buildRowFromPageItem(item))
    : [];
  const updateRows = Object.entries(tableDataEntry?.update || {}).map(([recordId, patch]) =>
    buildRowFromPatch(recordId, patch)
  );
  return mergeRowsByRecordId(pageRows, addRows, updateRows);
}

function extractSonRowsFromVmState(pageState, sonTableInfo) {
  const frontTableName = sonTableInfo?.frontTableName || "";
  const vmRows = Array.isArray(pageState?.formsons?.[frontTableName]?.records)
    ? pageState.formsons[frontTableName].records
        .map((record) => buildRowFromVmRecord(record))
        .filter((row) => row.recordId)
    : [];
  return vmRows;
}

function buildMergeDataFromPageState(pageState) {
  const root = pageState?.formData || {};
  const content = root.content || {};
  const tableInfo = root.tableInfo || {};
  const mainTableInfo = tableInfo.formmain || {};
  const sonTableInfos = Array.isArray(tableInfo.formson) ? tableInfo.formson : [];
  const formmains = pageState?.formmains || {};
  const tableData = root.tableData || pageState?.tableData || {};
  const mainTableName = Object.keys(formmains)[0] || mainTableInfo.tableName || "";
  const mainControls = formmains[mainTableName] || {};
  const mainData = {};

  for (const fieldName of Object.keys(mainTableInfo.fieldInfo || {})) {
    mainData[fieldName] = extractFieldValue(mainControls[fieldName]);
  }

  const payload = {
    content: {
      ...content,
      title: content.title || "报价清单变更（桥接）",
      moduleId: content.moduleId || content.contentDataId,
      moduleTemplateId: content.moduleTemplateId || "-1",
      isMerge: "1",
      saveType: "5",
      operateType: "0",
      checkNull: "0",
      needCheckRule: "1",
      needCheckCustom: "1",
      needAutoCollect: "1",
      needSn: "1",
      optType: "saveAs",
    },
    attachments: [],
    pageInfo: {},
  };

  if (mainTableName) {
    payload[mainTableName] = mainData;
  }

  for (const sonTableInfo of sonTableInfos) {
    const rows = mergeRowsByRecordId(
      extractSonRowsFromVmState(pageState, sonTableInfo),
      extractSonRowsFromPageState(
        sonTableInfo,
        tableData?.[sonTableInfo.tableName] || {}
      )
    );
    const pageSize = Math.max(Number(sonTableInfo?.pageData?.pageSize || 20), rows.length || 0);
    payload[sonTableInfo.tableName] = rows;
    payload.pageInfo[sonTableInfo.tableName] = {
      size: String(pageSize || 20),
      page: "1",
    };
  }

  return {
    content,
    tableInfo,
    mainTableInfo,
    sonTableInfos,
    mainTableName,
    mainData,
    mergeData: payload,
  };
}

function collectRelationRows(relationResponse) {
  const directRows =
    relationResponse?.data?.data ||
    relationResponse?.data?.rows ||
    relationResponse?.data?.records ||
    relationResponse?.data?.list ||
    relationResponse?.data?.datas;
  if (Array.isArray(directRows)) return directRows;
  const pageDataRows =
    relationResponse?.data?.pageData?.items ||
    relationResponse?.data?.data?.pageData?.items;
  if (Array.isArray(pageDataRows)) return pageDataRows;
  return [];
}

function pickRelationRow(relationResponse, wantedCode, options = {}) {
  const rows = collectRelationRows(relationResponse);
  const preferredFieldNames = Array.isArray(options.preferredFieldNames)
    ? options.preferredFieldNames
    : [];
  const wanted = normalizeComparisonText(wantedCode);
  const bestRow =
    rows.find((item) =>
      getRelationRowCandidateTexts(item, preferredFieldNames).some(
        (value) => normalizeComparisonText(value) === wanted
      )
    ) || null;

  return {
    row: bestRow,
    rows,
  };
}

function summarizeRelationRows(relationResponse, options = {}) {
  const rows = collectRelationRows(relationResponse);
  const preferredFieldNames = Array.isArray(options.preferredFieldNames)
    ? options.preferredFieldNames
    : [];
  return rows.slice(0, 20).map((item) => ({
    masterId: item?.masterId || "",
    dataId: item?.dataId || "",
    unique: item?.unique || "",
    candidateTexts: getRelationRowCandidateTexts(item, preferredFieldNames),
  }));
}

function buildRelationCondition(filterField, fieldValue, operation) {
  return {
    aliasTableName: filterField?.aliasTableName || filterField?.tableName || "",
    fieldName: filterField?.name || filterField?.field || "",
    fieldType: filterField?.fieldType || "",
    fieldValue: normalizeOptionalText(fieldValue),
    inputType: filterField?.inputType || "",
    leftChar: "",
    operation,
    rightChar: "",
    rowOperation: "",
  };
}

function getFirstRelationFilterField(relationResponse) {
  const fields = relationResponse?.data?.filterFields;
  return Array.isArray(fields) && fields.length > 0 ? fields[0] : null;
}

async function requestJsonWithSession(request, url, options, jar) {
  const result = await request(url, options, jar);
  let json = null;
  try {
    json = JSON.parse(result.body);
  } catch (_error) {
    json = null;
  }
  return {
    ...result,
    json,
  };
}

async function findMainSelectorRelationRow({
  request,
  baseUrl,
  jar,
  iframeHref,
  content,
  mergeData,
  relationShipId,
  wantedCode,
}) {
  const relationQueryPayload = {
    relationShipId,
    isMainSelecter: true,
    selectedMasterDataId: "",
    templateId: content.contentTemplateId,
    fromDataId: content.contentDataId,
    fromRecordId: "",
    fromRelationAttr: "field0009",
    conditions: [],
    page: 1,
    pageSize: 100,
    isInit: "1",
    mergeData,
    isTree: false,
  };

  let relationQueryResult = await requestJsonWithSession(
    request,
    `${baseUrl}/seeyon/rest/cap4/form/getFormRelationDatas`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Origin: baseUrl,
        Referer: iframeHref,
      },
      body: JSON.stringify(relationQueryPayload),
    },
    jar
  );

  const filterFields = relationQueryResult?.json?.data?.filterFields || [];
  let relationPick = pickRelationRow(relationQueryResult.json, wantedCode, {
    preferredFieldNames: filterFields.map((item) => item?.name).filter(Boolean),
  });
  const filterField = getFirstRelationFilterField(relationQueryResult.json);

  if (!relationPick.row && filterField) {
    const searchConditions = [
      buildRelationCondition(filterField, wantedCode, "Equal"),
      buildRelationCondition(filterField, wantedCode, "Like"),
    ];

    for (const conditions of searchConditions.map((item) => [item])) {
      const currentPayload = {
        ...relationQueryPayload,
        conditions,
        page: 1,
        isInit: "0",
      };
      const currentResult = await requestJsonWithSession(
        request,
        `${baseUrl}/seeyon/rest/cap4/form/getFormRelationDatas`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            Origin: baseUrl,
            Referer: iframeHref,
          },
          body: JSON.stringify(currentPayload),
        },
        jar
      );
      relationQueryResult = currentResult;
      relationPick = pickRelationRow(currentResult.json, wantedCode, {
        preferredFieldNames: filterFields.map((item) => item?.name).filter(Boolean),
      });
      if (relationPick.row) {
        break;
      }
    }
  }

  if (!relationPick.row) {
    for (let page = 1; page <= 50; page += 1) {
      const currentPayload = {
        ...relationQueryPayload,
        page,
      };
      const currentResult = await requestJsonWithSession(
        request,
        `${baseUrl}/seeyon/rest/cap4/form/getFormRelationDatas`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            Origin: baseUrl,
            Referer: iframeHref,
          },
          body: JSON.stringify(currentPayload),
        },
        jar
      );
      relationQueryResult = currentResult;
      relationPick = pickRelationRow(currentResult.json, wantedCode, {
        preferredFieldNames: filterFields.map((item) => item?.name).filter(Boolean),
      });
      if (relationPick.row) {
        break;
      }
      if (relationPick.rows.length < currentPayload.pageSize) {
        break;
      }
    }
  }

  return {
    relationQueryPayload,
    relationQueryResult,
    relationPick,
    filterFields,
  };
}

async function backfillMainSelectorRelation({
  request,
  baseUrl,
  jar,
  iframeHref,
  content,
  mergeData,
  relationShipId,
  selectedRow,
}) {
  return requestJsonWithSession(
    request,
    `${baseUrl}/seeyon/rest/cap4/form/dealSelectedRelationData`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Origin: baseUrl,
        Referer: iframeHref,
      },
      body: JSON.stringify({
        relationShipId,
        fromDataId: content.contentDataId,
        selectDatas: [selectedRow],
        fromRecordId: "",
        fromRightId: content.rightId,
        selectRecordIds: {},
        mergeData,
      }),
    },
    jar
  );
}

function extractMainFieldUpdates(backfillJson, mainTableName) {
  const updateRows =
    backfillJson?.data?.data?.tableData?.[mainTableName]?.update || {};
  const updates = {};
  for (const [fieldName, fieldData] of Object.entries(updateRows)) {
    if (fieldData && typeof fieldData === "object" && "value" in fieldData) {
      updates[fieldName] = {
        value: fieldData.value ?? "",
        showValue:
          typeof fieldData.showValue !== "undefined" ? fieldData.showValue : "",
      };
    }
  }
  return updates;
}

async function findDetailRelationRow({
  request,
  baseUrl,
  jar,
  iframeHref,
  content,
  mergeData,
  relationShipId,
  fromRecordId,
  fromRelationAttr,
  wantedCode,
}) {
  const relationQueryPayload = {
    relationShipId,
    isMainSelecter: false,
    selectedMasterDataId: "",
    templateId: content.contentTemplateId,
    fromDataId: content.contentDataId,
    fromRecordId,
    fromRelationAttr,
    conditions: [],
    page: 1,
    pageSize: 100,
    isInit: "1",
    mergeData,
    isTree: false,
  };

  let relationQueryResult = await requestJsonWithSession(
    request,
    `${baseUrl}/seeyon/rest/cap4/form/getFormRelationDatas`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Origin: baseUrl,
        Referer: iframeHref,
      },
      body: JSON.stringify(relationQueryPayload),
    },
    jar
  );

  let relationPick = pickRelationRow(relationQueryResult.json, wantedCode);
  const filterField = getFirstRelationFilterField(relationQueryResult.json);

  if (!relationPick.row && filterField) {
    const searchConditions = [
      buildRelationCondition(filterField, wantedCode, "Equal"),
      buildRelationCondition(filterField, wantedCode, "Like"),
    ];

    for (const conditions of searchConditions.map((item) => [item])) {
      const currentPayload = {
        ...relationQueryPayload,
        conditions,
        page: 1,
        isInit: "0",
      };
      const currentResult = await requestJsonWithSession(
        request,
        `${baseUrl}/seeyon/rest/cap4/form/getFormRelationDatas`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            Origin: baseUrl,
            Referer: iframeHref,
          },
          body: JSON.stringify(currentPayload),
        },
        jar
      );
      relationQueryResult = currentResult;
      relationPick = pickRelationRow(currentResult.json, wantedCode);
      if (relationPick.row) {
        break;
      }
    }
  }

  if (!relationPick.row) {
    for (let page = 1; page <= 50; page += 1) {
      const currentPayload = {
        ...relationQueryPayload,
        page,
      };
      const currentResult = await requestJsonWithSession(
        request,
        `${baseUrl}/seeyon/rest/cap4/form/getFormRelationDatas`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            Origin: baseUrl,
            Referer: iframeHref,
          },
          body: JSON.stringify(currentPayload),
        },
        jar
      );
      relationQueryResult = currentResult;
      relationPick = pickRelationRow(currentResult.json, wantedCode);
      if (relationPick.row) {
        break;
      }
      if (relationPick.rows.length < currentPayload.pageSize) {
        break;
      }
    }
  }

  return {
    relationQueryPayload,
    relationQueryResult,
    relationPick,
  };
}

async function backfillDetailRelation({
  request,
  baseUrl,
  jar,
  iframeHref,
  content,
  mergeData,
  relationShipId,
  fromRecordId,
  selectedRow,
}) {
  return requestJsonWithSession(
    request,
    `${baseUrl}/seeyon/rest/cap4/form/dealSelectedRelationData`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Origin: baseUrl,
        Referer: iframeHref,
      },
      body: JSON.stringify({
        relationShipId,
        fromDataId: content.contentDataId,
        selectDatas: [selectedRow],
        fromRecordId,
        fromRightId: content.rightId,
        selectRecordIds: {},
        mergeData,
      }),
    },
    jar
  );
}

function flattenBackfillRow(recordPatch) {
  const row = {};
  for (const [fieldName, fieldData] of Object.entries(recordPatch || {})) {
    if (fieldData && typeof fieldData === "object" && "value" in fieldData) {
      row[fieldName] = fieldData.value;
    }
  }
  return row;
}

function extractDetailFieldUpdates(backfillJson, detailTableName, recordId) {
  const updateRows =
    backfillJson?.data?.data?.tableData?.[detailTableName]?.update || {};
  const recordPatch =
    updateRows[recordId] ||
    Object.values(updateRows)[0] ||
    null;
  return recordPatch ? flattenBackfillRow(recordPatch) : null;
}

function applyMainTableUpdate(mainData, backfillJson, mainTableName) {
  const updates = extractMainFieldUpdates(backfillJson, mainTableName);
  for (const [fieldName, fieldData] of Object.entries(updates)) {
    mainData[fieldName] = fieldData.value ?? "";
  }
  return mainData;
}

function applyDetailTableUpdate(rows, backfillJson, detailTableName) {
  const updateRows =
    backfillJson?.data?.data?.tableData?.[detailTableName]?.update || {};
  const rowMap = new Map(
    rows.map((row) => [String(row.recordId || row.id || ""), row]).filter(([key]) => key)
  );

  for (const [recordId, patch] of Object.entries(updateRows)) {
    const target = rowMap.get(String(recordId));
    if (!target) continue;
    Object.assign(target, flattenBackfillRow(patch));
    target.id = target.recordId || target.id;
    target.recordId = target.recordId || target.id;
  }

  return rows;
}

function extractAddedRowsFromSubBeanResponse(subBeanResponse, tableName) {
  const addRows = subBeanResponse?.data?.data?.tableData?.[tableName]?.add;
  if (!Array.isArray(addRows)) return [];
  return addRows
    .map((item) => buildRowFromPageItem(item))
    .filter((item) => item.recordId);
}

function buildMergeData(content, mainTableInfo, sonTableInfos, mainData, sonRows) {
  const payload = {
    content: {
      ...content,
      title: content.title || "报价清单变更（桥接）",
      moduleId: content.moduleId || content.contentDataId,
      moduleTemplateId: content.moduleTemplateId || "-1",
      isMerge: "1",
      saveType: "5",
      operateType: "0",
      checkNull: "0",
      needCheckRule: "1",
      needCheckCustom: "1",
      needAutoCollect: "1",
      needSn: "1",
      optType: "saveAs",
    },
    attachments: [],
    pageInfo: {},
  };

  payload[mainTableInfo.tableName] = mainData;

  for (const sonTableInfo of sonTableInfos) {
    const rows = sonRows[sonTableInfo.tableName] || [];
    const defaultPageSize = Number(sonTableInfo.pageData?.pageSize || 20);
    const pageSize = Math.max(defaultPageSize, rows.length || 0);
    payload[sonTableInfo.tableName] = rows;
    payload.pageInfo[sonTableInfo.tableName] = {
      size: String(pageSize || defaultPageSize),
      page: "1",
    };
  }

  return payload;
}

async function calculateForm({
  request,
  baseUrl,
  jar,
  iframeHref,
  content,
  tableName,
  fromRecordId,
  changeFields,
  mergeData,
}) {
  const normalizedChangeFields = [...new Set((changeFields || []).filter(Boolean))];
  const fullCalc = normalizedChangeFields.length > 1;
  const firstField = normalizedChangeFields[0] || "";
  const requestBody = {
    formMasterDataId: content.contentDataId,
    formId: content.contentTemplateId,
    rightId: content.rightId,
    fieldName: fullCalc
      ? ""
      : firstField.length >= 9
        ? firstField.slice(0, 9)
        : firstField,
    fromRecordId: fullCalc ? "" : fromRecordId || "",
    formSonTableName: tableName || "",
    changeFields: normalizedChangeFields,
    mergeData,
  };

  return {
    requestBody,
    result: await requestJsonWithSession(
      request,
      `${baseUrl}/seeyon/rest/cap4/form/calculate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Origin: baseUrl,
          Referer: iframeHref,
        },
        body: JSON.stringify(requestBody),
      },
      jar
    ),
  };
}

async function applyCalculateToForm({
  request,
  baseUrl,
  jar,
  iframeHref,
  content,
  mainTableInfo,
  sonTableInfos,
  mainData,
  sonRows,
  detailTableName,
  fromRecordId,
  changeFields,
}) {
  const mergeData = buildMergeData(
    content,
    mainTableInfo,
    sonTableInfos,
    mainData,
    sonRows
  );
  const response = await calculateForm({
    request,
    baseUrl,
    jar,
    iframeHref,
    content,
    tableName: detailTableName,
    fromRecordId,
    changeFields,
    mergeData,
  });
  applyMainTableUpdate(mainData, response.result.json, mainTableInfo.tableName);
  applyDetailTableUpdate(sonRows[detailTableName] || [], response.result.json, detailTableName);
  return response;
}

async function addDetailRowsToForm({
  request,
  baseUrl,
  jar,
  iframeHref,
  content,
  mergeData,
  detailTableName,
  preRecordId,
  addCount,
}) {
  return requestJsonWithSession(
    request,
    `${baseUrl}/seeyon/rest/cap4/form/addOrDelDataSubBean`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        Origin: baseUrl,
        Referer: iframeHref,
      },
      body: JSON.stringify({
        rightId: content.rightId,
        type: "add",
        tableName: detailTableName,
        recordIds: new Array(Math.max(0, Number(addCount || 0))).fill(""),
        preRecordId: preRecordId || "",
        formMasterId: content.contentDataId,
        formId: content.contentTemplateId,
        mergeData,
      }),
    },
    jar
  );
}

module.exports = {
  buildMergeDataFromPageState,
  buildMergeData,
  pickRelationRow,
  summarizeRelationRows,
  buildRelationCondition,
  getFirstRelationFilterField,
  findMainSelectorRelationRow,
  findDetailRelationRow,
  backfillMainSelectorRelation,
  backfillDetailRelation,
  extractMainFieldUpdates,
  extractDetailFieldUpdates,
  applyMainTableUpdate,
  applyDetailTableUpdate,
  flattenBackfillRow,
  extractAddedRowsFromSubBeanResponse,
  calculateForm,
  applyCalculateToForm,
  addDetailRowsToForm,
};
