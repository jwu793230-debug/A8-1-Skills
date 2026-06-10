"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  launchEdge,
  connectToFirstPageTarget,
  closeBrowserSession,
} = require("../../core/browser");
const {
  baseUrl,
  loginWithHttp,
  injectCookiesToCdp,
  request,
} = require("../../core/session");
const { openFlowPage } = require("../../core/navigation");
const {
  getPageFormState,
  applyBackfillTableData,
  applyProjectRelationTableData,
  readVisibleFieldValues,
  fillMainNumberField,
  fillDetailNumberField,
  clickIframeButtonByText,
  clickDetailToolbarButtonByText,
  countDetailRows,
  readDetailRows,
  setDetailSelectByText,
} = require("../../core/page-form");
const {
  buildMergeDataFromPageState,
  findMainSelectorRelationRow,
  backfillMainSelectorRelation,
  findDetailRelationRow,
  backfillDetailRelation,
  extractDetailFieldUpdates,
  applyMainTableUpdate,
  applyCalculateToForm,
  addDetailRowsToForm,
  extractAddedRowsFromSubBeanResponse,
} = require("../../core/project-relation-bridge");
const { buildRowPlan, buildCapacityPlan } = require("../../core/detail-grid");
const {
  buildChangeAddReadbackShape,
  buildChangeAddReadbackFromFormState,
} = require("../../core/form-reader");
const { verifyChangeAddReadback } = require("../../core/verify");
const {
  buildSaveDraftGateResult,
  saveDraftByMouse,
} = require("../../core/save-draft");
const { sleep } = require("../../core/browser");
const changeAddConfig = require("./config");
const { mapChangeAddRequest } = require("./mapper");

function buildTableDataApplyPayload(tableData, formmainName) {
  return {
    tableData,
    chooseFormsonIndex: {},
    types: "relation",
    replaceStatus: true,
    calcCallback: false,
    handlerStatus: true,
    calculateStatus: true,
    callbackFn: "",
    formmainName,
  };
}

async function openChangeAddSession({ runRoot }) {
  const httpSession = await loginWithHttp({
    scriptDir: path.resolve(__dirname, "..", "..", "legacy"),
  });

  const profileDir = path.join(runRoot, "edge-profile");
  const edge = await launchEdge({
    profileDir,
    startUrl: "about:blank",
    headless: true,
  });
  const browserSession = await connectToFirstPageTarget(edge.port);
  const session = {
    edge,
    ...browserSession,
  };

  await injectCookiesToCdp(session.cdp, httpSession.cookies, httpSession.baseUrl);
  const flowOpenResult = await openFlowPage(session.cdp, changeAddConfig);

  return {
    session,
    httpSession,
    flowOpenResult,
  };
}

function isBridgeStateReady(bridgeState) {
  return Boolean(
    bridgeState?.content?.contentDataId &&
    bridgeState?.content?.contentTemplateId &&
    bridgeState?.content?.rightId &&
    bridgeState?.mainTableName
  );
}

async function waitForChangeAddBridgeState({ cdp, timeoutMs = 12000, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    const pageFormState = await getPageFormState(cdp, changeAddConfig.iframeId);
    if (pageFormState?.ok && pageFormState.value) {
      const bridgeState = buildMergeDataFromPageState(pageFormState.value);
      lastState = {
        pageFormState,
        bridgeState,
      };
      if (isBridgeStateReady(bridgeState)) {
        return {
          ok: true,
          pageFormState,
          bridgeState,
        };
      }
    } else {
      lastState = {
        pageFormState,
        bridgeState: null,
      };
    }

    await sleep(intervalMs);
  }

  return {
    ok: false,
    stage: "wait-bridge-state-timeout",
    lastState,
  };
}

async function applyProjectRelationByCode({
  cdp,
  httpSession,
  iframeHref,
  projectCodeOrQuotationNo,
}) {
  const bridgeStateReady = await waitForChangeAddBridgeState({ cdp });
  if (!bridgeStateReady?.ok) {
    throw new Error(
      `Unable to obtain ready bridge state: ${
        bridgeStateReady?.lastState?.pageFormState?.error || bridgeStateReady?.stage || "unknown"
      }`
    );
  }

  const bridgeState = bridgeStateReady.bridgeState;
  const relationIds = [
    changeAddConfig.relationShipIdForProjectCode,
    changeAddConfig.relationShipIdForQuotation,
  ];

  let matchedRelationShipId = "";
  let relationResult = null;
  for (const relationShipId of relationIds) {
    const candidate = await findMainSelectorRelationRow({
      request,
      baseUrl,
      jar: httpSession.jar,
      iframeHref,
      content: bridgeState.content,
      mergeData: bridgeState.mergeData,
      relationShipId,
      wantedCode: projectCodeOrQuotationNo,
    });
    relationResult = candidate;
    if (candidate.relationPick.row) {
      matchedRelationShipId = relationShipId;
      break;
    }
  }

  if (!matchedRelationShipId || !relationResult?.relationPick?.row) {
    return {
      ok: false,
      stage: "query",
      matchedRelationShipId,
      relationResult,
    };
  }

  const backfillResult = await backfillMainSelectorRelation({
    request,
    baseUrl,
    jar: httpSession.jar,
    iframeHref,
    content: bridgeState.content,
    mergeData: bridgeState.mergeData,
    relationShipId: matchedRelationShipId,
    selectedRow: relationResult.relationPick.row,
  });

  const tableData = backfillResult?.json?.data?.data?.tableData || {};
  const applyResult = await applyProjectRelationTableData(
    cdp,
    changeAddConfig.iframeId,
    tableData
  );
  const afterFormState = await getPageFormState(cdp, changeAddConfig.iframeId);
  const afterVisible = await readVisibleFieldValues(cdp, changeAddConfig.iframeId, [
    "field0009",
    "field0010",
    "field0011",
    "field0012",
  ]);

  const mainTableName = bridgeState.mainTableName;
  const controls = afterFormState?.value?.formmains?.[mainTableName] || {};

  const verification = {
    field0009: controls.field0009?.value || "",
    field0010: controls.field0010?.value || "",
    field0011: controls.field0011?.value || "",
    field0012: controls.field0012?.value || "",
  };

  return {
    ok: Boolean(
      applyResult?.ok &&
      verification.field0009 === projectCodeOrQuotationNo &&
      verification.field0010 &&
      verification.field0011 &&
      verification.field0012
    ),
    matchedRelationShipId,
    applyResult,
    verification,
    afterVisible,
    backfillResultJson: backfillResult?.json || null,
  };
}

function runCompatScript(scriptPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Compat script exited with code ${code}`));
    });
  });
}

async function runChangeAddSaveDraft(extraEnv = {}) {
  const scriptPath = path.resolve(__dirname, "..", "..", "compat", "change-add-http.js");
  await runCompatScript(scriptPath, extraEnv);
}

function buildChangeAddExecutionPlan(input = {}) {
  const mapped = mapChangeAddRequest(input);
  return {
    ...mapped,
    detailPlan: buildRowPlan(mapped.rows),
    capacityPlan: buildCapacityPlan(mapped.rows.length, 1, 20),
  };
}

function verifyChangeAddBeforeSave(input = {}, actualReadback = {}) {
  const mapped = mapChangeAddRequest(input);
  const actual = buildChangeAddReadbackShape(actualReadback);
  const precheck = verifyChangeAddReadback(mapped.compareTarget, actual);
  return buildSaveDraftGateResult({
    precheck,
    allowed: precheck.ok,
    reason: precheck.ok ? "" : "page-readback-mismatch",
  });
}

async function readChangeAddPageForVerification({ cdp }) {
  const pageFormState = await getPageFormState(cdp, changeAddConfig.iframeId);
  if (!pageFormState?.ok || !pageFormState.value) {
    return {
      ok: false,
      stage: "read-form-state",
      error: pageFormState?.error || "unknown",
      message: pageFormState?.message || "",
    };
  }

  return {
    ok: true,
    readback: buildChangeAddReadbackFromFormState(pageFormState.value, changeAddConfig),
    raw: pageFormState.value,
  };
}

async function fillChangeAddMainFields({ cdp, baseInfo }) {
  const operations = [];

  if (baseInfo.changedAuxMaterial !== "") {
    const auxResult = await fillMainNumberField(
      cdp,
      changeAddConfig.iframeId,
      changeAddConfig.fields.changedAuxMaterial,
      baseInfo.changedAuxMaterial
    );
    operations.push({
      field: "changedAuxMaterial",
      fieldId: changeAddConfig.fields.changedAuxMaterial,
      result: auxResult,
    });
    if (!auxResult?.ok) {
      return {
        ok: false,
        stage: "fill-main-changedAuxMaterial",
        operations,
      };
    }
  }

  if (baseInfo.changedInstallDebugFee !== "") {
    const installResult = await fillMainNumberField(
      cdp,
      changeAddConfig.iframeId,
      changeAddConfig.fields.changedInstallDebugFee,
      baseInfo.changedInstallDebugFee
    );
    operations.push({
      field: "changedInstallDebugFee",
      fieldId: changeAddConfig.fields.changedInstallDebugFee,
      result: installResult,
    });
    if (!installResult?.ok) {
      return {
        ok: false,
        stage: "fill-main-changedInstallDebugFee",
        operations,
      };
    }
  }

  return {
    ok: true,
    operations,
  };
}

async function getChangeAddDetailRowCount({ cdp }) {
  const domCount = await countDetailRows(
    cdp,
    changeAddConfig.iframeId,
    changeAddConfig.detailTableName
  );
  const pageFormState = await getPageFormState(cdp, changeAddConfig.iframeId);
  const formStateCount =
    pageFormState?.ok && Array.isArray(pageFormState?.value?.formsons?.[changeAddConfig.detailTableName])
      ? pageFormState.value.formsons[changeAddConfig.detailTableName].length
      : 0;
  const bridgeStateCount =
    pageFormState?.ok && pageFormState.value
      ? Array.isArray(
          buildMergeDataFromPageState(pageFormState.value)?.mergeData?.[changeAddConfig.detailTableName]
        )
        ? buildMergeDataFromPageState(pageFormState.value).mergeData[changeAddConfig.detailTableName].length
        : 0
      : 0;

  return {
    ok: Boolean(domCount?.ok || pageFormState?.ok),
    domCount,
    formStateCount,
    bridgeStateCount,
    rowCount: Math.max(
      Number(domCount?.rowCount || 0),
      Number(formStateCount || 0),
      Number(bridgeStateCount || 0)
    ),
  };
}

async function clickFirstAvailableIframeButton(cdp, iframeId, candidates = []) {
  const attempts = [];
  for (const text of candidates) {
    const result = await clickIframeButtonByText(cdp, iframeId, text);
    attempts.push({
      text,
      result,
    });
    if (result?.ok) {
      return {
        ok: true,
        matchedText: text,
        result,
        attempts,
      };
    }
  }
  return {
    ok: false,
    attempts,
  };
}

async function clickFirstAvailableDetailToolbarButton(cdp, iframeId, detailTableName, candidates = []) {
  const attempts = [];
  for (const text of candidates) {
    const result = await clickDetailToolbarButtonByText(cdp, iframeId, {
      detailTableName,
      text,
    });
    attempts.push({
      text,
      result,
    });
    if (result?.ok) {
      return {
        ok: true,
        matchedText: text,
        result,
        attempts,
      };
    }
  }
  return {
    ok: false,
    attempts,
  };
}

async function ensureChangeAddDetailCapacity({ cdp, httpSession, iframeHref, rows }) {
  const operations = [];
  let capacityState = await getChangeAddDetailRowCount({ cdp });
  operations.push({
    stage: "initial-count",
    result: capacityState,
  });

  if (!capacityState?.ok) {
    return {
      ok: false,
      stage: "count-detail-rows-initial",
      operations,
    };
  }

  const additionsNeeded = Math.max(0, rows.length - Number(capacityState.rowCount || 0));
  for (let index = 0; index < additionsNeeded; index += 1) {
    const addResult = await clickFirstAvailableDetailToolbarButton(
      cdp,
      changeAddConfig.iframeId,
      changeAddConfig.detailTableName,
      ["\u65b0\u5efa", "\u65b0\u589e"]
    );
    operations.push({
      stage: "click-add-row",
      index: index + 1,
      result: addResult,
    });
    if (!addResult?.ok) {
      return {
        ok: false,
        stage: "click-add-row",
        operations,
      };
    }
    await sleep(400);
  }

  capacityState = await getChangeAddDetailRowCount({ cdp });
  operations.push({
    stage: "final-count",
    result: capacityState,
  });

  if (
    Number(capacityState?.rowCount || 0) < rows.length &&
    httpSession?.jar &&
    iframeHref
  ) {
    const bridgeStateReady = await waitForChangeAddBridgeState({ cdp });
    operations.push({
      stage: "bridge-state-before-add-fallback",
      ok: Boolean(bridgeStateReady?.ok),
      rowCount:
        bridgeStateReady?.ok &&
        Array.isArray(bridgeStateReady.bridgeState?.mergeData?.[changeAddConfig.detailTableName])
          ? bridgeStateReady.bridgeState.mergeData[changeAddConfig.detailTableName].length
          : 0,
    });

    if (!bridgeStateReady?.ok) {
      return {
        ok: false,
        stage: "read-bridge-state-before-add-fallback",
        operations,
      };
    }

    const bridgeRows = Array.isArray(
      bridgeStateReady.bridgeState?.mergeData?.[changeAddConfig.detailTableName]
    )
      ? bridgeStateReady.bridgeState.mergeData[changeAddConfig.detailTableName]
      : [];
    const anchorRow = [...bridgeRows]
      .reverse()
      .find((row) => String(row?.recordId || row?.id || "").trim());
    if (!anchorRow?.recordId) {
      return {
        ok: false,
        stage: "missing-detail-anchor-row",
        operations,
      };
    }

    const addCount = Math.max(0, rows.length - Number(capacityState.rowCount || 0));
    const bridgeAddResult = await addDetailRowsToForm({
      request,
      baseUrl,
      jar: httpSession.jar,
      iframeHref,
      content: bridgeStateReady.bridgeState.content,
      mergeData: bridgeStateReady.bridgeState.mergeData,
      detailTableName: changeAddConfig.detailTableName,
      preRecordId: anchorRow.recordId,
      addCount,
    });
    operations.push({
      stage: "bridge-add-rows",
      status: bridgeAddResult?.response?.status || null,
      addedRows: extractAddedRowsFromSubBeanResponse(
        bridgeAddResult?.json,
        changeAddConfig.detailTableName
      ).map((row) => row.recordId),
    });

    const applyPayload = buildTableDataApplyPayload(
      bridgeAddResult?.json?.data?.data?.tableData || {},
      bridgeStateReady.bridgeState.mainTableName
    );
    const applyBridgeAddResult = await applyBackfillTableData(
      cdp,
      changeAddConfig.iframeId,
      applyPayload,
      {
        mainTableName: bridgeStateReady.bridgeState.mainTableName,
        verifyFieldIds: [changeAddConfig.fields.projectCodeOrQuotationNo],
      }
    );
    operations.push({
      stage: "apply-bridge-add-rows",
      result: applyBridgeAddResult,
    });

    if (!applyBridgeAddResult?.ok) {
      const compatApplyResult = await applyProjectRelationTableData(
        cdp,
        changeAddConfig.iframeId,
        bridgeAddResult?.json?.data?.data?.tableData || {}
      );
      operations.push({
        stage: "apply-bridge-add-rows-compat",
        result: compatApplyResult,
      });
    }

    await sleep(500);
    capacityState = await getChangeAddDetailRowCount({ cdp });
    operations.push({
      stage: "post-bridge-count",
      result: capacityState,
    });
  }

  return {
    ok: Boolean(capacityState?.ok && Number(capacityState.rowCount || 0) >= rows.length),
    rowCount: Number(capacityState?.rowCount || 0),
    operations,
  };
}

async function fillChangeAddDetailRows({ cdp, rows }) {
  const operations = [];

  for (const row of rows) {
    const rowIndex = row.rowIndex;
    const changeTypeResult = await setDetailSelectByText(cdp, changeAddConfig.iframeId, {
      fieldId: changeAddConfig.detailFields.changeType,
      rowIndex,
      text: "\u65b0\u589e",
    });
    operations.push({
      rowIndex,
      stage: "set-change-type",
      result: changeTypeResult,
    });
    if (!changeTypeResult?.ok) {
      return {
        ok: false,
        stage: "set-change-type",
        rowIndex,
        operations,
      };
    }

    const quantityResult = await fillDetailNumberField(cdp, changeAddConfig.iframeId, {
      fieldId: changeAddConfig.detailFields.addedQuantity,
      rowIndex,
      value: row.quantity,
    });
    operations.push({
      rowIndex,
      stage: "fill-quantity",
      result: quantityResult,
    });
    if (!quantityResult?.ok) {
      return {
        ok: false,
        stage: "fill-quantity",
        rowIndex,
        operations,
      };
    }

    const priceResult = await fillDetailNumberField(cdp, changeAddConfig.iframeId, {
      fieldId: changeAddConfig.detailFields.taxPrice,
      rowIndex,
      value: row.taxPrice,
    });
    operations.push({
      rowIndex,
      stage: "fill-tax-price",
      result: priceResult,
    });
    if (!priceResult?.ok) {
      return {
        ok: false,
        stage: "fill-tax-price",
        rowIndex,
        operations,
      };
    }

    await sleep(250);
  }

  const readbackRows = await readDetailRows(cdp, changeAddConfig.iframeId, {
    detailTableName: changeAddConfig.detailTableName,
    detailFields: changeAddConfig.detailFields,
  });
  operations.push({
    stage: "detail-readback",
    result: readbackRows,
  });

  return {
    ok: Boolean(readbackRows?.ok),
    operations,
    readbackRows,
  };
}

async function bridgeFillChangeAddDetailMaterials({
  cdp,
  httpSession,
  iframeHref,
  rows,
}) {
  const operations = [];
  const bridgeStateReady = await waitForChangeAddBridgeState({ cdp });
  if (!bridgeStateReady?.ok) {
    return {
      ok: false,
      stage: "read-form-state-before-detail-bridge",
      bridgeStateReady,
      operations,
    };
  }

  let bridgeState = bridgeStateReady.bridgeState;
  let detailRows = Array.isArray(
    bridgeState.mergeData?.[changeAddConfig.detailTableName]
  )
    ? bridgeState.mergeData[changeAddConfig.detailTableName]
    : [];

  for (const row of rows) {
    const currentRow = detailRows[row.rowIndex - 1];
    if (!currentRow?.recordId) {
      return {
        ok: false,
        stage: "detail-row-recordid-missing",
        rowIndex: row.rowIndex,
        currentRow,
        operations,
      };
    }

    const currentMergeData = bridgeState.mergeData;

    const relationResult = await findDetailRelationRow({
      request,
      baseUrl,
      jar: httpSession.jar,
      iframeHref,
      content: bridgeState.content,
      mergeData: currentMergeData,
      relationShipId: changeAddConfig.relationShipIdForInventoryProduct,
      fromRecordId: currentRow.recordId,
      fromRelationAttr: changeAddConfig.detailFields.productCode,
      wantedCode: row.materialNo,
    });

    operations.push({
      rowIndex: row.rowIndex,
      stage: "query-detail-material",
      relationPickFound: Boolean(relationResult?.relationPick?.row),
      rowCount: relationResult?.relationPick?.rows?.length || 0,
    });

    if (!relationResult?.relationPick?.row) {
      return {
        ok: false,
        stage: "query-detail-material",
        rowIndex: row.rowIndex,
        materialNo: row.materialNo,
        relationResult,
        operations,
      };
    }

    const backfillResult = await backfillDetailRelation({
      request,
      baseUrl,
      jar: httpSession.jar,
      iframeHref,
      content: bridgeState.content,
      mergeData: currentMergeData,
      relationShipId: changeAddConfig.relationShipIdForInventoryProduct,
      fromRecordId: currentRow.recordId,
      selectedRow: relationResult.relationPick.row,
    });

    operations.push({
      rowIndex: row.rowIndex,
      stage: "backfill-detail-material",
      ok: Boolean(backfillResult?.json),
    });

    const applyBackfillResult = await applyProjectRelationTableData(
      cdp,
      changeAddConfig.iframeId,
      backfillResult?.json?.data?.data?.tableData || {}
    );
    operations.push({
      rowIndex: row.rowIndex,
      stage: "apply-backfill-to-page",
      result: applyBackfillResult,
    });

    const detailPatch = extractDetailFieldUpdates(
      backfillResult?.json,
      changeAddConfig.detailTableName,
      currentRow.recordId
    );
    if (!detailPatch) {
      return {
        ok: false,
        stage: "extract-detail-material-patch",
        rowIndex: row.rowIndex,
        materialNo: row.materialNo,
        backfillResult,
        operations,
      };
    }

    Object.assign(currentRow, detailPatch);
    currentRow.id = currentRow.recordId || currentRow.id;
    currentRow.recordId = currentRow.recordId || currentRow.id;
    currentRow[changeAddConfig.detailFields.changeType] =
      currentRow[changeAddConfig.detailFields.changeType] || "3386347279108360683";
    currentRow[changeAddConfig.detailFields.addedQuantity] = row.quantity;
    currentRow[changeAddConfig.detailFields.taxPrice] = row.taxPrice;

    applyMainTableUpdate(
      bridgeState.mainData,
      backfillResult?.json,
      bridgeState.mainTableName
    );

    const quantityCalc = await applyCalculateToForm({
      request,
      baseUrl,
      jar: httpSession.jar,
      iframeHref,
      content: bridgeState.content,
      mainTableInfo: bridgeState.mainTableInfo,
      sonTableInfos: bridgeState.sonTableInfos,
      mainData: bridgeState.mainData,
      sonRows: {
        [changeAddConfig.detailTableName]: detailRows,
      },
      detailTableName: changeAddConfig.detailTableName,
      fromRecordId: currentRow.recordId,
      changeFields: [
        `${changeAddConfig.detailFields.addedQuantity}_${currentRow.recordId}`,
      ],
    });
    operations.push({
      rowIndex: row.rowIndex,
      stage: "calc-quantity",
      status: quantityCalc?.result?.response?.status || null,
    });
    await applyProjectRelationTableData(
      cdp,
      changeAddConfig.iframeId,
      quantityCalc?.result?.json?.data?.data?.tableData || {}
    );

    currentRow[changeAddConfig.detailFields.addedQuantity] = row.quantity;
    currentRow[changeAddConfig.detailFields.taxPrice] = row.taxPrice;

    const priceCalc = await applyCalculateToForm({
      request,
      baseUrl,
      jar: httpSession.jar,
      iframeHref,
      content: bridgeState.content,
      mainTableInfo: bridgeState.mainTableInfo,
      sonTableInfos: bridgeState.sonTableInfos,
      mainData: bridgeState.mainData,
      sonRows: {
        [changeAddConfig.detailTableName]: detailRows,
      },
      detailTableName: changeAddConfig.detailTableName,
      fromRecordId: currentRow.recordId,
      changeFields: [
        `${changeAddConfig.detailFields.taxPrice}_${currentRow.recordId}`,
      ],
    });
    operations.push({
      rowIndex: row.rowIndex,
      stage: "calc-price",
      status: priceCalc?.result?.response?.status || null,
    });
    await applyProjectRelationTableData(
      cdp,
      changeAddConfig.iframeId,
      priceCalc?.result?.json?.data?.data?.tableData || {}
    );

    const refreshedFormState = await getPageFormState(cdp, changeAddConfig.iframeId);
    if (refreshedFormState?.ok && refreshedFormState.value) {
      bridgeState = buildMergeDataFromPageState(refreshedFormState.value);
      detailRows = Array.isArray(bridgeState.mergeData?.[changeAddConfig.detailTableName])
        ? bridgeState.mergeData[changeAddConfig.detailTableName]
        : detailRows;
    }
  }

  const materialReadback = await readDetailRows(cdp, changeAddConfig.iframeId, {
    detailTableName: changeAddConfig.detailTableName,
    detailFields: changeAddConfig.detailFields,
  });

  operations.push({
    stage: "detail-material-readback",
    result: materialReadback,
  });

  return {
    ok: Boolean(materialReadback?.ok),
    operations,
    materialReadback,
  };
}

async function runChangeAddPageAutomation({
  input,
  runRoot,
  skipPreSaveReadback = false,
  saveDraft = false,
} = {}) {
  const mapped = mapChangeAddRequest(input);
  const executionPlan = buildChangeAddExecutionPlan(input);
  const sessionBundle = await openChangeAddSession({ runRoot });
  const { session, httpSession, flowOpenResult } = sessionBundle;

  try {
    const projectSelection = await applyProjectRelationByCode({
      cdp: session.cdp,
      httpSession,
      iframeHref: flowOpenResult.iframeInfo.href,
      projectCodeOrQuotationNo: mapped.baseInfo.projectCodeOrQuotationNo,
    });
    if (!projectSelection?.ok) {
      return {
        ok: false,
        stage: "project-selection",
        executionPlan,
        projectSelection,
      };
    }

    const mainFieldFill = await fillChangeAddMainFields({
      cdp: session.cdp,
      baseInfo: mapped.baseInfo,
    });
    if (!mainFieldFill?.ok) {
      return {
        ok: false,
        stage: "fill-main-fields",
        executionPlan,
        projectSelection,
        mainFieldFill,
      };
    }

    const capacity = await ensureChangeAddDetailCapacity({
      cdp: session.cdp,
      httpSession,
      iframeHref: flowOpenResult.iframeInfo.href,
      rows: executionPlan.detailPlan.rows,
    });
    if (!capacity?.ok) {
      return {
        ok: false,
        stage: "ensure-detail-capacity",
        executionPlan,
        projectSelection,
        mainFieldFill,
        capacity,
      };
    }

    const detailMaterialBridge = await bridgeFillChangeAddDetailMaterials({
      cdp: session.cdp,
      httpSession,
      iframeHref: flowOpenResult.iframeInfo.href,
      rows: executionPlan.detailPlan.rows,
    });
    if (!detailMaterialBridge?.ok) {
      return {
        ok: false,
        stage: "bridge-detail-materials",
        executionPlan,
        projectSelection,
        mainFieldFill,
        capacity,
        detailMaterialBridge,
      };
    }

    const detailFill = await fillChangeAddDetailRows({
      cdp: session.cdp,
      rows: executionPlan.detailPlan.rows,
    });
    if (!detailFill?.ok) {
      return {
        ok: false,
        stage: "fill-detail-rows",
        executionPlan,
        projectSelection,
        mainFieldFill,
        capacity,
        detailMaterialBridge,
        detailFill,
      };
    }

    const preSaveCheck = skipPreSaveReadback
      ? {
          ok: true,
          skipped: true,
          reason: "temporarily-disabled-for-mouse-save-draft-path",
        }
      : await runChangeAddPageReadbackPass({
          cdp: session.cdp,
          input,
        });

    if (!preSaveCheck?.ok) {
      return {
        ok: false,
        stage: "pre-save-check-failed",
        executionPlan,
        projectSelection,
        mainFieldFill,
        capacity,
        detailMaterialBridge,
        detailFill,
        preSaveCheck,
      };
    }

    const saveDraftResult = saveDraft
      ? await saveDraftByMouse(session.cdp)
      : null;
    if (saveDraft && !saveDraftResult?.ok) {
      return {
        ok: false,
        stage: "save-draft",
        executionPlan,
        projectSelection,
        mainFieldFill,
        capacity,
        detailMaterialBridge,
        detailFill,
        preSaveCheck,
        saveDraftResult,
      };
    }

    return {
      ok: true,
      stage: saveDraft
        ? "save-draft-completed"
        : skipPreSaveReadback
          ? "page-fill-completed-readback-skipped"
          : "pre-save-check-passed",
      executionPlan,
      projectSelection,
      mainFieldFill,
      capacity,
      detailMaterialBridge,
      detailFill,
      preSaveCheck,
      saveDraftResult,
    };
  } finally {
    await closeBrowserSession(sessionBundle.session);
  }
}

async function runChangeAddPageReadbackPass({ cdp, input }) {
  const mapped = mapChangeAddRequest(input);
  const readbackResult = await readChangeAddPageForVerification({ cdp });
  if (!readbackResult?.ok) {
    return {
      ok: false,
      stage: "readback",
      readbackResult,
    };
  }

  const precheck = verifyChangeAddReadback(mapped.compareTarget, readbackResult.readback);
  return {
    ok: precheck.ok,
    readback: readbackResult.readback,
    precheck,
  };
}

module.exports = {
  openChangeAddSession,
  waitForChangeAddBridgeState,
  applyProjectRelationByCode,
  runChangeAddSaveDraft,
  buildChangeAddExecutionPlan,
  verifyChangeAddBeforeSave,
  readChangeAddPageForVerification,
  fillChangeAddMainFields,
  ensureChangeAddDetailCapacity,
  bridgeFillChangeAddDetailMaterials,
  fillChangeAddDetailRows,
  runChangeAddPageReadbackPass,
  runChangeAddPageAutomation,
  closeBrowserSession,
};
