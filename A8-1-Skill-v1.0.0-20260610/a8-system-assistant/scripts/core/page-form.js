"use strict";

const { evaluateInIframe } = require("./frame");

function buildDetailVmHelpers(tableNameExpression, options = {}) {
  const declareTableName = options.declareTableName !== false;
  return `
      ${declareTableName ? `const tableName = ${tableNameExpression};` : ""}
      const normalizeVmText = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const findFormsonVm = () => {
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
            return vm;
          }
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const formsonVm = findFormsonVm();
      const vmRows = Array.isArray(formsonVm?.listTable?.records)
        ? formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim())
        : [];
      const notifyVmFieldChange = (row, fieldId, mode = "change") => {
        if (!formsonVm || !row || !fieldId) {
          return false;
        }
        try {
          if (typeof formsonVm.$set === "function" && row.lists && row.lists[fieldId]) {
            formsonVm.$set(row.lists, fieldId, row.lists[fieldId]);
          }
        } catch (_error) {
          // ignore
        }
        try {
          if (typeof formsonVm.changeRowData === "function") {
            formsonVm.changeRowData(row, fieldId, mode);
            return true;
          }
        } catch (_error) {
          // ignore
        }
        try {
          if (typeof formsonVm.changeSelectRowData === "function") {
            formsonVm.changeSelectRowData(row, fieldId, mode);
            return true;
          }
        } catch (_error) {
          // ignore
        }
        try {
          if (typeof formsonVm.$forceUpdate === "function") {
            formsonVm.$forceUpdate();
          }
        } catch (_error) {
          // ignore
        }
        return false;
      };
  `;
}

async function getPageFormState(cdp, iframeId) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow) => {
      const api = iframeWindow.thirdPartyFormAPI;
      if (!api || typeof api.getFormData !== "function") {
        return {
          ok: false,
          error: "thirdPartyFormAPI.getFormData-unavailable"
        };
      }

      try {
        const value = api.getFormData();
        return {
          ok: true,
          value: JSON.parse(JSON.stringify(value))
        };
      } catch (error) {
        return {
          ok: false,
          error: "getFormData-failed",
          message: String(error)
        };
      }
    }`
  );
}

async function inspectFormApiMethods(cdp, iframeId) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow) => {
      const api = iframeWindow.thirdPartyFormAPI;
      if (!api) {
        return {
          ok: false,
          error: "thirdPartyFormAPI-unavailable"
        };
      }

      const names = [
        "backfillFormControlData",
        "setFormData",
        "changeFormFieldAuth",
        "preFormSave",
        "backfillFormAttachment"
      ];

      const methods = {};
      for (const name of names) {
        const fn = api[name];
        if (typeof fn !== "function") {
          methods[name] = {
            exists: false
          };
          continue;
        }
        let source = "";
        try {
          source = Function.prototype.toString.call(fn).slice(0, 1200);
        } catch (error) {
          source = String(error);
        }
        methods[name] = {
          exists: true,
          length: fn.length,
          source
        };
      }

      return {
        ok: true,
        keys: Object.keys(api).slice(0, 50),
        methods
      };
    }`
  );
}

async function applyBackfillTableData(cdp, iframeId, payload, options = {}) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const api = iframeWindow.thirdPartyFormAPI;
      if (!api || typeof api.setFormData !== "function") {
        return {
          ok: false,
          error: "thirdPartyFormAPI.setFormData-unavailable"
        };
      }

      const input = ${JSON.stringify(payload)};
      const mainTableName = ${JSON.stringify(options.mainTableName || "")};
      const verifyFieldIds = ${JSON.stringify(options.verifyFieldIds || [])};
      const mineFormPage = iframeDocument.getElementById("mineFormPage");
      const pageVm = mineFormPage && mineFormPage.__vue__ ? mineFormPage.__vue__ : null;
      const getNearestVue = (element) => {
        let current = element;
        while (current) {
          if (current.__vue__) {
            return current.__vue__;
          }
          current = current.parentElement;
        }
        return null;
      };
      const fieldHost = iframeDocument.getElementById("field0009_id");
      const fieldVm = getNearestVue(fieldHost);
      const attempts = [];

      const serialize = (value) => {
        try {
          if (value === undefined) return null;
          return JSON.parse(JSON.stringify(value));
        } catch (_error) {
          return String(value);
        }
      };

      const readSnapshot = () => {
        const snapshot = {
          fields: {},
          visible: {}
        };
        let formData = null;
        try {
          formData = typeof api.getFormData === "function" ? api.getFormData() : null;
        } catch (_error) {
          formData = null;
        }
        const controls = formData?.formmains?.[mainTableName] || {};

        for (const fieldId of verifyFieldIds) {
          const control = controls[fieldId];
          snapshot.fields[fieldId] = {
            value: control?.value ?? "",
            showValue: control?.showValue ?? "",
            auth: control?.auth ?? ""
          };

          const host = iframeDocument.getElementById(fieldId + "_id");
          const browseNode =
            host?.querySelector(".browse-text") ||
            host?.querySelector(".cap4-text__browse span") ||
            host?.querySelector(".cap4-people__browse") ||
            host?.querySelector(".cap4-field-choose__browse") ||
            host?.querySelector(".cap4-select__browse");
          const inputNode = host?.querySelector("input");
          snapshot.visible[fieldId] = {
            found: !!host,
            text: host ? String(host.innerText || "").trim() : "",
            browseText: browseNode ? String(browseNode.innerText || browseNode.textContent || "").trim() : "",
            inputValue: inputNode ? String(inputNode.value || "").trim() : ""
          };
        }

        return snapshot;
      };

      const getVmChain = (startVm) => {
        const chain = [];
        let current = startVm;
        let depth = 0;
        while (current && depth < 20) {
          let hasMethod = false;
          try {
            hasMethod = typeof current.updateBackfillControl === "function";
          } catch (_error) {
            hasMethod = false;
          }
          chain.push({
            depth,
            optionsName:
              current && current.$options && current.$options.name
                ? current.$options.name
                : "",
            hasUpdateBackfillControl: hasMethod,
            keySample: Object.keys(current || {}).slice(0, 25)
          });
          current = current.$parent || null;
          depth += 1;
        }
        return chain;
      };

      const getSnapshotScore = (snapshot) => {
        if (!snapshot || !snapshot.fields) return 0;
        let score = 0;
        for (const fieldId of verifyFieldIds) {
          const field = snapshot.fields[fieldId] || {};
          const visible = snapshot.visible?.[fieldId] || {};
          if (field.value) score += 2;
          if (field.showValue) score += 1;
          if (visible.inputValue) score += 1;
          if (visible.browseText) score += 1;
        }
        return score;
      };

      const findUpdateBackfillOwner = (startVm) => {
        let current = startVm;
        let depth = 0;
        while (current && depth < 20) {
          try {
            if (typeof current.updateBackfillControl === "function") {
              return current;
            }
          } catch (_error) {
            // ignore
          }
          current = current.$parent || null;
          depth += 1;
        }
        return null;
      };

      const ownerVm = findUpdateBackfillOwner(fieldVm) || findUpdateBackfillOwner(pageVm);

      const runAttempt = (name, invoke) => {
        try {
          const result = invoke();
          const snapshot = readSnapshot();
          attempts.push({
            name,
            ok: true,
            returnedType: typeof result,
            returnedValue: serialize(result),
            snapshot
          });
          return {
            ok: true,
            name,
            result,
            snapshot
          };
        } catch (error) {
          attempts.push({
            name,
            ok: false,
            error: String(error)
          });
          return null;
        }
      };

      const candidates = [
        {
          name: "setFormData(payload)",
          invoke: () => api.setFormData(input)
        },
        {
          name: "setFormData({data:payload})",
          invoke: () => api.setFormData({ data: input })
        },
        {
          name: "setFormData({data:payload,topLevelMeta})",
          invoke: () =>
            api.setFormData({
              data: input,
              formmainName: input.formmainName,
              chooseFormsonIndex: input.chooseFormsonIndex,
              types: input.types,
              replaceStatus: input.replaceStatus,
              calcCallback: input.calcCallback,
              handlerStatus: input.handlerStatus,
              calculateStatus: input.calculateStatus,
              callbackFn: input.callbackFn
            })
        },
        {
          name: "setFormData({data:{tableData},topLevelMeta})",
          invoke: () =>
            api.setFormData({
              data: {
                tableData: input.tableData
              },
              formmainName: input.formmainName,
              chooseFormsonIndex: input.chooseFormsonIndex,
              types: input.types,
              replaceStatus: input.replaceStatus,
              calcCallback: input.calcCallback,
              handlerStatus: input.handlerStatus,
              calculateStatus: input.calculateStatus,
              callbackFn: input.callbackFn
            })
        },
        {
          name: "setFormData({data:tableData,topLevelMeta})",
          invoke: () =>
            api.setFormData({
              data: input.tableData,
              formmainName: input.formmainName,
              chooseFormsonIndex: input.chooseFormsonIndex,
              types: input.types,
              replaceStatus: input.replaceStatus,
              calcCallback: input.calcCallback,
              handlerStatus: input.handlerStatus,
              calculateStatus: input.calculateStatus,
              callbackFn: input.callbackFn
            })
        },
        {
          name: "backfillFormControlData(payload)",
          invoke: () => api.backfillFormControlData(input)
        },
        {
          name: "backfillFormControlData({data:payload})",
          invoke: () => api.backfillFormControlData({ data: input })
        },
        {
          name: "backfillFormControlData({data:payload,topLevelMeta})",
          invoke: () =>
            api.backfillFormControlData({
              data: input,
              formmainName: input.formmainName,
              chooseFormsonIndex: input.chooseFormsonIndex,
              types: input.types,
              replaceStatus: input.replaceStatus,
              calcCallback: input.calcCallback,
              handlerStatus: input.handlerStatus,
              calculateStatus: input.calculateStatus,
              callbackFn: input.callbackFn
            })
        },
        {
          name: "backfillFormControlData({data:{tableData},topLevelMeta})",
          invoke: () =>
            api.backfillFormControlData({
              data: {
                tableData: input.tableData
              },
              formmainName: input.formmainName,
              chooseFormsonIndex: input.chooseFormsonIndex,
              types: input.types,
              replaceStatus: input.replaceStatus,
              calcCallback: input.calcCallback,
              handlerStatus: input.handlerStatus,
              calculateStatus: input.calculateStatus,
              callbackFn: input.callbackFn
            })
        },
        {
          name: "backfillFormControlData({data:tableData,topLevelMeta})",
          invoke: () =>
            api.backfillFormControlData({
              data: input.tableData,
              formmainName: input.formmainName,
              chooseFormsonIndex: input.chooseFormsonIndex,
              types: input.types,
              replaceStatus: input.replaceStatus,
              calcCallback: input.calcCallback,
              handlerStatus: input.handlerStatus,
              calculateStatus: input.calculateStatus,
              callbackFn: input.callbackFn
            })
        },
        {
          name: "setFormData(payload,message,relationSelector,pageMess)",
          invoke: () =>
            api.setFormData(input, pageVm ? pageVm.message : undefined, pageVm ? pageVm.relationSelector : undefined, pageVm ? pageVm.pageMess : undefined)
        },
        {
          name: "backfillFormControlData(payload,message,relationSelector,pageMess)",
          invoke: () =>
            api.backfillFormControlData(input, pageVm ? pageVm.message : undefined, pageVm ? pageVm.relationSelector : undefined, pageVm ? pageVm.pageMess : undefined)
        },
        {
          name: "updateBackfillControl(payload)",
          invoke: () => ownerVm.updateBackfillControl(input)
        },
        {
          name: "updateBackfillControl({data:payload})",
          invoke: () => ownerVm.updateBackfillControl({ data: input })
        },
        {
          name: "updateBackfillControl({tableData})",
          invoke: () => ownerVm.updateBackfillControl({ tableData: input.tableData })
        }
      ].filter((item) => typeof item.invoke === "function");

      let bestSuccess = null;
      for (const candidate of candidates) {
        const result = runAttempt(candidate.name, candidate.invoke);
        if (result) {
          const candidateSuccess = {
            name: result.name,
            returnedType: typeof result.result,
            returnedValue: serialize(result.result),
            snapshot: result.snapshot,
            score: getSnapshotScore(result.snapshot)
          };
          if (!bestSuccess || candidateSuccess.score > bestSuccess.score) {
            bestSuccess = candidateSuccess;
          }
        }
      }

      return {
        ok: !!bestSuccess,
        callType: bestSuccess ? bestSuccess.name : "",
        returnedType: bestSuccess ? bestSuccess.returnedType : "",
        returnedValue: bestSuccess ? bestSuccess.returnedValue : null,
        firstSnapshot: bestSuccess ? bestSuccess.snapshot : null,
        attempts,
        context: {
          hasPageVm: !!pageVm,
          pageVmKeys: pageVm ? Object.keys(pageVm).slice(0, 40) : [],
          hasUpdateBackfillControl: !!(pageVm && typeof pageVm.updateBackfillControl === "function"),
          hasMessage: !!(pageVm && pageVm.message),
          hasRelationSelector: !!(pageVm && pageVm.relationSelector),
          hasPageMess: !!(pageVm && pageVm.pageMess),
          hasFieldVm: !!fieldVm,
          fieldVmChain: getVmChain(fieldVm),
          pageVmChain: getVmChain(pageVm),
          ownerFound: !!ownerVm,
          ownerOptionsName:
            ownerVm && ownerVm.$options && ownerVm.$options.name
              ? ownerVm.$options.name
              : "",
          bestScore: bestSuccess ? bestSuccess.score : 0
        }
      };
    }`
  );
}

async function readVisibleFieldValues(cdp, iframeId, fieldIds = []) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const ids = ${JSON.stringify(fieldIds)};
      const result = {};

      for (const fieldId of ids) {
        const host = iframeDocument.getElementById(\`\${fieldId}_id\`);
        if (!host) {
          result[fieldId] = {
            found: false,
            text: "",
            browseText: "",
            inputValue: ""
          };
          continue;
        }

        const browseNode =
          host.querySelector(".browse-text") ||
          host.querySelector(".cap4-text__browse span") ||
          host.querySelector(".cap4-people__browse") ||
          host.querySelector(".cap4-field-choose__browse") ||
          host.querySelector(".cap4-select__browse");
        const inputNode = host.querySelector("input");

        result[fieldId] = {
          found: true,
          text: String(host.innerText || "").trim(),
          browseText: browseNode ? String(browseNode.innerText || browseNode.textContent || "").trim() : "",
          inputValue: inputNode ? String(inputNode.value || "").trim() : ""
        };
      }

      return {
        ok: true,
        fields: result
      };
    }`
  );
}

async function applyProjectRelationTableData(cdp, iframeId, tableData) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const getNearestVue = (element) => {
        let current = element;
        while (current) {
          if (current.__vue__) {
            return current.__vue__;
          }
          current = current.parentElement;
        }
        return null;
      };

      const findUpdateBackfillOwner = (startVm) => {
        let current = startVm;
        let depth = 0;
        while (current && depth < 20) {
          try {
            if (typeof current.updateBackfillControl === "function") {
              return current;
            }
          } catch (_error) {
            // ignore
          }
          current = current.$parent || null;
          depth += 1;
        }
        return null;
      };

      const fieldHost = iframeDocument.getElementById("field0009_id");
      const ownerVm = findUpdateBackfillOwner(getNearestVue(fieldHost));
      if (!ownerVm) {
        return {
          ok: false,
          error: "updateBackfillControl-owner-not-found"
        };
      }

      try {
        ownerVm.updateBackfillControl({
          tableData: ${JSON.stringify(tableData)}
        });
        return {
          ok: true,
          ownerOptionsName:
            ownerVm.$options && ownerVm.$options.name ? ownerVm.$options.name : "unknown"
        };
      } catch (error) {
        return {
          ok: false,
          error: "updateBackfillControl-failed",
          message: String(error)
        };
      }
    }`
  );
}

async function clickFieldRelationTrigger(cdp, iframeId, fieldId) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const host = iframeDocument.getElementById(${JSON.stringify(`${fieldId}_id`)});
      if (!host) {
        return { ok: false, error: "field-host-not-found", fieldId: ${JSON.stringify(fieldId)} };
      }
      const trigger =
        host.querySelector(".cap4-text__relation") ||
        host.querySelector(".cap4-field-choose__relation") ||
        host.querySelector(".cap4-select__icon") ||
        host.querySelector(".cap-icon-zhubiaoxuanzeqi") ||
        host;
      if (!trigger) {
        return { ok: false, error: "field-trigger-not-found", fieldId: ${JSON.stringify(fieldId)} };
      }
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: iframeWindow }));
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: iframeWindow }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: iframeWindow }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: iframeWindow }));
      if (typeof trigger.click === "function") {
        trigger.click();
      }
      return {
        ok: true,
        fieldId: ${JSON.stringify(fieldId)},
        triggerTag: String(trigger.tagName || "").toLowerCase(),
        triggerClass: trigger.className || ""
      };
    }`
  );
}

async function fillMainNumberField(cdp, iframeId, fieldId, value) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const host = iframeDocument.getElementById(${JSON.stringify(`${fieldId}_id`)});
      if (!host) {
        return { ok: false, error: "field-host-not-found", fieldId: ${JSON.stringify(fieldId)} };
      }
      const inputs = Array.from(host.querySelectorAll("input"));
      const target = inputs.find((input) => !input.readOnly && input.type !== "hidden") || inputs[inputs.length - 1];
      if (!target) {
        return { ok: false, error: "editable-input-not-found", fieldId: ${JSON.stringify(fieldId)} };
      }
      target.focus();
      target.value = "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.value = ${JSON.stringify(String(value ?? ""))};
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
      target.blur();
      return {
        ok: true,
        fieldId: ${JSON.stringify(fieldId)},
        value: target.value || ""
      };
    }`
  );
}

async function fillDetailNumberField(cdp, iframeId, { fieldId, rowIndex, value }) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      ${buildDetailVmHelpers(JSON.stringify("formson_0684"))}
      const normalize = normalizeVmText;
      const wantedValue = ${JSON.stringify(String(value ?? ""))};
      const allHosts = Array.from(iframeDocument.querySelectorAll(\`#\${${JSON.stringify(fieldId)}}_id\`));
      const host = allHosts[${JSON.stringify(Math.max(0, rowIndex - 1))}] || null;
      const vmRow = vmRows[Math.max(0, ${JSON.stringify(rowIndex)} - 1)] || null;
      const vmField = vmRow?.lists?.[${JSON.stringify(fieldId)}] || null;
      if (!host) {
        if (!vmField) {
          return {
            ok: false,
            error: "detail-field-host-not-found",
            fieldId: ${JSON.stringify(fieldId)},
            rowIndex: ${JSON.stringify(rowIndex)},
            hostCount: allHosts.length,
            vmRowCount: vmRows.length
          };
        }
        vmField.value = wantedValue;
        vmField.showValue = wantedValue;
        vmField.showValue2 = wantedValue;
        const notified = notifyVmFieldChange(vmRow, ${JSON.stringify(fieldId)}, "change");
        return {
          ok: true,
          fieldId: ${JSON.stringify(fieldId)},
          rowIndex: ${JSON.stringify(rowIndex)},
          value: normalize(vmField.value || ""),
          hostCount: allHosts.length,
          mode: "vm-fallback",
          notified
        };
      }
      const inputs = Array.from(host.querySelectorAll("input"));
      const target = inputs.find((input) => !input.readOnly && input.type !== "hidden") || inputs[inputs.length - 1];
      if (!target) {
        return {
          ok: false,
          error: "detail-editable-input-not-found",
          fieldId: ${JSON.stringify(fieldId)},
          rowIndex: ${JSON.stringify(rowIndex)}
        };
      }
      target.focus();
      target.value = "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.value = wantedValue;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
      target.blur();
      return {
        ok: true,
        fieldId: ${JSON.stringify(fieldId)},
        rowIndex: ${JSON.stringify(rowIndex)},
        value: target.value || "",
        hostCount: allHosts.length
      };
    }`
  );
}

async function clickIframeButtonByText(cdp, iframeId, text) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const wanted = ${JSON.stringify(String(text || "").trim())};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const elements = Array.from(
        iframeDocument.querySelectorAll("button, a, span, div, li")
      );
      const target = elements.find(
        (element) => normalize(element.innerText || element.textContent || "") === wanted
      );
      if (!target) {
        return {
          ok: false,
          error: "iframe-button-not-found",
          wanted,
        };
      }
      const clickable =
        target.closest(".formson-list__button") ||
        target.closest(".cap-btn") ||
        target.closest("button") ||
        target.closest("a") ||
        target;
      clickable.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      clickable.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      clickable.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      clickable.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      if (typeof clickable.click === "function") {
        clickable.click();
      }
      return {
        ok: true,
        wanted,
        tagName: String(clickable.tagName || "").toLowerCase(),
        className: clickable.className || "",
        id: clickable.id || "",
      };
    }`
  );
}

async function countDetailRows(cdp, iframeId, detailTableName) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(detailTableName)};
      const findFormsonVm = () => {
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
            return vm;
          }
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const formsonVm = findFormsonVm();
      const vmRows = Array.isArray(formsonVm?.listTable?.records)
        ? formsonVm.listTable.records.filter((row) => String(row?.recordId || "").trim())
        : [];
      const tableHost =
        iframeDocument.getElementById(tableName) ||
        iframeDocument.querySelector(\`[id="\${tableName}"]\`) ||
        iframeDocument.querySelector(\`[data-table-name="\${tableName}"]\`) ||
        iframeDocument.querySelector(\`section.\${tableName}\`) ||
        iframeDocument.querySelector(\`.\${tableName}\`);
      const rows = tableHost
        ? Array.from(
            tableHost.querySelectorAll(
              "tbody tr[data-record-id], [data-record-id], .formson-list__tr[data-record-id]"
            )
          )
            .filter((row) => String(row.getAttribute("data-record-id") || "").trim())
        : [];
      const recordIds = rows
        .map((row) => String(row.getAttribute("data-record-id") || "").trim())
        .filter(Boolean);
      return {
        ok: true,
        detailTableName: tableName,
        rowCount: Math.max(rows.length, vmRows.length),
        recordIds,
        vmRecordIds: vmRows.map((row) => String(row.recordId || "").trim()).filter(Boolean),
      };
    }`
  );
}

async function readDetailRows(cdp, iframeId, { detailTableName, detailFields = {} }) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(detailTableName)};
      const fields = ${JSON.stringify(detailFields)};
      ${buildDetailVmHelpers("tableName", { declareTableName: false })}
      const tableHost =
        iframeDocument.getElementById(tableName) ||
        iframeDocument.querySelector(\`[id="\${tableName}"]\`) ||
        iframeDocument.querySelector(\`[data-table-name="\${tableName}"]\`) ||
        iframeDocument.querySelector(\`section.\${tableName}\`) ||
        iframeDocument.querySelector(\`.\${tableName}\`);
      if (!tableHost) {
        return {
          ok: false,
          error: "detail-table-not-found",
          detailTableName: tableName,
        };
      }

      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const rows = Array.from(
        tableHost.querySelectorAll(
          "tbody tr[data-record-id], [data-record-id], .formson-list__tr[data-record-id]"
        )
      ).filter((rowElement) => String(rowElement.getAttribute("data-record-id") || "").trim());

      const readFieldHost = (rowElement, fieldId) => {
        const direct = Array.from(rowElement.querySelectorAll(\`#\${fieldId}_id\`))[0];
        if (direct) return direct;
        return rowElement.querySelector(\`[id="\${fieldId}_id"]\`);
      };

      const readFieldValue = (host) => {
        if (!host) {
          return {
            text: "",
            inputValue: "",
            browseText: "",
          };
        }
        const inputs = Array.from(host.querySelectorAll("input"));
        const browseNode =
          host.querySelector(".browse-text") ||
          host.querySelector(".cap4-text__browse span") ||
          host.querySelector(".cap4-people__browse") ||
          host.querySelector(".cap4-field-choose__browse") ||
          host.querySelector(".cap4-select__browse");
        const visibleInput =
          inputs.find((input) => !input.readOnly && input.type !== "hidden") ||
          inputs[inputs.length - 1] ||
          null;
        return {
          text: normalize(host.innerText || host.textContent || ""),
          inputValue: visibleInput ? normalize(visibleInput.value || "") : "",
          browseText: browseNode
            ? normalize(browseNode.innerText || browseNode.textContent || "")
            : "",
        };
      };

      const domRows = rows.map((rowElement, index) => {
          const productCode = readFieldValue(
            readFieldHost(rowElement, fields.productCode || "")
          );
          const quantity = readFieldValue(
            readFieldHost(rowElement, fields.addedQuantity || "")
          );
          const taxPrice = readFieldValue(
            readFieldHost(rowElement, fields.taxPrice || "")
          );
          const changeType = readFieldValue(
            readFieldHost(rowElement, fields.changeType || "")
          );
          return {
            rowIndex: index + 1,
            recordId: String(rowElement.getAttribute("data-record-id") || "").trim(),
            changeType: changeType.inputValue || changeType.browseText || changeType.text,
            productCode:
              productCode.inputValue || productCode.browseText || productCode.text,
            quantity: quantity.inputValue || quantity.browseText || quantity.text,
            taxPrice: taxPrice.inputValue || taxPrice.browseText || taxPrice.text,
            raw: {
              changeType,
              productCode,
              quantity,
              taxPrice,
            },
          };
        });

      if (domRows.length > 0) {
        return {
          ok: true,
          rowCount: domRows.length,
          rows: domRows,
          mode: "dom",
        };
      }

      const vmReadRows = vmRows.map((row, index) => {
        const productCodeField = row?.lists?.[fields.productCode || ""] || null;
        const quantityField = row?.lists?.[fields.addedQuantity || ""] || null;
        const taxPriceField = row?.lists?.[fields.taxPrice || ""] || null;
        const changeTypeField = row?.lists?.[fields.changeType || ""] || null;
        const pickValue = (field) =>
          normalize(field?.showValue || field?.value || field?.showValue2 || "");
        return {
          rowIndex: index + 1,
          recordId: String(row?.recordId || "").trim(),
          changeType: pickValue(changeTypeField),
          productCode: pickValue(productCodeField),
          quantity: pickValue(quantityField),
          taxPrice: pickValue(taxPriceField),
          raw: {
            changeType: changeTypeField
              ? {
                  text: normalize(changeTypeField.display || ""),
                  inputValue: normalize(changeTypeField.value || ""),
                  browseText: normalize(changeTypeField.showValue || ""),
                }
              : { text: "", inputValue: "", browseText: "" },
            productCode: productCodeField
              ? {
                  text: normalize(productCodeField.display || ""),
                  inputValue: normalize(productCodeField.value || ""),
                  browseText: normalize(productCodeField.showValue || ""),
                }
              : { text: "", inputValue: "", browseText: "" },
            quantity: quantityField
              ? {
                  text: normalize(quantityField.display || ""),
                  inputValue: normalize(quantityField.value || ""),
                  browseText: normalize(quantityField.showValue || ""),
                }
              : { text: "", inputValue: "", browseText: "" },
            taxPrice: taxPriceField
              ? {
                  text: normalize(taxPriceField.display || ""),
                  inputValue: normalize(taxPriceField.value || ""),
                  browseText: normalize(taxPriceField.showValue || ""),
                }
              : { text: "", inputValue: "", browseText: "" },
          },
        };
      });

      return {
        ok: true,
        rowCount: vmReadRows.length,
        rows: vmReadRows,
        mode: "vm",
      };
    }`
  );
}

async function setDetailSelectByText(cdp, iframeId, { fieldId, rowIndex, text }) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      ${buildDetailVmHelpers(JSON.stringify("formson_0684"))}
      const normalize = normalizeVmText;
      const wanted = ${JSON.stringify(String(text || "").trim())};
      const wantedRowIndex = ${JSON.stringify(rowIndex)};
      const hosts = Array.from(iframeDocument.querySelectorAll(\`#\${${JSON.stringify(fieldId)}}_id\`));
      const host = hosts[Math.max(0, wantedRowIndex - 1)] || null;
      const vmRow = vmRows[Math.max(0, wantedRowIndex - 1)] || null;
      const vmField = vmRow?.lists?.[${JSON.stringify(fieldId)}] || null;
      if (!host) {
        if (!vmField || !Array.isArray(vmField.enums)) {
          return {
            ok: false,
            error: "detail-select-host-not-found",
            fieldId: ${JSON.stringify(fieldId)},
            rowIndex: wantedRowIndex,
            hostCount: hosts.length,
            vmRowCount: vmRows.length,
          };
        }
        const matchedEnum =
          vmField.enums.find((item) => normalize(item.showValue || "") === wanted) || null;
        if (!matchedEnum) {
          return {
            ok: false,
            error: "detail-select-option-not-found",
            fieldId: ${JSON.stringify(fieldId)},
            rowIndex: wantedRowIndex,
            wanted,
            optionFound: false,
            mode: "vm-fallback"
          };
        }
        vmField.value = String(matchedEnum.id || "");
        vmField.showValue = String(matchedEnum.showValue || wanted);
        vmField.showValue2 = String(matchedEnum.enumValue || "");
        const notified = notifyVmFieldChange(vmRow, ${JSON.stringify(fieldId)}, "select");
        return {
          ok: true,
          fieldId: ${JSON.stringify(fieldId)},
          rowIndex: wantedRowIndex,
          wanted,
          valueAfter: normalize(vmField.value || ""),
          optionFound: true,
          mode: "vm-fallback",
          notified
        };
      }

      const openTrigger =
        host.querySelector(".cap4-select__icon") ||
        host.querySelector(".cap4-field-choose__relation") ||
        host.querySelector(".cap4-select") ||
        host.querySelector("input") ||
        host;

      const fireClick = (element) => {
        if (!element) return;
        element.dispatchEvent(
          new MouseEvent("mouseover", {
            bubbles: true,
            cancelable: true,
            view: iframeWindow,
          })
        );
        element.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            view: iframeWindow,
          })
        );
        element.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            cancelable: true,
            view: iframeWindow,
          })
        );
        element.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: iframeWindow,
          })
        );
        if (typeof element.click === "function") {
          element.click();
        }
      };

      fireClick(openTrigger);

      const optionSelectors = [
        ".cap4-select__dropdown-item",
        ".cap4-select-dropdown__item",
        ".el-select-dropdown__item",
        ".layui-layer-content li",
        "li",
        "div",
        "span",
      ];
      const candidates = Array.from(
        new Set(
          optionSelectors.flatMap((selector) =>
            Array.from(iframeDocument.querySelectorAll(selector))
          )
        )
      );
      const option = candidates.find(
        (element) => normalize(element.innerText || element.textContent || "") === wanted
      );

      if (option) {
        fireClick(option);
      } else {
        const inputs = Array.from(host.querySelectorAll("input"));
        const target =
          inputs.find((input) => !input.readOnly && input.type !== "hidden") ||
          inputs[inputs.length - 1] ||
          null;
        if (!target) {
          return {
            ok: false,
            error: "detail-select-option-not-found",
            fieldId: ${JSON.stringify(fieldId)},
            rowIndex: wantedRowIndex,
            wanted,
          };
        }
        target.focus();
        target.value = wanted;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
          })
        );
        target.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: "Enter",
            bubbles: true,
          })
        );
        target.blur();
      }

      const inputs = Array.from(host.querySelectorAll("input"));
      const visibleInput =
        inputs.find((input) => !input.readOnly && input.type !== "hidden") ||
        inputs[inputs.length - 1] ||
        null;
      return {
        ok: true,
        fieldId: ${JSON.stringify(fieldId)},
        rowIndex: wantedRowIndex,
        wanted,
        valueAfter: visibleInput ? String(visibleInput.value || "").trim() : "",
        optionFound: !!option,
      };
    }`
  );
}

async function clickDetailToolbarButtonByText(cdp, iframeId, { detailTableName, text }) {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => {
      const tableName = ${JSON.stringify(detailTableName)};
      const wanted = ${JSON.stringify(String(text || "").trim())};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const tableSection =
        iframeDocument.querySelector(\`section.\${tableName}\`) ||
        iframeDocument.querySelector(\`.\${tableName}\`) ||
        iframeDocument.getElementById(tableName);
      if (!tableSection) {
        return {
          ok: false,
          error: "detail-table-section-not-found",
          detailTableName: tableName,
          wanted,
        };
      }

      const formsonRoot =
        tableSection.closest("section.formson") ||
        tableSection.closest(".formson") ||
        tableSection.parentElement;
      const toolbarRoot =
        formsonRoot?.querySelector(".formson-toolbar-container") ||
        formsonRoot?.querySelector(".toolbarButton-content") ||
        formsonRoot;
      const candidates = Array.from(
        toolbarRoot.querySelectorAll("button, a, span, div")
      );
      const target = candidates.find(
        (element) => normalize(element.innerText || element.textContent || "") === wanted
      );
      if (!target) {
        return {
          ok: false,
          error: "detail-toolbar-button-not-found",
          detailTableName: tableName,
          wanted,
        };
      }

      const clickable =
        target.closest(".formson-list__button") ||
        target.closest(".cap-btn") ||
        target.closest("button") ||
        target.closest("a") ||
        target;
      clickable.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      clickable.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      clickable.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      clickable.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: iframeWindow,
        })
      );
      if (typeof clickable.click === "function") {
        clickable.click();
      }
      return {
        ok: true,
        detailTableName: tableName,
        wanted,
        tagName: String(clickable.tagName || "").toLowerCase(),
        className: clickable.className || "",
        id: clickable.id || "",
      };
    }`
  );
}

module.exports = {
  getPageFormState,
  inspectFormApiMethods,
  applyBackfillTableData,
  applyProjectRelationTableData,
  readVisibleFieldValues,
  clickFieldRelationTrigger,
  fillMainNumberField,
  fillDetailNumberField,
  clickIframeButtonByText,
  clickDetailToolbarButtonByText,
  countDetailRows,
  readDetailRows,
  setDetailSelectByText,
};
