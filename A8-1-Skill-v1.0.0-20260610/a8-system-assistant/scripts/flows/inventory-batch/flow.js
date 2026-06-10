"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");

const {
  launchEdge,
  connectToFirstPageTarget,
  closeBrowserSession,
  sleep,
} = require("../../core/browser");
const {
  baseUrl,
  loginWithHttp,
  loginWithBrowserForm,
  injectCookiesToCdp,
} = require("../../core/session");
const { openFlowPage } = require("../../core/navigation");
const { evaluateInIframe, getIframeHtmlSnapshot } = require("../../core/frame");
const { saveDraftByMouse } = require("../../core/save-draft");
const { waitForIframeReady } = require("../../core/wait");
const {
  getPageFormState,
  readVisibleFieldValues,
} = require("../../core/page-form");
const { ensureDir, writeJson, writeText } = require("../../core/artifacts");
const config = require("./config");
const {
  buildInventoryBatchExecutionPlan,
  buildBatchFieldMapping,
  buildMinimalSaveDraftSample,
  buildInventoryBatchSaveDraftInput,
  normalizeItems,
} = require("./mapper");
const {
  compareInventoryBatchSubmitData,
  summarizeObservationRisks,
  validateInventoryBatchSaveDraftInput,
  validateMinimalSaveDraftSample,
} = require("./rules");

function compactFieldObservation(domField = {}) {
  return {
    fieldId: domField.fieldId,
    label: domField.label || "",
    key: domField.key || "",
    controlType: domField.controlType || "unknown",
    found: Boolean(domField.found),
    text: domField.text || "",
    childClasses: domField.childClasses || [],
    inputs: domField.inputs || [],
  };
}

function summarizeFormState(formState = {}) {
  if (!formState?.ok) {
    return {
      ok: false,
      error: formState?.error || formState?.message || "form-state-unavailable",
    };
  }
  const value = formState.value || {};
  const tableInfo = value.tableInfo || {};
  const formmains = value.formmains || {};
  const formsons = value.formsons || {};
  const compactTableInfo = {};
  for (const [tableName, table] of Object.entries(tableInfo)) {
    const fieldInfo = table?.fieldInfo || table?.fields || {};
    compactTableInfo[tableName] = {
      tableName,
      fieldCount: Object.keys(fieldInfo).length,
      fields: Object.fromEntries(
        Object.entries(fieldInfo)
          .filter(([fieldId]) => {
            return (
              fieldId === config.fields.businessDepartment ||
              Object.values(config.detailFields).includes(fieldId) ||
              /^field0/.test(fieldId)
            );
          })
          .slice(0, 80)
          .map(([fieldId, field]) => [
            fieldId,
            {
              display: field?.display || field?.name || field?.label || "",
              inputType: field?.inputType || field?.type || "",
              auth: field?.auth || "",
            },
          ])
      ),
    };
  }

  return {
    ok: true,
    mainTables: Object.keys(formmains),
    detailTables: Object.keys(formsons),
    tableInfoNames: Object.keys(tableInfo),
    compactTableInfo,
    mainKnownControls: formmains[config.mainTableName] || null,
    detailRowCount:
      Array.isArray(formsons[config.detailTableName])
        ? formsons[config.detailTableName].length
        : Object.keys(formsons[config.detailTableName] || {}).length,
  };
}

async function openInventoryBatchObservationSession({ runRoot }) {
  const stagePath = path.join(runRoot, "inventory-batch-open-stage.json");
  const stageLogPath = path.join(runRoot, "inventory-batch-open-stage.jsonl");
  const writeStage = async (payload) => {
    const record = {
      ...payload,
      at: new Date().toISOString(),
    };
    await fs
      .appendFile(stageLogPath, `${JSON.stringify(record)}\n`, "utf8")
      .catch(() => {});
    await writeJson(stagePath, record).catch(() => {});
  };

  let edge = null;
  let session = null;
  try {
    await writeStage({ stage: "login-start" });
    let httpSession = null;
    try {
      httpSession = await loginWithHttp({
        scriptDir: path.resolve(__dirname, "..", "..", "legacy"),
      });
      await writeStage({ stage: "login-http-ok" });
    } catch (error) {
      await writeStage({
        stage: "login-http-failed",
        error: String(error),
        fallback: "browser-form",
      });
      if (/^(0|false|no)$/i.test(String(process.env.A8_BROWSER_FORM_LOGIN_FALLBACK || "").trim())) {
        throw error;
      }
      httpSession = await loginWithBrowserForm({
        runRoot,
        profileDir: path.join(runRoot, "browser-login-profile"),
        headless: true,
        onStage: writeStage,
      });
      await writeStage({
        stage: "login-browser-form-ok",
        artifactsDir: httpSession.artifactsDir,
      });
    }

    const profileDir = path.join(runRoot, "chrome-profile");
    await writeStage({ stage: "browser-launch-start", profileDir });
    edge = await launchEdge({
      profileDir,
      startUrl: "about:blank",
      headless: true,
    });
    await writeStage({ stage: "browser-launched", port: edge.port });

    const browserSession = await connectToFirstPageTarget(edge.port);
    session = {
      edge,
      ...browserSession,
    };

    await writeStage({ stage: "inject-cookies-start" });
    await injectCookiesToCdp(session.cdp, httpSession.cookies, httpSession.baseUrl || baseUrl);
    await writeStage({ stage: "open-flow-start", targetUrl: config.targetUrl });
    const flowOpenResult = await openFlowPage(session.cdp, config, {
      onStage: writeStage,
    });

    return {
      session,
      httpSession,
      flowOpenResult,
    };
  } catch (error) {
    await writeStage({
      stage: "open-session-error",
      error: String(error),
    });
    if (session) {
      await closeBrowserSession(session);
    } else if (edge) {
      await closeBrowserSession({ edge });
    }
    throw error;
  }
}

async function observeInventoryBatchDom(cdp) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = iframeWindow.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const mainFields = ${JSON.stringify(config.fields)};
      const detailFields = ${JSON.stringify(config.detailFields)};
      const allFields = { ...mainFields, ...detailFields };
      const keyByField = Object.fromEntries(Object.entries(allFields).map(([key, fieldId]) => [fieldId, key]));
      const labels = { ...${JSON.stringify(config.fieldLabels)}, ...${JSON.stringify(config.detailFieldLabels)} };

      const observeField = ([key, fieldId]) => {
        const host = iframeDocument.getElementById(fieldId + "_id") || iframeDocument.getElementById(fieldId);
        if (!host) {
          return { key, fieldId, found: false, label: labels[key] || "", text: "", childClasses: [], inputs: [] };
        }
        return {
          key,
          fieldId,
          found: true,
          label: labels[key] || "",
          text: clean(host.innerText || host.textContent),
          childClasses: Array.from(new Set(Array.from(host.querySelectorAll("[class]"))
            .map((node) => String(node.getAttribute("class") || ""))
            .filter((className) => /cap4|formson|field|select|text|number|input/i.test(className))))
            .slice(0, 16),
          inputs: Array.from(host.querySelectorAll("input, textarea, select")).map((node) => ({
            tag: node.tagName,
            id: node.id || "",
            name: node.name || "",
            type: node.getAttribute("type") || "",
            className: node.getAttribute("class") || "",
            value: String(node.value || "").trim(),
            readonly: Boolean(node.readOnly || node.getAttribute("readonly") !== null),
            disabled: Boolean(node.disabled || node.getAttribute("disabled") !== null),
            visible: visible(node),
          })),
        };
      };

      const findFormsonVm = () => {
        const tableName = ${JSON.stringify(config.detailTableName)};
        const tableSection =
          iframeDocument.querySelector("section." + tableName) ||
          iframeDocument.querySelector("." + tableName) ||
          iframeDocument.getElementById(tableName);
        let current = tableSection;
        let depth = 0;
        while (current && depth < 16) {
          const vm = current.__vue__;
          if (vm && vm.$options && vm.$options.name === "formson" && vm.listTable) return vm;
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };

      const formsonVm = findFormsonVm();
      const vmRows = Array.isArray(formsonVm?.listTable?.records)
        ? formsonVm.listTable.records.map((row, index) => ({
            index,
            recordId: String(row?.recordId || ""),
            fieldValues: Object.fromEntries(Object.entries(detailFields).map(([key, fieldId]) => {
              const cell = row?.lists?.[fieldId] || row?.[fieldId] || {};
              return [key, {
                fieldId,
                value: cell?.value ?? cell?.showValue ?? cell?.display ?? "",
                showValue: cell?.showValue ?? "",
                auth: cell?.auth ?? "",
              }];
            }))
          })).slice(0, 20)
        : [];

      const detailRows = Array.from(iframeDocument.querySelectorAll(
        "." + ${JSON.stringify(config.detailTableName)} + " tr, section." + ${JSON.stringify(config.detailTableName)} + " tr, tr.formson-line"
      ))
        .filter(visible)
        .map((node, index) => ({
          index,
          id: node.id || "",
          className: String(node.getAttribute("class") || ""),
          text: clean(node.innerText || node.textContent).slice(0, 800),
          inputs: Array.from(node.querySelectorAll("input, textarea, select")).map((input) => ({
            id: input.id || "",
            name: input.name || "",
            value: String(input.value || "").trim(),
            readonly: Boolean(input.readOnly || input.getAttribute("readonly") !== null),
            visible: visible(input),
          })).slice(0, 40),
        }))
        .slice(0, 30);

      const toolbarLabels = ${JSON.stringify(config.toolbarLabels)};
      const toolbarButtons = Array.from(iframeDocument.querySelectorAll("button, a, span, div, li"))
        .map((node, index) => {
          const text = clean(node.innerText || node.textContent || node.getAttribute("title") || node.getAttribute("name") || "");
          if (!text || !toolbarLabels.some((label) => text === label || text.includes(label))) return null;
          return {
            index,
            tag: node.tagName,
            id: node.id || "",
            className: String(node.getAttribute("class") || ""),
            title: node.getAttribute("title") || "",
            name: node.getAttribute("name") || "",
            text,
            visible: visible(node),
            onclick: node.getAttribute("onclick") || "",
          };
        })
        .filter(Boolean)
        .slice(0, 80);

      const allCapFields = Array.from(iframeDocument.querySelectorAll(".cap-field[id$='_id'], [id^='field'][id$='_id']"))
        .map((node) => {
          const fieldId = String(node.id || "").replace(/_id$/, "");
          return {
            fieldId,
            key: keyByField[fieldId] || "",
            text: clean(node.innerText || node.textContent).slice(0, 500),
            className: String(node.getAttribute("class") || ""),
            visible: visible(node),
          };
        })
        .filter((item) => item.visible)
        .slice(0, 160);

      return {
        ok: true,
        href: iframeWindow.location.href,
        title: iframeDocument.title,
        bodyText: clean(iframeDocument.body ? iframeDocument.body.innerText : "").slice(0, 5000),
        mainFields: Object.entries(mainFields).map(observeField),
        detailFields: Object.entries(detailFields).map(observeField),
        detailTable: {
          tableName: ${JSON.stringify(config.detailTableName)},
          vmFound: Boolean(formsonVm),
          vmTableName: formsonVm?.listTable?.tableName || "",
          vmRowCount: vmRows.length,
          vmRows,
          domRows: detailRows,
        },
        toolbarButtons,
        allCapFields,
      };
    }`
  );
}

async function snapshotTopPage(cdp, label = "") {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const dialogs = Array.from(document.querySelectorAll(".layui-layer, .layui-layer-content, .layui-layer-title, [role='dialog']"))
        .map((node, index) => ({
          index,
          tag: node.tagName,
          id: node.id || "",
          className: String(node.getAttribute("class") || ""),
          text: clean(node.innerText || node.textContent).slice(0, 1600),
          visible: visible(node),
        }))
        .filter((item) => item.visible || item.text)
        .slice(0, 40);
      const iframes = Array.from(document.querySelectorAll("iframe")).map((frame, index) => ({
        index,
        id: frame.id || "",
        name: frame.name || "",
        src: frame.src || frame.getAttribute("src") || "",
        visible: visible(frame),
      }));
      return {
        ok: true,
        label: ${JSON.stringify(label)},
        title: document.title,
        url: location.href,
        dialogs,
        iframes,
        bodyText: clean(document.body ? document.body.innerText : "").slice(0, 3000),
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, label, error: "top-snapshot-empty" };
}

async function clickToolbarByText(cdp, label) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const label = ${JSON.stringify(label)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = iframeWindow.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const fireClick = (element) => {
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: iframeWindow }));
        if (typeof element.click === "function") element.click();
      };
      const candidates = Array.from(iframeDocument.querySelectorAll("button, a, span, div, li"))
        .map((node, index) => ({ node, index, text: clean(node.innerText || node.textContent || node.title || node.getAttribute("name") || "") }))
        .filter((item) => item.text === label || item.text.includes(label))
        .filter((item) => visible(item.node));
      const target = candidates[0];
      if (!target) return { ok: false, label, error: "toolbar-button-not-found" };
      fireClick(target.node);
      return {
        ok: true,
        label,
        index: target.index,
        tag: target.node.tagName,
        id: target.node.id || "",
        className: String(target.node.getAttribute("class") || ""),
        text: target.text,
      };
    }`
  );
}

async function closeTopDialogs(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const fireClick = (element) => {
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        if (typeof element.click === "function") element.click();
      };
      const clicked = [];
      for (const node of Array.from(document.querySelectorAll(".layui-layer-close, a[title='关闭'], button, a, span"))) {
        const text = clean(node.innerText || node.textContent || node.title || "");
        const className = String(node.getAttribute("class") || "");
        if (!visible(node)) continue;
        if (className.includes("layui-layer-close") || text === "关闭" || text === "取消") {
          fireClick(node);
          clicked.push({ text, className, id: node.id || "" });
          if (clicked.length >= 3) break;
        }
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      return { ok: true, clicked };
    })()`,
    returnByValue: true,
  });
  await sleep(500);
  return result.result?.value || { ok: false, error: "close-dialogs-empty" };
}

async function observeImportExportMechanism(cdp, { enabled, runRoot }) {
  const networkEvents = [];
  cdp.on("Network.requestWillBeSent", (params) => {
    const url = params?.request?.url || "";
    if (!/a8\.uni-ubi\.com|\/seeyon\//i.test(url)) return;
    networkEvents.push({
      type: "request",
      url,
      method: params.request?.method || "",
      postData: params.request?.postData ? "[present]" : "",
    });
  });
  cdp.on("Network.responseReceived", (params) => {
    const url = params?.response?.url || "";
    if (!/a8\.uni-ubi\.com|\/seeyon\//i.test(url)) return;
    networkEvents.push({
      type: "response",
      url,
      status: params.response?.status || 0,
      mimeType: params.response?.mimeType || "",
    });
  });

  const downloadsDir = path.join(runRoot, "downloads");
  await ensureDir(downloadsDir);
  await cdp
    .send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadsDir,
    })
    .catch(() => {});

  const initialSnapshot = await snapshotTopPage(cdp, "before-import-export-probe");
  if (!enabled) {
    return {
      enabled: false,
      initialSnapshot,
      probes: [],
      networkEvents,
      downloadsDir,
    };
  }

  const probes = [];
  for (const label of config.importExportLabels) {
    const beforeCount = networkEvents.length;
    const click = await clickToolbarByText(cdp, label);
    await sleep(1800);
    const afterSnapshot = await snapshotTopPage(cdp, `after-${label}`);
    const closeResult = await closeTopDialogs(cdp);
    probes.push({
      label,
      click,
      afterSnapshot,
      closeResult,
      networkEvents: networkEvents.slice(beforeCount),
    });
  }

  return {
    enabled: true,
    initialSnapshot,
    probes,
    networkEvents,
    downloadsDir,
  };
}

async function runInventoryBatchObservation({ input = {}, runRoot }) {
  const executionPlan = buildInventoryBatchExecutionPlan(input);
  const normalizedItems = normalizeItems(input.items || []);
  const sample = buildMinimalSaveDraftSample();
  const sampleValidation = validateMinimalSaveDraftSample(sample.input);

  let opened = null;
  try {
    opened = await openInventoryBatchObservationSession({ runRoot });
    const { session, flowOpenResult } = opened;
    const cdp = session.cdp;
    const fieldIds = [
      ...Object.values(config.fields),
      ...Object.values(config.detailFields),
    ];

    const [formState, visibleFields, domObservation, htmlSnapshot] = await Promise.all([
      getPageFormState(cdp, config.iframeId),
      readVisibleFieldValues(cdp, config.iframeId, fieldIds),
      observeInventoryBatchDom(cdp),
      getIframeHtmlSnapshot(cdp, config.iframeId),
    ]);

    const formStateSummary = summarizeFormState(formState);
    await writeJson(path.join(runRoot, "inventory-batch-form-state-summary.json"), formStateSummary);
    await writeJson(path.join(runRoot, "inventory-batch-dom-observation.json"), domObservation);
    if (htmlSnapshot?.html) {
      await writeText(path.join(runRoot, "inventory-batch-iframe.html"), htmlSnapshot.html);
    }

    const importExport = await observeImportExportMechanism(cdp, {
      enabled: executionPlan.probeImportExport,
      runRoot,
    });
    await writeJson(path.join(runRoot, "inventory-batch-import-export.json"), importExport);

    const toolbarLabels = new Set((domObservation?.toolbarButtons || []).map((button) => button.text));
    const importExportButtonsFound = config.importExportLabels.every((label) =>
      [...toolbarLabels].some((text) => text === label || text.includes(label))
    );
    const importExportProbeSignals = (importExport.probes || []).map((probe) => ({
      label: probe.label,
      clicked: Boolean(probe.click?.ok),
      dialogText: (probe.afterSnapshot?.dialogs || []).map((dialog) => dialog.text).join(" ").slice(0, 1200),
      networkCount: (probe.networkEvents || []).length,
    }));

    const fastModeAssessment = {
      canUseBatchImport:
        importExportButtonsFound &&
        importExportProbeSignals.some((signal) => signal.label === "导入数据" && signal.clicked),
      confidence: "low",
      reason:
        "Only the presence/clickability of import/export can be observed in this stage. A real fast-mode decision still needs exported template shape and a no-save import dry-run/readback.",
      requiredNextSignals: [
        "导出数据 produces a stable Excel/template file or endpoint payload.",
        "导入数据 accepts that template without immediately saving/submitting.",
        "After import, thirdPartyFormAPI.getFormData() contains expected formson_0507 rows.",
      ],
      importExportButtonsFound,
      importExportProbeSignals,
    };

    return {
      ok: true,
      stage: "observation-only",
      flow: config.flowName,
      businessName: config.businessName,
      executionPlan,
      templateId: config.templateId,
      targetUrl: config.targetUrl,
      iframeInfo: flowOpenResult?.iframeInfo || null,
      mainTableName: config.mainTableName,
      detailTableName: config.detailTableName,
      observedDraft: config.observedDraft,
      fieldMapping: buildBatchFieldMapping(),
      normalizedItems,
      visibleFields,
      domObservation: {
        ok: Boolean(domObservation?.ok),
        href: domObservation?.href || "",
        title: domObservation?.title || "",
        mainFields: (domObservation?.mainFields || []).map(compactFieldObservation),
        detailFields: (domObservation?.detailFields || []).map(compactFieldObservation),
        detailTable: domObservation?.detailTable || null,
        toolbarButtons: domObservation?.toolbarButtons || [],
      },
      formStateSummary,
      importExport,
      fastModeAssessment,
      minimalSaveDraftSample: sample,
      sampleValidation,
      risks: summarizeObservationRisks(),
      saveDraftTouched: false,
    };
  } finally {
    if (opened?.session) {
      await closeBrowserSession(opened.session);
    }
  }
}

async function countInventoryBatchRows(cdp) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(config.detailTableName)};
      const findFormsonVm = () => {
        const tableSection =
          iframeDocument.querySelector("section." + tableName) ||
          iframeDocument.querySelector("." + tableName) ||
          iframeDocument.getElementById(tableName);
        let current = tableSection;
        let depth = 0;
        while (current && depth < 16) {
          const vm = current.__vue__;
          if (vm && vm.$options && vm.$options.name === "formson" && vm.listTable) return vm;
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const formsonVm = findFormsonVm();
      const vmRows = Array.isArray(formsonVm?.listTable?.records)
        ? formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim())
        : [];
      return {
        ok: true,
        tableName,
        vmFound: Boolean(formsonVm),
        rowCount: vmRows.length,
        recordIds: vmRows.map((row) => String(row.recordId || "").trim()).filter(Boolean),
      };
    }`
  );
}

async function probeInventoryBatchRenderState(cdp) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(config.detailTableName)};
      const businessFieldId = ${JSON.stringify(config.fields.businessDepartment)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const tableSection =
        iframeDocument.querySelector("section." + tableName) ||
        iframeDocument.querySelector("." + tableName) ||
        iframeDocument.getElementById(tableName);
      let formsonVm = null;
      let current = tableSection;
      let depth = 0;
      while (current && depth < 16) {
        const vm = current.__vue__;
        if (vm && vm.$options && vm.$options.name === "formson" && vm.listTable) {
          formsonVm = vm;
          break;
        }
        current = current.parentElement;
        depth += 1;
      }
      const rows = Array.isArray(formsonVm?.listTable?.records)
        ? formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim())
        : [];
      const businessHost = iframeDocument.getElementById(businessFieldId + "_id");
      const toolbarTexts = tableSection
        ? Array.from((tableSection.closest("section.formson") || tableSection.parentElement || tableSection)
            .querySelectorAll("button, a, span, div"))
            .map((node) => clean(node.innerText || node.textContent))
            .filter(Boolean)
            .slice(0, 40)
        : [];
      return {
        ok: true,
        href: iframeWindow.location.href,
        title: iframeDocument.title,
        bodyReady: clean(iframeDocument.body ? iframeDocument.body.innerText : "").length > 0,
        businessHostFound: Boolean(businessHost),
        detailTableFound: Boolean(tableSection),
        formsonVmFound: Boolean(formsonVm),
        rowCount: rows.length,
        toolbarTexts,
      };
    }`
  );
}

async function writeInventoryBatchSaveStage(runRoot, payload) {
  const record = {
    ...payload,
    at: new Date().toISOString(),
  };
  await fs
    .appendFile(
      path.join(runRoot, "inventory-batch-save-stage.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf8"
    )
    .catch(() => {});
  await writeJson(path.join(runRoot, "inventory-batch-save-stage.json"), record).catch(() => {});
}

async function captureInventoryBatchDebugStep(cdp, runRoot, label, extra = {}) {
  if (!cdp || !runRoot) return { ok: false, error: "missing-cdp-or-run-root", label };
  const safeLabel = String(label || "step")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "step";
  const screenshotsDir = path.join(runRoot, "screenshots");
  const htmlDir = path.join(runRoot, "html");
  const record = {
    ok: true,
    label: safeLabel,
    at: new Date().toISOString(),
    extra,
    screenshotPath: "",
    iframeHtmlPath: "",
    errors: [],
  };

  await ensureDir(screenshotsDir).catch(() => {});
  await ensureDir(htmlDir).catch(() => {});

  try {
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
    });
    if (screenshot?.data) {
      record.screenshotPath = path.join(screenshotsDir, `${safeLabel}.png`);
      await fs.writeFile(record.screenshotPath, Buffer.from(screenshot.data, "base64"));
    }
  } catch (error) {
    record.ok = false;
    record.errors.push(`screenshot: ${String(error)}`);
  }

  try {
    const htmlSnapshot = await getIframeHtmlSnapshot(cdp, config.iframeId);
    if (htmlSnapshot?.html) {
      record.iframeHtmlPath = path.join(htmlDir, `${safeLabel}.html`);
      await writeText(record.iframeHtmlPath, htmlSnapshot.html);
    }
  } catch (error) {
    record.errors.push(`iframe-html: ${String(error)}`);
  }

  await fs
    .appendFile(
      path.join(runRoot, "inventory-batch-debug-screenshots.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf8"
    )
    .catch(() => {});
  return record;
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);
}

async function waitForInventoryBatchRendered(cdp, {
  timeoutMs = 45000,
  intervalMs = 800,
} = {}) {
  const startedAt = Date.now();
  const attempts = [];
  while (Date.now() - startedAt < timeoutMs) {
    const count = await withTimeout(
      countInventoryBatchRows(cdp).catch((error) => ({
        ok: false,
        error: String(error),
      })),
      5000,
      { ok: false, error: "count-inventory-rows-timeout" }
    );
    const probe = await withTimeout(
      probeInventoryBatchRenderState(cdp).catch((error) => ({
        ok: false,
        error: String(error),
      })),
      5000,
      { ok: false, error: "probe-inventory-render-timeout" }
    );
    const ready = Boolean(
      (count?.vmFound || probe?.formsonVmFound) &&
      probe?.businessHostFound &&
      probe?.detailTableFound &&
      probe?.bodyReady
    );
    attempts.push({
      atMs: Date.now() - startedAt,
      count: {
        ok: Boolean(count?.ok),
        vmFound: Boolean(count?.vmFound),
        rowCount: count?.rowCount ?? 0,
        error: count?.error || "",
      },
      probe: {
        ok: Boolean(probe?.ok),
        formsonVmFound: Boolean(probe?.formsonVmFound),
        businessHostFound: Boolean(probe?.businessHostFound),
        detailTableFound: Boolean(probe?.detailTableFound),
        bodyReady: Boolean(probe?.bodyReady),
        rowCount: probe?.rowCount ?? 0,
        error: probe?.error || "",
      },
    });
    if (ready) {
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        count,
        probe,
        attempts,
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    attempts,
  };
}

async function clickInventoryBatchNewRow(cdp) {
  const iframeRectResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const iframeId = ${JSON.stringify(config.iframeId)};
      const iframe = document.getElementById(iframeId);
      if (!iframe) return { ok: false, error: "iframe-not-found", iframeId };
      const rect = iframe.getBoundingClientRect();
      return {
        ok: true,
        iframeId,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    })()`,
    returnByValue: true,
  });
  const iframeRect = iframeRectResult.result?.value || {};
  if (!iframeRect?.ok) return iframeRect;

  const buttonRect = await evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(config.detailTableName)};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const wantedLabels = ["新建", "新建一行"];
      const tableSection =
        iframeDocument.querySelector("section." + tableName) ||
        iframeDocument.querySelector("." + tableName) ||
        iframeDocument.getElementById(tableName);
      if (!tableSection) {
        return { ok: false, error: "detail-table-section-not-found", tableName };
      }
      const formsonRoot =
        tableSection.closest("section.formson") ||
        tableSection.closest(".formson") ||
        tableSection.parentElement;
      const toolbarRoot =
        formsonRoot?.querySelector(".formson-toolbar-container") ||
        formsonRoot?.querySelector(".toolbarButton-content") ||
        formsonRoot;
      const candidates = Array.from(toolbarRoot.querySelectorAll(
        ".formson-list__button, .cap-btn, button, a"
      ));
      const target = candidates.find((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        return wantedLabels.includes(text);
      });
      if (!target) {
        return {
          ok: false,
          error: "detail-new-button-not-found",
          tableName,
          candidateCount: candidates.length,
          candidateTexts: candidates
            .map((element) => normalize(element.innerText || element.textContent || ""))
            .filter(Boolean)
            .slice(0, 20),
        };
      }
      const clickable =
        target.closest(".formson-list__button") ||
        target.closest(".cap-btn") ||
        target.closest("button") ||
        target.closest("a") ||
        target;
      clickable.scrollIntoView({ block: "center", inline: "center" });
      const rect = clickable.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return { ok: false, error: "detail-new-button-has-empty-rect", tableName };
      }
      return {
        ok: true,
        tableName,
        tagName: String(clickable.tagName || "").toLowerCase(),
        id: clickable.id || "",
        className: String(clickable.getAttribute("class") || ""),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }`
  );
  if (!buttonRect?.ok) return buttonRect;
  const point = {
    ...buttonRect,
    x: iframeRect.left + buttonRect.left + buttonRect.width / 2,
    y: iframeRect.top + buttonRect.top + buttonRect.height / 2,
  };
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  return {
    ...point,
    strategy: "cdp-real-mouse",
  };
}

async function ensureInventoryBatchRowsByNativeNewRow(cdp, wantedRowCount, {
  intervalMs = 800,
} = {}) {
  const steps = [];
  let count = await withTimeout(
    countInventoryBatchRows(cdp).catch((error) => ({
      ok: false,
      error: String(error),
    })),
    5000,
    { ok: false, error: "count-before-native-new-row-timeout" }
  );
  if (!count?.ok) {
    return {
      ok: false,
      error: count?.error || "count-before-native-new-row-failed",
      wantedRowCount,
      currentRowCount: count?.rowCount ?? 0,
      steps,
    };
  }
  if (count.rowCount > wantedRowCount) {
    return {
      ok: false,
      error: "unexpected-extra-detail-rows",
      wantedRowCount,
      currentRowCount: count.rowCount,
      steps,
    };
  }

  while (count.rowCount < wantedRowCount) {
    const beforeRowCount = count.rowCount;
    const click = await withTimeout(
      clickInventoryBatchNewRow(cdp).catch((error) => ({
        ok: false,
        error: String(error),
      })),
      10000,
      { ok: false, error: "native-new-row-click-timeout" }
    );
    await sleep(intervalMs);
    count = await withTimeout(
      countInventoryBatchRows(cdp).catch((error) => ({
        ok: false,
        error: String(error),
      })),
      5000,
      { ok: false, error: "count-after-native-new-row-timeout" }
    );
    steps.push({
      action: "native-new-row",
      beforeRowCount,
      click,
      afterRowCount: count?.rowCount ?? 0,
      count,
    });
    if (!click?.ok) {
      return {
        ok: false,
        error: click?.error || "native-new-row-click-failed",
        wantedRowCount,
        currentRowCount: count?.rowCount ?? beforeRowCount,
        steps,
      };
    }
    if (!count?.ok || count.rowCount <= beforeRowCount) {
      return {
        ok: false,
        error: count?.error || "native-new-row-did-not-increase-row-count",
        wantedRowCount,
        currentRowCount: count?.rowCount ?? beforeRowCount,
        steps,
      };
    }
  }

  return {
    ok: count.rowCount === wantedRowCount,
    error: count.rowCount === wantedRowCount ? "" : "native-new-row-count-mismatch",
    wantedRowCount,
    currentRowCount: count.rowCount,
    recordIds: count.recordIds || [],
    steps,
  };
}

async function ensureInventoryBatchRowsByVueClone(cdp, wantedRowCount) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(config.detailTableName)};
      const findFormsonVm = () => {
        const tableSection =
          iframeDocument.querySelector("section." + tableName) ||
          iframeDocument.querySelector("." + tableName) ||
          iframeDocument.getElementById(tableName);
        let current = tableSection;
        let depth = 0;
        while (current && depth < 16) {
          const vm = current.__vue__;
          if (vm && vm.$options && vm.$options.name === "formson" && vm.listTable) return vm;
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const formsonVm = findFormsonVm();
      if (!formsonVm || !Array.isArray(formsonVm.listTable?.records)) {
        return { ok: false, error: "formson-vm-not-found", tableName };
      }
      const records = formsonVm.listTable.records;
      let rows = records.filter((row) => String(row?.recordId || "").trim());
      const beforeRowCount = rows.length;
      if (beforeRowCount > ${JSON.stringify(wantedRowCount)}) {
        return {
          ok: false,
          error: "unexpected-extra-detail-rows",
          tableName,
          wantedRowCount: ${JSON.stringify(wantedRowCount)},
          beforeRowCount,
        };
      }
      if (beforeRowCount === 0) {
        return {
          ok: false,
          error: "no-template-row-to-clone",
          tableName,
          wantedRowCount: ${JSON.stringify(wantedRowCount)},
        };
      }
      const cloneObject = (value) => JSON.parse(JSON.stringify(value));
      const rewriteBindingText = (text, context) => {
        if (typeof text !== "string") return text;
        let next = text;
        if (context.oldRecordId) {
          next = next.split(String(context.oldRecordId)).join(String(context.newRecordId));
        }
        next = next.replace(/records__\\d+__/g, "records__" + context.newIndex + "__");
        next = next.replace(/recordId=[^&\\s]+/g, "recordId=" + context.newRecordId);
        return next;
      };
      const rewriteBindingsDeep = (value, context, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 6) return;
        for (const [key, current] of Object.entries(value)) {
          if (typeof current === "string") {
            value[key] = rewriteBindingText(current, context);
          } else if (current && typeof current === "object") {
            rewriteBindingsDeep(current, context, depth + 1);
          }
        }
      };
      const resetField = (field, newRecordId, context) => {
        if (!field || typeof field !== "object") return field;
        rewriteBindingsDeep(field, context);
        if ("recordId" in field) field.recordId = newRecordId;
        if ("value" in field) field.value = "";
        if ("showValue" in field) field.showValue = "";
        if ("display" in field) field.display = "";
        if ("displayValue" in field) field.displayValue = "";
        if ("value2" in field) field.value2 = "";
        if ("showValue2" in field) field.showValue2 = "";
        return field;
      };
      const created = [];
      while (rows.length < ${JSON.stringify(wantedRowCount)}) {
        const template = rows[0];
        const clone = cloneObject(template);
        const newRecordId = "-" + String(Date.now()) + String(Math.floor(Math.random() * 1000000)) + String(rows.length + 1);
        const context = {
          oldRecordId: String(template.recordId || ""),
          newRecordId,
          newIndex: rows.length,
        };
        rewriteBindingsDeep(clone, context);
        clone.recordId = newRecordId;
        clone.ordinal = rows.length;
        clone.sort = rows.length;
        clone.rowIndex = rows.length;
        clone.isNew = true;
        clone.isInsert = true;
        if (clone.lists && typeof clone.lists === "object") {
          Object.values(clone.lists).forEach((field) => resetField(field, newRecordId, context));
        }
        for (const [key, value] of Object.entries(clone)) {
          if (/^field\\d+/.test(key)) resetField(value, newRecordId, context);
        }
        records.push(clone);
        rows = records.filter((row) => String(row?.recordId || "").trim());
        created.push(newRecordId);
      }
      try {
        if (typeof formsonVm.$forceUpdate === "function") formsonVm.$forceUpdate();
        if (formsonVm.listTable && typeof formsonVm.listTable.$forceUpdate === "function") {
          formsonVm.listTable.$forceUpdate();
        }
      } catch (_error) {}
      return {
        ok: rows.length === ${JSON.stringify(wantedRowCount)},
        tableName,
        wantedRowCount: ${JSON.stringify(wantedRowCount)},
        beforeRowCount,
        currentRowCount: rows.length,
        created,
        recordIds: rows.map((row) => String(row.recordId || "")).filter(Boolean),
      };
    }`
  );
}

async function ensureInventoryBatchRowsByOfficialPageData(cdp, items = []) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(config.detailTableName)};
      const detailFields = ${JSON.stringify(config.detailFields)};
      const knownEnumValues = ${JSON.stringify(config.knownEnumValues || {})};
      const items = ${JSON.stringify(items)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const findFormsonVm = () => {
        const tableSection =
          iframeDocument.querySelector("section." + tableName) ||
          iframeDocument.querySelector("." + tableName) ||
          iframeDocument.getElementById(tableName);
        let current = tableSection;
        let depth = 0;
        while (current && depth < 16) {
          const vm = current.__vue__;
          if (vm && vm.$options && vm.$options.name === "formson" && vm.listTable) return vm;
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const api = iframeWindow.thirdPartyFormAPI || null;
      const formsonVm = findFormsonVm();
      if (!api || typeof api.setFormData !== "function") {
        return { ok: false, error: "third-party-set-form-data-unavailable", tableName };
      }
      if (!formsonVm || !Array.isArray(formsonVm.listTable?.records)) {
        return { ok: false, error: "formson-vm-not-found", tableName };
      }
      const templateRow =
        formsonVm.listTable.records.find((row) => row && row.lists && typeof row.lists === "object") ||
        null;
      if (!templateRow) {
        return { ok: false, error: "template-row-not-found", tableName };
      }
      const beforeRowCount = formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim()).length;
      const fieldValue = (key, rawValue) => {
        const fieldId = detailFields[key];
        if (!fieldId) return null;
        const wanted = String(rawValue ?? "").trim();
        if (!wanted) return null;
        const templateField = templateRow?.lists?.[fieldId] || {};
        let matchedEnum = null;
        if (Array.isArray(templateField.enums)) {
          matchedEnum =
            templateField.enums.find((item) => clean(item.showValue || item.enumValue || item.value) === wanted) ||
            templateField.enums.find((item) => clean(item.showValue || item.enumValue || item.value).includes(wanted)) ||
            null;
        }
        const configuredEnumValue = String(knownEnumValues?.[key]?.[wanted] || "").trim();
        return {
          value: String(matchedEnum?.id || matchedEnum?.value || configuredEnumValue || wanted),
          showValue: String(matchedEnum?.showValue || wanted),
          showValue2: String(matchedEnum?.enumValue || matchedEnum?.showValue || wanted),
          display: String(matchedEnum?.showValue || wanted),
        };
      };
      const startedAt = Date.now();
      const records = items.map((item, index) => {
        const recordId = "-" + String(startedAt) + String(Math.floor(Math.random() * 1000000)) + String(index + 1);
        const record = {
          recordId,
          groupSort: index,
          sort: index,
          ordinal: index,
        };
        for (const [key, fieldId] of Object.entries(detailFields)) {
          const prepared = fieldValue(key, item?.[key]);
          if (prepared) record[fieldId] = prepared;
        }
        return record;
      });
      const pageData = {
        items: records,
        page: 1,
        pageNo: 1,
        pageSize: Math.max(20, records.length),
        total: records.length,
        totalPages: records.length ? 1 : 0,
        count: records.length,
      };
      iframeWindow.__a8InventoryBatchOfficialPageData = {
        startedAt,
        tableName,
        beforeRowCount,
        requestedRows: records.length,
        callbackSeen: false,
      };
      try {
        api.setFormData({
          tableData: {
            [tableName]: {
              pageData,
            },
          },
          replaceStatus: true,
          calculateStatus: false,
          callbackFn: () => {
            iframeWindow.__a8InventoryBatchOfficialPageData.callbackSeen = true;
            iframeWindow.__a8InventoryBatchOfficialPageData.callbackAt = Date.now();
          },
        });
      } catch (error) {
        return {
          ok: false,
          error: "official-page-data-set-form-data-failed",
          message: String(error),
          tableName,
          beforeRowCount,
          requestedRows: records.length,
        };
      }
      try {
        if (typeof formsonVm.$forceUpdate === "function") formsonVm.$forceUpdate();
      } catch (_error) {}
      const rows = formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim());
      return {
        ok: rows.length === records.length,
        error: rows.length === records.length ? "" : "official-page-data-row-count-mismatch",
        tableName,
        beforeRowCount,
        requestedRows: records.length,
        currentRowCount: rows.length,
        recordIds: rows.map((row) => String(row.recordId || "")).filter(Boolean),
        callbackSeen: Boolean(iframeWindow.__a8InventoryBatchOfficialPageData.callbackSeen),
      };
    }`
  );
}

async function ensureInventoryBatchRowCount(cdp, wantedRowsOrCount, { mode = "fast" } = {}) {
  const wantedRowCount = Array.isArray(wantedRowsOrCount)
    ? wantedRowsOrCount.length
    : Number(wantedRowsOrCount || 0);
  const nativeResult = await ensureInventoryBatchRowsByNativeNewRow(cdp, wantedRowCount, {
    intervalMs: mode === "debug" ? 1000 : 600,
  });
  return {
    ...nativeResult,
    mode,
    strategy: "native-new-row",
  };
}

async function setInventoryMainBusinessDepartment(cdp, businessDepartment) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const wanted = ${JSON.stringify(String(businessDepartment || "").trim())};
      const fieldId = ${JSON.stringify(config.fields.businessDepartment)};
      const tableName = ${JSON.stringify(config.mainTableName)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const api = iframeWindow.thirdPartyFormAPI;
      let formData = null;
      try {
        formData = typeof api?.getFormData === "function" ? api.getFormData() : null;
      } catch (_error) {
        formData = null;
      }
      const control = formData?.formmains?.[tableName]?.[fieldId] || null;
      const host = iframeDocument.getElementById(fieldId + "_id");
      let matchedEnum = null;
      if (control && Array.isArray(control.enums)) {
        matchedEnum =
          control.enums.find((item) => clean(item.showValue || item.enumValue || item.value) === wanted) ||
          control.enums.find((item) => clean(item.showValue || item.enumValue || item.value).includes(wanted)) ||
          null;
      }
      if (control && typeof control === "object") {
        if (matchedEnum) {
          control.value = String(matchedEnum.id || matchedEnum.value || "");
          control.showValue = String(matchedEnum.showValue || wanted);
          control.showValue2 = String(matchedEnum.enumValue || wanted);
        } else {
          control.value = wanted;
          control.showValue = wanted;
          control.showValue2 = wanted;
        }
      }
      if (host) {
        const input = host.querySelector("input");
        if (input) {
          input.value = wanted;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const browse =
          host.querySelector(".browse-text") ||
          host.querySelector(".cap4-select__browse") ||
          host.querySelector(".cap4-field-choose__browse") ||
          host.querySelector(".cap4-text__browse span");
        if (browse) browse.textContent = wanted;
      }
      return {
        ok: Boolean(control || host),
        fieldId,
        wanted,
        matchedEnum: matchedEnum
          ? {
              id: matchedEnum.id || "",
              showValue: matchedEnum.showValue || "",
              enumValue: matchedEnum.enumValue || "",
            }
          : null,
        controlAfter: control
          ? {
              value: control.value || "",
              showValue: control.showValue || "",
              showValue2: control.showValue2 || "",
            }
          : null,
        hostFound: Boolean(host),
      };
    }`
  );
}

async function fillInventoryBatchRows(cdp, items = []) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(config.detailTableName)};
      const detailFields = ${JSON.stringify(config.detailFields)};
      const knownEnumValues = ${JSON.stringify(config.knownEnumValues)};
      const items = ${JSON.stringify(items)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const findFormsonVm = () => {
        const tableSection =
          iframeDocument.querySelector("section." + tableName) ||
          iframeDocument.querySelector("." + tableName) ||
          iframeDocument.getElementById(tableName);
        let current = tableSection;
        let depth = 0;
        while (current && depth < 16) {
          const vm = current.__vue__;
          if (vm && vm.$options && vm.$options.name === "formson" && vm.listTable) return vm;
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const getNearestVue = (element) => {
        let current = element;
        let depth = 0;
        while (current && depth < 12) {
          if (current.__vue__) return current.__vue__;
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const formsonVm = findFormsonVm();
      if (!formsonVm || !Array.isArray(formsonVm.listTable?.records)) {
        return { ok: false, error: "formson-vm-not-found", tableName };
      }
      const rows = formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim());
      const notify = (row, fieldId, mode = "change") => {
        try {
          if (typeof formsonVm.$set === "function" && row.lists && row.lists[fieldId]) {
            formsonVm.$set(row.lists, fieldId, row.lists[fieldId]);
          }
        } catch (_error) {}
        try {
          if (typeof formsonVm.changeRowData === "function") {
            formsonVm.changeRowData(row, fieldId, mode);
            return true;
          }
        } catch (_error) {}
        try {
          if (typeof formsonVm.changeSelectRowData === "function") {
            formsonVm.changeSelectRowData(row, fieldId, mode);
            return true;
          }
        } catch (_error) {}
        try {
          if (typeof formsonVm.$forceUpdate === "function") formsonVm.$forceUpdate();
        } catch (_error) {}
        return false;
      };
      const updateDomHost = (rowIndex, fieldId, text) => {
        const hosts = Array.from(iframeDocument.querySelectorAll("#" + fieldId + "_id"));
        const host = hosts[rowIndex] || null;
        if (!host) return { hostFound: false };
        const input =
          Array.from(host.querySelectorAll("input, textarea")).find((node) => !node.readOnly && node.type !== "hidden") ||
          Array.from(host.querySelectorAll("input, textarea")).at(-1) ||
          null;
        if (input) {
          input.value = text;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const browse =
          host.querySelector(".browse-text") ||
          host.querySelector(".cap4-select__browse") ||
          host.querySelector(".cap4-field-choose__browse") ||
          host.querySelector(".cap4-text__browse span");
        if (browse) browse.textContent = text;
        const vm = getNearestVue(host);
        try {
          if (vm && typeof vm.$forceUpdate === "function") vm.$forceUpdate();
        } catch (_error) {}
        return { hostFound: true, inputFound: Boolean(input), browseFound: Boolean(browse) };
      };
      const setField = (row, rowIndex, key, value) => {
        const fieldId = detailFields[key];
        if (!fieldId) return { ok: false, key, error: "unknown-field-key" };
        const wanted = String(value ?? "").trim();
        const field = row?.lists?.[fieldId] || row?.[fieldId] || null;
        if (!field || typeof field !== "object") {
          const dom = updateDomHost(rowIndex, fieldId, wanted);
          return { ok: dom.hostFound, key, fieldId, mode: "dom-only", wanted, dom };
        }
        let matchedEnum = null;
        if (Array.isArray(field.enums) && wanted) {
          matchedEnum =
            field.enums.find((item) => clean(item.showValue || item.enumValue || item.value) === wanted) ||
            field.enums.find((item) => clean(item.showValue || item.enumValue || item.value).includes(wanted)) ||
            null;
        }
        const knownEnumId = String(knownEnumValues?.[key]?.[wanted] || "").trim();
        if (matchedEnum) {
          field.value = String(matchedEnum.id || matchedEnum.value || "");
          field.showValue = String(matchedEnum.showValue || wanted);
          field.showValue2 = String(matchedEnum.enumValue || wanted);
        } else if (knownEnumId) {
          field.value = knownEnumId;
          field.showValue = wanted;
          field.showValue2 = wanted;
        } else {
          field.value = wanted;
          field.showValue = wanted;
          field.showValue2 = wanted;
        }
        field.display = field.showValue || wanted;
        const notified = notify(row, fieldId, (matchedEnum || knownEnumId || Array.isArray(field.enums)) ? "select" : "change");
        const dom = updateDomHost(rowIndex, fieldId, field.showValue || wanted);
        return {
          ok: true,
          key,
          fieldId,
          wanted,
          valueAfter: field.value || "",
          showValueAfter: field.showValue || "",
          enumMatched: matchedEnum
            ? {
                id: matchedEnum.id || "",
                showValue: matchedEnum.showValue || "",
                enumValue: matchedEnum.enumValue || "",
                source: "row-enums",
              }
            : knownEnumId
              ? {
                  id: knownEnumId,
                  showValue: wanted,
                  enumValue: wanted,
                  source: "known-config",
                }
              : null,
          notified,
          dom,
        };
      };
      const rowPlans = items.map((item) => ({
        materialCode: item.materialCode,
        businessDepartment: item.businessDepartment,
        applicationCategory: item.applicationCategory,
        researchMethod: item.researchMethod,
        subsystem: item.subsystem,
        productSeries: item.productSeries,
        materialSegment: item.materialSegment,
        productName: item.productName,
        model: item.model || (item.brand && item.invoiceModel ? item.brand + "_" + item.invoiceModel : item.invoiceModel),
        invoiceModel: item.invoiceModel,
        invoiceName: item.invoiceName || item.productName,
        productDescription: item.productDescription || item.productName,
        designatedSupplier: item.designatedSupplier,
        temporaryMaterial: item.temporaryMaterial,
        originalModel: item.originalModel,
        manufacturerName: item.manufacturerName,
        brand: item.brand,
        unit: item.unit,
        bomType: item.bomType,
        tagType: item.tagType,
        outputTaxRate: item.outputTaxRate,
        inputTaxRate: item.inputTaxRate,
        cost: item.cost,
        freight: item.freight,
        totalCost: item.totalCost,
        channelPrice: item.channelPrice,
        strategicPrice: item.strategicPrice,
        directPrice: item.directPrice,
        promotionAdvice: item.promotionAdvice,
        remark: item.remark,
      }));
      const rowResults = [];
      rowPlans.forEach((rowPlan, rowIndex) => {
        const row = rows[rowIndex];
        const fieldResults = [];
        for (const [key, value] of Object.entries(rowPlan)) {
          if (value == null || String(value).trim() === "") continue;
          fieldResults.push(setField(row, rowIndex, key, value));
        }
        rowResults.push({
          rowIndex: rowIndex + 1,
          recordId: String(row?.recordId || ""),
          ok: fieldResults.every((item) => item.ok),
          fieldResults,
        });
      });
      const markChanged = () => {
        const touched = [];
        let current = formsonVm;
        let depth = 0;
        while (current && depth < 20) {
          for (const key of ["isChange", "isChanged", "changed", "dirty", "isDirty", "hasChange"]) {
            try {
              if (key in current) {
                current[key] = true;
                touched.push(key);
              }
            } catch (_error) {}
          }
          current = current.$parent || null;
          depth += 1;
        }
        try {
          iframeWindow._a8InventoryBatchChanged = true;
        } catch (_error) {}
        return touched;
      };
      const changedMarkers = markChanged();
      try {
        if (typeof formsonVm.$forceUpdate === "function") formsonVm.$forceUpdate();
      } catch (_error) {}
      return {
        ok: rowResults.every((row) => row.ok),
        tableName,
        requestedRows: items.length,
        actualRows: rows.length,
        changedMarkers,
        rowResults,
      };
    }`
  );
}

async function readInventoryBatchSubmitData(cdp) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const serialize = (value) => {
        try {
          return JSON.parse(JSON.stringify(value));
        } catch (error) {
          return { serializationError: String(error), rawType: typeof value };
        }
      };
      const tableName = ${JSON.stringify(config.detailTableName)};
      const readbackFieldIds = ${JSON.stringify([
        config.detailFields.productName,
        config.detailFields.invoiceModel,
        config.detailFields.originalModel,
        config.detailFields.manufacturerName,
        config.detailFields.brand,
        config.detailFields.cost,
        config.detailFields.applicationCategory,
        config.detailFields.researchMethod,
        config.detailFields.subsystem,
        config.detailFields.productSeries,
        config.detailFields.materialSegment,
        config.detailFields.temporaryMaterial,
        config.detailFields.unit,
        config.detailFields.tagType,
        config.detailFields.outputTaxRate,
        config.detailFields.inputTaxRate,
      ].filter(Boolean))};
      const compactField = (field) => {
        if (!field || typeof field !== "object") return field || "";
        return {
          recordId: field.recordId ?? "",
          Xkey: field.Xkey ?? "",
          value: field.value ?? "",
          showValue: field.showValue ?? "",
          showValue2: field.showValue2 ?? "",
          display: field.display ?? "",
        };
      };
      const readRowsFromFormsonVm = () => {
        const tableSection =
          iframeDocument.querySelector(\`section.\${tableName}\`) ||
          iframeDocument.querySelector(\`.\${tableName}\`) ||
          iframeDocument.getElementById(tableName);
        let current = tableSection;
        let depth = 0;
        while (current && depth < 12) {
          const vm = current.__vue__;
          if (
            vm &&
            vm.$options &&
            vm.$options.name === "formson" &&
            vm.listTable &&
            vm.listTable.tableName === tableName
          ) {
            const records = Array.isArray(vm.listTable.records)
              ? vm.listTable.records.filter((row) => String(row?.recordId || "").trim())
              : [];
            return records.map((row) => {
              const lists = {};
              for (const fieldId of readbackFieldIds) {
                lists[fieldId] = compactField(row?.lists?.[fieldId]);
              }
              return {
                recordId: String(row?.recordId || "").trim(),
                lists,
              };
            });
          }
          current = current.parentElement;
          depth += 1;
        }
        return [];
      };
      try {
        const form = iframeWindow.Form || iframeWindow.form || null;
        if (form && typeof form.SDKgetSubmitData === "function") {
          const submitData = form.SDKgetSubmitData();
          return {
            ok: true,
            source: "Form.SDKgetSubmitData",
            submitData: serialize(submitData),
          };
        }
        const rows = readRowsFromFormsonVm();
        if (!rows.length) {
          return {
            ok: false,
            error: "submit-readback-unavailable",
            hasForm: Boolean(form),
            formKeys: form ? Object.keys(form).slice(0, 40) : [],
            source: "none",
          };
        }
        return {
          ok: true,
          source: "formson-vm",
          submitData: {
            formsons: {
              [tableName]: rows,
            },
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: "SDKgetSubmitData-failed",
          message: String(error),
        };
      }
    }`
  );
}

async function inspectInventoryBatchSaveEnvironment(cdp) {
  const topResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const sourceOf = (fn) => {
        try {
          return typeof fn === "function" ? Function.prototype.toString.call(fn).slice(0, 3000) : "";
        } catch (error) {
          return String(error);
        }
      };
      const saveBtn = document.getElementById("saveDraft_a");
      return {
        ok: true,
        href: location.href,
        title: document.title,
        hasSaveDraft: typeof window.saveDraft === "function",
        hasToolbarSaveDraft: typeof window.toolbarsaveDraft_aClick === "function",
        hasEndSaveDraft: typeof window.endSaveDraft === "function",
        saveButton: saveBtn
          ? {
              id: saveBtn.id || "",
              text: String(saveBtn.innerText || saveBtn.textContent || "").trim(),
              onclick: saveBtn.getAttribute("onclick") || "",
            }
          : null,
        saveDraftSource: sourceOf(window.saveDraft),
        toolbarSaveDraftSource: sourceOf(window.toolbarsaveDraft_aClick),
      };
    })()`,
    returnByValue: true,
  });
  const iframeResult = await evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const sourceOf = (fn) => {
        try {
          return typeof fn === "function" ? Function.prototype.toString.call(fn).slice(0, 3000) : "";
        } catch (error) {
          return String(error);
        }
      };
      const api = iframeWindow.thirdPartyFormAPI || null;
      const mineFormPage = iframeDocument.getElementById("mineFormPage");
      const pageVm = mineFormPage && mineFormPage.__vue__ ? mineFormPage.__vue__ : null;
      const collectVmMethods = (vm) => {
        const methods = [];
        let current = vm;
        let depth = 0;
        while (current && depth < 12) {
          const names = [];
          for (const key of Object.keys(current || {})) {
            try {
              if (typeof current[key] === "function" && /save|submit|check|valid|change|dirty|data|form/i.test(key)) {
                names.push(key);
              }
            } catch (_error) {}
          }
          methods.push({
            depth,
            name: current?.$options?.name || "",
            names: names.slice(0, 80),
          });
          current = current.$parent || null;
          depth += 1;
        }
        return methods;
      };
      return {
        ok: true,
        href: iframeWindow.location.href,
        hasApi: Boolean(api),
        apiKeys: api ? Object.keys(api).slice(0, 80) : [],
        apiSources: {
          getFormData: sourceOf(api?.getFormData),
          setFormData: sourceOf(api?.setFormData),
          preFormSave: sourceOf(api?.preFormSave),
          backfillFormControlData: sourceOf(api?.backfillFormControlData),
        },
        hasPageVm: Boolean(pageVm),
        pageVmMethods: collectVmMethods(pageVm),
      };
    }`
  );
  return {
    ok: true,
    top: topResult.result?.value || null,
    iframe: iframeResult || null,
  };
}

async function inspectInventoryBatchPreSaveParams(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {
      const iframeId = ${JSON.stringify(config.iframeId)};
      const mainTableName = ${JSON.stringify(config.mainTableName)};
      const detailTableName = ${JSON.stringify(config.detailTableName)};
      const detailFields = ${JSON.stringify(config.detailFields)};
      const iframe = document.getElementById(iframeId);
      if (!iframe || !iframe.contentWindow) {
        return { ok: false, error: "iframe-not-found", iframeId };
      }
      const iframeWindow = iframe.contentWindow;
      const api = iframeWindow.thirdPartyFormAPI || null;
      const iframeDocument = iframe.contentDocument || iframeWindow.document;
      const findFormSaveVm = () => {
        const seen = new Set();
        const candidates = [];
        const addVm = (vm, source) => {
          if (!vm || seen.has(vm)) return;
          seen.add(vm);
          let current = vm;
          let depth = 0;
          while (current && depth < 20) {
            if (!seen.has(current)) seen.add(current);
            if (typeof current.formSave === "function") {
              candidates.push({
                vm: current,
                source,
                depth,
                name: current?.$options?.name || "",
              });
              return;
            }
            current = current.$parent || null;
            depth += 1;
          }
        };
        for (const node of Array.from(iframeDocument.querySelectorAll("*"))) {
          if (node.__vue__) addVm(node.__vue__, node.id || node.className || node.tagName);
        }
        if (iframeWindow.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
          try {
            for (const app of iframeWindow.__VUE_DEVTOOLS_GLOBAL_HOOK__.apps || []) {
              addVm(app?.app?._instance?.proxy || app?.app, "devtools-app");
            }
          } catch (_error) {}
        }
        return candidates[0] || null;
      };
      const pick = (row, fieldId) => {
        const value = row?.[fieldId] ?? "";
        return String(value == null ? "" : value).trim();
      };
      const attempts = [];
      const waitForCapture = async (label, invoke) => {
        let captured = null;
        let callbackSeen = false;
        let promiseSeen = false;
        let promiseOutcome = "";
        try {
          const returned = invoke((params) => {
            callbackSeen = true;
            captured = params;
          });
          if (returned && typeof returned.then === "function") {
            promiseSeen = true;
            await Promise.race([
              returned.then(
                () => {
                  promiseOutcome = "resolved";
                },
                (error) => {
                  promiseOutcome = String(error || "");
                }
              ),
              new Promise((resolve) => setTimeout(() => {
                if (!promiseOutcome) promiseOutcome = "timeout";
                resolve();
              }, 3000)),
            ]);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          attempts.push({
            label,
            ok: Boolean(captured && typeof captured === "object"),
            callbackSeen,
            promiseSeen,
            promiseOutcome,
            returnedType: typeof returned,
            returnedValue: returned == null ? "" : String(returned).slice(0, 300),
            capturedType: captured == null ? "" : typeof captured,
            capturedKeys: captured && typeof captured === "object" ? Object.keys(captured).slice(0, 20) : [],
          });
          return captured;
        } catch (error) {
          attempts.push({ label, ok: false, error: String(error) });
          return null;
        }
      };

      let captured = null;
      if (api && typeof api.preFormSave === "function") {
        captured = await waitForCapture("thirdPartyFormAPI.preFormSave-object", (callback) =>
          api.preFormSave({
            type: "save",
            isPrev: true,
            state: "getFormAllData",
            callback,
          })
        );
        if (!captured) {
          captured = await waitForCapture("thirdPartyFormAPI.preFormSave-positional", (callback) =>
            api.preFormSave("save", true, callback, null, "getFormAllData")
          );
        }
      }
      const formSaveVm = findFormSaveVm();
      if (!captured && formSaveVm?.vm && typeof formSaveVm.vm.formSave === "function") {
        captured = await waitForCapture("vm.formSave-getFormAllData", (callback) =>
          formSaveVm.vm.formSave("save", true, callback, null, "getFormAllData")
        );
      }
      if (!captured || typeof captured !== "object") {
        return {
          ok: false,
          error: "pre-save-getFormAllData-no-callback",
          attempts,
          formSaveVm: formSaveVm
            ? {
                source: formSaveVm.source,
                depth: formSaveVm.depth,
                name: formSaveVm.name,
              }
            : null,
          hasPreFormSave: typeof api?.preFormSave === "function",
        };
      }
      const detailRows = Array.isArray(captured?.[detailTableName])
        ? captured[detailTableName]
        : [];
      let serializedLength = 0;
      try {
        serializedLength = JSON.stringify(captured).length;
      } catch (_error) {}
      return {
        ok: true,
        source: "getFormAllData",
        attempts,
        formSaveVm: formSaveVm
          ? {
              source: formSaveVm.source,
              depth: formSaveVm.depth,
              name: formSaveVm.name,
            }
          : null,
        serializedLength,
        topLevelKeys: Object.keys(captured).slice(0, 40),
        content: {
          isMerge: captured.content?.isMerge ?? "",
          saveType: captured.content?.saveType ?? "",
          needCheckRule: captured.content?.needCheckRule ?? "",
          needAutoCollect: captured.content?.needAutoCollect ?? "",
          operateType: captured.content?.operateType ?? "",
          contentTemplateId: captured.content?.contentTemplateId ?? "",
          moduleTemplateId: captured.content?.moduleTemplateId ?? "",
        },
        main: {
          tableName: mainTableName,
          hasMain: Boolean(captured?.[mainTableName]),
          field0130: captured?.[mainTableName]?.field0130 ?? "",
        },
        detail: {
          tableName: detailTableName,
          rowCount: detailRows.length,
          rows: detailRows.map((row, index) => ({
            row: index + 1,
            id: row?.id || "",
            productName: pick(row, detailFields.productName),
            invoiceModel: pick(row, detailFields.invoiceModel),
            outputTaxRate: pick(row, detailFields.outputTaxRate),
            inputTaxRate: pick(row, detailFields.inputTaxRate),
            unit: pick(row, detailFields.unit),
            materialSegment: pick(row, detailFields.materialSegment),
          })),
        },
        pageInfo: captured.pageInfo?.[detailTableName] || null,
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }, {
    timeoutMs: 15000,
  }).then((response) => response.result?.value || { ok: false, error: "empty-cdp-result" }).catch((error) => ({
    ok: false,
    error: "pre-save-params-cdp-timeout-or-error",
    message: String(error),
  }));
  return result;
}

async function fillInventoryBatchTaxRatesOnly(cdp, {
  outputTaxRate = "13%",
  inputTaxRate = "13%",
} = {}) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(config.detailTableName)};
      const detailFields = ${JSON.stringify(config.detailFields)};
      const knownEnumValues = ${JSON.stringify(config.knownEnumValues)};
      const outputTaxRate = ${JSON.stringify(String(outputTaxRate || "13%"))};
      const inputTaxRate = ${JSON.stringify(String(inputTaxRate || "13%"))};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const tableSection =
        iframeDocument.querySelector("section." + tableName) ||
        iframeDocument.querySelector("." + tableName) ||
        iframeDocument.getElementById(tableName);
      let formsonVm = null;
      let current = tableSection;
      let depth = 0;
      while (current && depth < 16) {
        const vm = current.__vue__;
        if (vm && vm.$options && vm.$options.name === "formson" && vm.listTable) {
          formsonVm = vm;
          break;
        }
        current = current.parentElement;
        depth += 1;
      }
      if (!formsonVm || !Array.isArray(formsonVm.listTable?.records)) {
        return { ok: false, error: "formson-vm-not-found", tableName };
      }
      const rows = formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim());
      const updateDomHost = (rowIndex, fieldId, text) => {
        const host =
          iframeDocument.getElementById(fieldId + "_" + rows[rowIndex]?.recordId + "_id") ||
          Array.from(iframeDocument.querySelectorAll("#" + fieldId + "_id"))[rowIndex] ||
          null;
        if (!host) return { hostFound: false };
        const input =
          Array.from(host.querySelectorAll("input, textarea")).find((node) => !node.readOnly && node.type !== "hidden") ||
          Array.from(host.querySelectorAll("input, textarea")).at(-1) ||
          null;
        if (input) {
          input.value = text;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const browse =
          host.querySelector(".browse-text") ||
          host.querySelector(".cap4-select__browse") ||
          host.querySelector(".cap4-field-choose__browse") ||
          host.querySelector(".cap4-text__browse span");
        if (browse) browse.textContent = text;
        return { hostFound: true, inputFound: Boolean(input), browseFound: Boolean(browse) };
      };
      const setTax = (row, rowIndex, key, wanted) => {
        const fieldId = detailFields[key];
        const field = row?.lists?.[fieldId] || row?.[fieldId] || null;
        if (!field || typeof field !== "object") {
          const dom = updateDomHost(rowIndex, fieldId, wanted);
          return { ok: dom.hostFound, key, fieldId, wanted, mode: "dom-only", dom };
        }
        let matchedEnum = null;
        if (Array.isArray(field.enums)) {
          matchedEnum =
            field.enums.find((item) => clean(item.showValue || item.enumValue || item.value) === wanted) ||
            field.enums.find((item) => clean(item.showValue || item.enumValue || item.value).includes(wanted)) ||
            null;
        }
        const knownEnumId = String(knownEnumValues?.[key]?.[wanted] || "").trim();
        if (matchedEnum) {
          field.value = String(matchedEnum.id || matchedEnum.value || "");
          field.showValue = String(matchedEnum.showValue || wanted);
          field.showValue2 = String(matchedEnum.enumValue || wanted);
        } else if (knownEnumId) {
          field.value = knownEnumId;
          field.showValue = wanted;
          field.showValue2 = wanted;
        } else {
          field.value = wanted;
          field.showValue = wanted;
          field.showValue2 = wanted;
        }
        field.display = field.showValue || wanted;
        let notified = false;
        try {
          if (typeof formsonVm.changeSelectRowData === "function") {
            formsonVm.changeSelectRowData(row, fieldId, "select");
            notified = true;
          } else if (typeof formsonVm.changeRowData === "function") {
            formsonVm.changeRowData(row, fieldId, "select");
            notified = true;
          }
        } catch (_error) {}
        const dom = updateDomHost(rowIndex, fieldId, field.showValue || wanted);
        return {
          ok: true,
          key,
          fieldId,
          wanted,
          valueAfter: field.value || "",
          showValueAfter: field.showValue || "",
          showValue2After: field.showValue2 || "",
          enumMatched: matchedEnum
            ? {
                id: matchedEnum.id || "",
                showValue: matchedEnum.showValue || "",
                enumValue: matchedEnum.enumValue || "",
                source: "row-enums",
              }
            : knownEnumId
              ? {
                  id: knownEnumId,
                  showValue: wanted,
                  enumValue: wanted,
                  source: "known-config",
                }
              : null,
          notified,
          dom,
        };
      };
      const rowResults = rows.map((row, index) => ({
        rowIndex: index + 1,
        recordId: String(row?.recordId || ""),
        outputTaxRate: setTax(row, index, "outputTaxRate", outputTaxRate),
        inputTaxRate: setTax(row, index, "inputTaxRate", inputTaxRate),
      }));
      let currentVm = formsonVm;
      const changedMarkers = [];
      while (currentVm && changedMarkers.length < 20) {
        for (const key of ["isChange", "isChanged", "changed", "dirty", "isDirty", "hasChange"]) {
          try {
            if (key in currentVm) {
              currentVm[key] = true;
              changedMarkers.push(key);
            }
          } catch (_error) {}
        }
        currentVm = currentVm.$parent || null;
      }
      try {
        if (typeof formsonVm.$forceUpdate === "function") formsonVm.$forceUpdate();
      } catch (_error) {}
      return {
        ok: rowResults.every((item) => item.outputTaxRate.ok && item.inputTaxRate.ok),
        tableName,
        rowCount: rows.length,
        outputTaxRate,
        inputTaxRate,
        changedMarkers,
        rowResults,
      };
    }`
  );
}

async function syncInventoryBatchWorkflowState(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      try {
      const setValue = (selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        el.value = value == null ? "" : String(value);
        return el.value;
      };
      const getValue = (selector) => {
        const el = document.querySelector(selector);
        return el ? (el.value || "") : "";
      };
      const syncNamedValue = (name, value) => {
        const elements = document.querySelectorAll('[name="' + name + '"], #' + name);
        for (const el of elements) {
          if ("value" in el) {
            el.value = value == null ? "" : String(value);
          }
        }
      };
      const valueOf = (value) => {
        if (value == null) return "";
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        if (typeof value === "object" && "value" in value) {
          return String(value.value || "");
        }
        return "";
      };
      const getIframeParam = (name) => {
        try {
          const iframe = document.getElementById(${JSON.stringify(config.iframeId)});
          const rawUrl = iframe && (iframe.src || iframe.getAttribute("src"));
          if (!rawUrl) return "";
          const url = new URL(rawUrl, location.origin);
          return url.searchParams.get(name) || "";
        } catch (_error) {
          return "";
        }
      };
      const processTemplateId =
        getValue("#varFinalWfProcessId") ||
        (typeof window.wfProcessTemplateId !== "undefined" ? window.wfProcessTemplateId : "") ||
        (typeof window.templateWorkflowId !== "undefined" ? window.templateWorkflowId : "") ||
        (typeof window.templateProcessId !== "undefined" ? window.templateProcessId : "");
      const processInfo = getValue("#colMainData #process_info");
      let processInfoSelectValue = "";
      try {
        processInfoSelectValue =
          typeof window.getNormalData === "function" ? window.getNormalData("process_info") : "";
      } catch (_error) {
        processInfoSelectValue = "";
      }
      const formRecordid =
        (typeof window.formRecordid !== "undefined" ? valueOf(window.formRecordid) : "") ||
        getValue("#formRecordid");
      const formAppid =
        (typeof window.formAppid !== "undefined" ? valueOf(window.formAppid) : "") ||
        getValue("#formAppid");
      const formViewOperation =
        (typeof window.formViewOperation !== "undefined" ? valueOf(window.formViewOperation) : "") ||
        getValue("#formViewOperation");
      const rightId =
        (typeof window.rightId !== "undefined" ? valueOf(window.rightId) : "") ||
        getValue("#rightId") ||
        getIframeParam("rightId");

      if (processTemplateId) {
        setValue("#workflow_definition #processId", processTemplateId);
        setValue("#colMainData #oldProcessId", processTemplateId);
        syncNamedValue("processId", processTemplateId);
        syncNamedValue("oldProcessId", processTemplateId);
        window._summaryProcessId = processTemplateId;
        window._processTemplateId = processTemplateId;
      }
      if (processInfo) {
        setValue("#workflow_definition #process_info", processInfo);
        syncNamedValue("process_info", processInfo);
      }
      if (processInfoSelectValue) {
        setValue("#workflow_definition #process_info_selectvalue", processInfoSelectValue);
        syncNamedValue("process_info_selectvalue", processInfoSelectValue);
      }
      if (formRecordid) {
        syncNamedValue("formRecordid", formRecordid);
        syncNamedValue("contentDataId", formRecordid);
      }
      if (formAppid) {
        syncNamedValue("formAppid", formAppid);
        syncNamedValue("contentTemplateId", formAppid);
      }
      if (formViewOperation) {
        syncNamedValue("formViewOperation", formViewOperation);
      }
      if (rightId) {
        syncNamedValue("rightId", rightId);
        syncNamedValue("contentRightId", rightId);
      }
      return {
        ok: true,
        processTemplateId,
        workflowProcessId: getValue("#workflow_definition #processId"),
        oldProcessId: getValue("#colMainData #oldProcessId") || getValue("#oldProcessId"),
        processInfo: getValue("#workflow_definition #process_info"),
        processInfoSelectValue: getValue("#workflow_definition #process_info_selectvalue"),
        formRecordid: getValue("#formRecordid"),
        contentDataId: getValue("#contentDataId"),
        formAppid: getValue("#formAppid"),
        contentTemplateId: getValue("#contentTemplateId"),
        formViewOperation: getValue("#formViewOperation"),
        rightId: getValue("#rightId"),
        contentRightId: getValue("#contentRightId")
      };
      } catch (error) {
        return {
          ok: false,
          error: "sync-workflow-state-page-error",
          message: String(error),
          stack: error && error.stack ? String(error.stack).slice(0, 2000) : ""
        };
      }
    })()`,
    returnByValue: true,
  }).then((response) => response.result?.value || { ok: false, error: "empty-cdp-result" }).catch((error) => ({
    ok: false,
    error: "sync-workflow-state-failed",
    message: String(error),
  }));
  return result;
}

function resolveInventoryBatchSaveActions(runMode) {
  const configured = String(process.env.A8_INVENTORY_BATCH_SAVE_ACTIONS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item) => ["mouse", "toolbar", "direct", "dom"].includes(item));
  if (configured.length > 0) {
    return [...new Set(configured)];
  }
  if (runMode === "debug") {
    return ["mouse", "toolbar", "direct", "dom"];
  }
  return ["mouse", "toolbar"];
}

async function runInventoryBatchSaveDraft({ input = {}, mode = "normal", runRoot }) {
  const requestedMode = String(mode || "").toLowerCase();
  const runMode = ["fast", "normal", "debug"].includes(requestedMode)
    ? requestedMode
    : "normal";
  if (runMode === "fast") {
    return {
      ok: false,
      stage: "unsupported-mode",
      flow: "inventory_batch_save_draft",
      mode: runMode,
      message:
        "inventory_batch_save_draft does not support fast mode. Use normal for production or debug for troubleshooting.",
      saveDraftTouched: false,
    };
  }
  const normalizedInput = buildInventoryBatchSaveDraftInput(input);
  const inputValidation = validateInventoryBatchSaveDraftInput(normalizedInput);
  if (!inputValidation.ok) {
    return {
      ok: false,
      stage: "input-validation",
      flow: "inventory_batch_save_draft",
      mode: runMode,
      input: normalizedInput,
      inputValidation,
      saveDraftTouched: false,
    };
  }

  let opened = null;
  try {
    opened = await openInventoryBatchObservationSession({ runRoot });
    const { session, flowOpenResult } = opened;
    const cdp = session.cdp;
    const debugScreenshots = [];
    const captureDebug = async (label, extra = {}) => {
      if (runMode !== "debug") return null;
      const artifact = await captureInventoryBatchDebugStep(cdp, runRoot, label, extra);
      debugScreenshots.push(artifact);
      return artifact;
    };
    await writeInventoryBatchSaveStage(runRoot, { stage: "session-opened" });
    await captureDebug("01-session-opened", { flowOpenResult });
    const iframeReady = await withTimeout(
      waitForIframeReady(cdp, config.iframeId, {
        timeoutMs: config.iframeLoadTimeoutMs,
      }).then((value) => ({ ok: true, value })).catch((error) => ({
        ok: false,
        error: String(error),
      })),
      Number(config.iframeLoadTimeoutMs || 45000) + 5000,
      { ok: false, error: "wait-for-iframe-ready-hard-timeout" }
    );
    await writeInventoryBatchSaveStage(runRoot, { stage: "iframe-ready-check", iframeReady });
    await captureDebug("02-iframe-ready-check", { iframeReady });
    if (!iframeReady.ok) {
      return {
        ok: false,
        stage: "iframe-ready-timeout",
        flow: "inventory_batch_save_draft",
        mode: runMode,
        input: normalizedInput,
        inputValidation,
        flowOpenResult,
        iframeReady,
        saveDraftTouched: false,
      };
    }

    await writeInventoryBatchSaveStage(runRoot, { stage: "render-wait-start" });
    const renderReady = await waitForInventoryBatchRendered(cdp);
    await writeInventoryBatchSaveStage(runRoot, { stage: "render-wait-end", renderReady });
    await captureDebug("03-render-ready", { renderReady });
    if (!renderReady.ok) {
      return {
        ok: false,
        stage: "form-render-timeout",
        flow: "inventory_batch_save_draft",
        mode: runMode,
        input: normalizedInput,
        inputValidation,
        flowOpenResult,
        renderReady,
        saveDraftTouched: false,
      };
    }

    const before = renderReady.probe || await probeInventoryBatchRenderState(cdp);
    await writeInventoryBatchSaveStage(runRoot, { stage: "ensure-row-count-start" });
    const rowCountResult = await ensureInventoryBatchRowCount(cdp, normalizedInput.items, {
      mode: runMode,
    });
    await writeInventoryBatchSaveStage(runRoot, { stage: "ensure-row-count-end", rowCountResult });
    await captureDebug("04-row-count-ready", { rowCountResult });
    if (!rowCountResult.ok) {
      return {
        ok: false,
        stage: "ensure-row-count",
        flow: "inventory_batch_save_draft",
        mode: runMode,
        input: normalizedInput,
        inputValidation,
        flowOpenResult,
        renderReady,
        before,
        rowCountResult,
        saveDraftTouched: false,
      };
    }

    await writeInventoryBatchSaveStage(runRoot, { stage: "fill-main-start" });
    const fillMain = await setInventoryMainBusinessDepartment(
      cdp,
      normalizedInput.businessDepartment
    );
    await writeInventoryBatchSaveStage(runRoot, { stage: "fill-main-end", fillMain });
    await captureDebug("05-main-fields-filled", { fillMain });
    await writeInventoryBatchSaveStage(runRoot, { stage: "fill-rows-start" });
    const fillRows = await fillInventoryBatchRows(cdp, normalizedInput.items);
    await writeInventoryBatchSaveStage(runRoot, { stage: "fill-rows-end", fillRows });
    await captureDebug("06-detail-rows-filled", { fillRows });
    const after = await probeInventoryBatchRenderState(cdp);
    await writeInventoryBatchSaveStage(runRoot, { stage: "submit-readback-start" });
    const submitReadback = await readInventoryBatchSubmitData(cdp);
    await writeInventoryBatchSaveStage(runRoot, { stage: "submit-readback-end", submitReadback });
    await captureDebug("07-submit-readback", {
      submitReadback: {
        ok: Boolean(submitReadback?.ok),
        source: submitReadback?.source || "",
      },
    });
    const saveGate = submitReadback?.ok
      ? compareInventoryBatchSubmitData({
          input: {
            ...normalizedInput,
            detailTableName: config.detailTableName,
          },
          submitData: submitReadback.submitData,
        })
      : {
          ok: false,
          errors: [submitReadback?.error || "submit-readback-unavailable"],
          warnings: [],
        };

    await writeJson(path.join(runRoot, "inventory-batch-before-save-dom.json"), before);
    await writeJson(path.join(runRoot, "inventory-batch-after-fill-dom.json"), after);
    await writeJson(path.join(runRoot, "inventory-batch-submit-readback.json"), submitReadback);
    await writeJson(path.join(runRoot, "inventory-batch-save-gate.json"), saveGate);
    const saveEnvironment = await inspectInventoryBatchSaveEnvironment(cdp);
    await writeJson(path.join(runRoot, "inventory-batch-save-environment.json"), saveEnvironment);
    await writeInventoryBatchSaveStage(runRoot, { stage: "pre-save-params-start" });
    const preSaveParams = await inspectInventoryBatchPreSaveParams(cdp);
    await writeInventoryBatchSaveStage(runRoot, { stage: "pre-save-params-end", preSaveParams });
    if (runMode === "debug") {
      await writeJson(path.join(runRoot, "inventory-batch-pre-save-params.json"), preSaveParams);
      await captureDebug("08-pre-save-params", { preSaveParams });
    }

    const preSaveReady = Boolean(
      preSaveParams?.ok &&
      Array.isArray(preSaveParams.topLevelKeys) &&
      preSaveParams.topLevelKeys.includes("content") &&
      preSaveParams.topLevelKeys.includes("attachments") &&
      preSaveParams.topLevelKeys.includes(config.mainTableName) &&
      preSaveParams.topLevelKeys.includes(config.detailTableName) &&
      preSaveParams.detail?.rowCount === normalizedInput.items.length
    );

    if (!fillMain?.ok || !fillRows?.ok || !saveGate.ok || !preSaveReady) {
      return {
        ok: false,
        stage: "pre-save-gate",
        flow: "inventory_batch_save_draft",
        mode: runMode,
        input: normalizedInput,
        inputValidation,
        flowOpenResult,
        rowCountResult,
        fillMain,
        fillRows,
        submitReadback,
        saveGate,
        preSaveReady,
        preSaveParams: runMode === "debug" ? preSaveParams : {
          ok: Boolean(preSaveParams?.ok),
          error: preSaveParams?.error || "",
          topLevelKeys: preSaveParams?.topLevelKeys || [],
          rowCount: preSaveParams?.detail?.rowCount ?? 0,
        },
        next: "Run inventory_batch_save_draft in debug mode for screenshots and deeper diagnostics.",
        saveDraftTouched: false,
      };
    }

    const workflowState = await syncInventoryBatchWorkflowState(cdp);
    await writeJson(path.join(runRoot, "inventory-batch-workflow-state.json"), workflowState);
    await writeInventoryBatchSaveStage(runRoot, { stage: "workflow-state-synced", workflowState });
    await captureDebug("09-before-save-click", { workflowState });

    const saveNetworkEvents = [];
    await cdp.send("Network.enable").catch(() => {});
    cdp.on("Network.requestWillBeSent", (params) => {
      const url = params?.request?.url || "";
      if (!/\/seeyon\/collaboration\/collaboration\.do|\/seeyon\/common\/cap4/i.test(url)) return;
      saveNetworkEvents.push({
        type: "request",
        url,
        method: params.request?.method || "",
        hasPostData: Boolean(params.request?.postData),
      });
    });
    cdp.on("Network.responseReceived", (params) => {
      const url = params?.response?.url || "";
      if (!/\/seeyon\/collaboration\/collaboration\.do|\/seeyon\/common\/cap4/i.test(url)) return;
      saveNetworkEvents.push({
        type: "response",
        url,
        status: params.response?.status || 0,
        mimeType: params.response?.mimeType || "",
      });
    });
    await writeInventoryBatchSaveStage(runRoot, { stage: "save-draft-start" });
    const saveActions = resolveInventoryBatchSaveActions(runMode);
    const saveResult = await saveDraftByMouse(cdp, {
      readyTimeoutMs: 30000,
      actionTimeoutMs: runMode === "debug" && saveActions.length > 1 ? 45000 : runMode === "debug" ? 90000 : 60000,
      actions: saveActions,
    });
    await writeInventoryBatchSaveStage(runRoot, { stage: "save-draft-end", saveResult });
    await writeJson(path.join(runRoot, "inventory-batch-save-network.json"), saveNetworkEvents);
    await captureDebug("10-after-save-attempt", {
      saveResult,
      saveNetworkEventCount: saveNetworkEvents.length,
    });

    return {
      ok: Boolean(saveResult?.ok),
      stage: saveResult?.ok ? "save-draft-completed" : "save-draft-failed",
      flow: "inventory_batch_save_draft",
      mode: runMode,
      businessName: config.businessName,
      input: normalizedInput,
      inputValidation,
      flowOpenResult,
      rowCountResult,
      fillMain,
      fillRows,
      submitReadback,
      saveGate,
      saveEnvironment,
      preSaveParams,
      workflowState,
      saveActions,
      saveNetworkEvents,
      saveResult,
      debugScreenshots,
      warnings: [
        ...(inputValidation.warnings || []),
        ...(saveGate.warnings || []),
      ],
      saveDraftTouched: Boolean(saveResult?.ok),
    };
  } finally {
    if (opened?.session) {
      await closeBrowserSession(opened.session);
    }
  }
}

async function runInventoryBatchTaxOnlySaveProbe({
  outputTaxRate = "13%",
  inputTaxRate = "13%",
  runRoot,
} = {}) {
  let opened = null;
  const debugScreenshots = [];
  try {
    opened = await openInventoryBatchObservationSession({ runRoot });
    const { session, flowOpenResult } = opened;
    const cdp = session.cdp;
    const captureDebug = async (label, extra = {}) => {
      const artifact = await captureInventoryBatchDebugStep(cdp, runRoot, label, extra);
      debugScreenshots.push(artifact);
      return artifact;
    };

    await writeInventoryBatchSaveStage(runRoot, {
      stage: "tax-only-session-opened",
      outputTaxRate,
      inputTaxRate,
    });
    await captureDebug("01-session-opened", { flowOpenResult });

    const iframeReady = await withTimeout(
      waitForIframeReady(cdp, config.iframeId, {
        timeoutMs: config.iframeLoadTimeoutMs,
      }).then((value) => ({ ok: true, value })).catch((error) => ({
        ok: false,
        error: String(error),
      })),
      Number(config.iframeLoadTimeoutMs || 45000) + 5000,
      { ok: false, error: "wait-for-iframe-ready-hard-timeout" }
    );
    await writeInventoryBatchSaveStage(runRoot, {
      stage: "tax-only-iframe-ready-check",
      iframeReady,
    });
    await captureDebug("02-iframe-ready-check", { iframeReady });
    if (!iframeReady.ok) {
      return {
        ok: false,
        stage: "iframe-ready-timeout",
        flow: "inventory_batch_tax_only_save_probe",
        businessName: config.businessName,
        flowOpenResult,
        iframeReady,
        debugScreenshots,
        saveDraftTouched: false,
      };
    }

    const renderReady = await waitForInventoryBatchRendered(cdp);
    await writeInventoryBatchSaveStage(runRoot, {
      stage: "tax-only-render-ready",
      renderReady,
    });
    await captureDebug("03-render-ready", { renderReady });
    if (!renderReady.ok) {
      return {
        ok: false,
        stage: "form-render-timeout",
        flow: "inventory_batch_tax_only_save_probe",
        businessName: config.businessName,
        flowOpenResult,
        renderReady,
        debugScreenshots,
        saveDraftTouched: false,
      };
    }

    const before = await probeInventoryBatchRenderState(cdp);
    const beforeReadback = await readInventoryBatchSubmitData(cdp);
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-before-dom.json"), before);
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-before-readback.json"), beforeReadback);
    await captureDebug("04-before-tax-fill", {
      before,
      beforeReadback: {
        ok: Boolean(beforeReadback?.ok),
        source: beforeReadback?.source || "",
      },
    });

    const fillTaxes = await fillInventoryBatchTaxRatesOnly(cdp, {
      outputTaxRate,
      inputTaxRate,
    });
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-fill-result.json"), fillTaxes);
    await writeInventoryBatchSaveStage(runRoot, {
      stage: "tax-only-fill-end",
      fillTaxes,
    });
    await captureDebug("05-tax-rates-filled", { fillTaxes });

    const submitReadback = await readInventoryBatchSubmitData(cdp);
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-submit-readback.json"), submitReadback);
    await captureDebug("06-submit-readback", {
      submitReadback: {
        ok: Boolean(submitReadback?.ok),
        source: submitReadback?.source || "",
      },
    });

    const saveEnvironment = await inspectInventoryBatchSaveEnvironment(cdp);
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-save-environment.json"), saveEnvironment);

    const preSaveParams = await inspectInventoryBatchPreSaveParams(cdp);
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-pre-save-params.json"), preSaveParams);
    await captureDebug("07-pre-save-params", { preSaveParams });

    const workflowState = await syncInventoryBatchWorkflowState(cdp);
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-workflow-state.json"), workflowState);
    await captureDebug("08-before-save-click", { workflowState });

    const saveNetworkEvents = [];
    await cdp.send("Network.enable").catch(() => {});
    cdp.on("Network.requestWillBeSent", (params) => {
      const url = params?.request?.url || "";
      if (!/\/seeyon\/collaboration\/collaboration\.do|\/seeyon\/common\/cap4/i.test(url)) return;
      saveNetworkEvents.push({
        type: "request",
        url,
        method: params.request?.method || "",
        hasPostData: Boolean(params.request?.postData),
      });
    });
    cdp.on("Network.responseReceived", (params) => {
      const url = params?.response?.url || "";
      if (!/\/seeyon\/collaboration\/collaboration\.do|\/seeyon\/common\/cap4/i.test(url)) return;
      saveNetworkEvents.push({
        type: "response",
        url,
        status: params.response?.status || 0,
        mimeType: params.response?.mimeType || "",
      });
    });

    const saveResult = await saveDraftByMouse(cdp, {
      readyTimeoutMs: 30000,
      actionTimeoutMs: 90000,
      actions: ["mouse"],
    });
    await writeJson(path.join(runRoot, "inventory-batch-tax-only-save-network.json"), saveNetworkEvents);
    await captureDebug("09-after-save-attempt", {
      saveResult,
      saveNetworkEventCount: saveNetworkEvents.length,
    });

    return {
      ok: Boolean(saveResult?.ok),
      stage: saveResult?.ok ? "save-draft-completed" : "save-draft-failed",
      flow: "inventory_batch_tax_only_save_probe",
      businessName: config.businessName,
      outputTaxRate,
      inputTaxRate,
      flowOpenResult,
      renderReady,
      before,
      beforeReadback,
      fillTaxes,
      submitReadback,
      saveEnvironment,
      preSaveParams,
      workflowState,
      saveNetworkEvents,
      saveResult,
      debugScreenshots,
      saveDraftTouched: Boolean(saveResult?.ok),
    };
  } finally {
    if (opened?.session) {
      await closeBrowserSession(opened.session);
    }
  }
}

module.exports = {
  buildInventoryBatchExecutionPlan,
  buildBatchFieldMapping,
  buildMinimalSaveDraftSample,
  runInventoryBatchObservation,
  runInventoryBatchSaveDraft,
  runInventoryBatchTaxOnlySaveProbe,
};
