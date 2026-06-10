"use strict";

const path = require("node:path");

const {
  launchEdge,
  connectToFirstPageTarget,
  getPageTargets,
  CdpClient,
  closeBrowserSession,
  sleep,
} = require("../../core/browser");
const {
  baseUrl,
  loginWithHttp,
  loginWithBrowserForm,
  injectCookiesToCdp,
} = require("../../core/session");
const { navigateToUrl, openFlowPage } = require("../../core/navigation");
const { waitForIframeReady } = require("../../core/wait");
const { evaluateInIframe } = require("../../core/frame");
const {
  getPageFormState,
  readVisibleFieldValues,
} = require("../../core/page-form");
const config = require("./config");
const {
  buildProjectCreateExecutionPlan,
  buildMinimalSaveDraftSample,
} = require("./mapper");
const {
  summarizeObservationRisks,
  validateProjectCreateInput,
} = require("./rules");
const { saveDraftByMouse } = require("../../core/save-draft");

function compactFieldObservation(domField = {}) {
  return {
    fieldId: domField.fieldId,
    label: domField.label || config.fieldLabels[domField.key] || "",
    key: domField.key || "",
    controlType: config.controlTypes[domField.key] || domField.controlType || "unknown",
    text: domField.text || "",
    childClasses: domField.childClasses || [],
    inputs: domField.inputs || [],
  };
}

async function openProjectCreateObservationSession({ runRoot }) {
  let httpSession = null;
  try {
    httpSession = await loginWithHttp({
      scriptDir: path.resolve(__dirname, "..", "..", "legacy"),
    });
  } catch (error) {
    if (/^(0|false|no)$/i.test(String(process.env.A8_BROWSER_FORM_LOGIN_FALLBACK || "").trim())) {
      throw error;
    }
    httpSession = await loginWithBrowserForm({
      runRoot,
      profileDir: path.join(runRoot, "browser-login-profile"),
      headless: true,
    });
  }

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
  const flowOpenResult = await openFlowPage(session.cdp, config);

  return {
    session,
    httpSession,
    flowOpenResult,
  };
}

async function openProjectCreateBaseSession({ runRoot }) {
  let httpSession = null;
  try {
    httpSession = await loginWithHttp({
      scriptDir: path.resolve(__dirname, "..", "..", "legacy"),
    });
  } catch (error) {
    if (/^(0|false|no)$/i.test(String(process.env.A8_BROWSER_FORM_LOGIN_FALLBACK || "").trim())) {
      throw error;
    }
    httpSession = await loginWithBrowserForm({
      runRoot,
      profileDir: path.join(runRoot, "browser-login-profile"),
      headless: true,
    });
  }

  const profileDir = path.join(runRoot, "chrome-profile");
  const edge = await launchEdge({
    profileDir,
    startUrl: "about:blank",
    headless: true,
  });
  const browserSession = await connectToFirstPageTarget(edge.port);
  const session = {
    edge,
    ...browserSession,
    extraCdps: [],
  };

  await injectCookiesToCdp(session.cdp, httpSession.cookies, httpSession.baseUrl);
  return {
    session,
    httpSession,
  };
}

async function observeProjectCreateDom(cdp) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const fields = ${JSON.stringify(config.fields)};
      const keyByField = Object.fromEntries(Object.entries(fields).map(([key, fieldId]) => [fieldId, key]));

      const domFields = Object.entries(fields).map(([key, fieldId]) => {
        const host = iframeDocument.getElementById(fieldId + "_id");
        if (!host) {
          return {
            key,
            fieldId,
            found: false,
            label: "",
            text: "",
            childClasses: [],
            inputs: []
          };
        }
        const childClasses = Array.from(host.querySelectorAll("[class^='cap4-']"))
          .map((node) => String(node.getAttribute("class") || ""))
          .filter(Boolean);
        const inputs = Array.from(host.querySelectorAll("input, textarea, select")).map((node) => ({
          tag: node.tagName,
          id: node.id || "",
          type: node.getAttribute("type") || "",
          className: node.getAttribute("class") || "",
          value: String(node.value || "").trim(),
          readonly: Boolean(node.readOnly || node.getAttribute("readonly") !== null),
          disabled: Boolean(node.disabled || node.getAttribute("disabled") !== null),
        }));
        return {
          key,
          fieldId,
          found: true,
          label: ${JSON.stringify(config.fieldLabels)}[key] || "",
          text: clean(host.innerText || host.textContent),
          childClasses: Array.from(new Set(childClasses)).slice(0, 12),
          inputs,
        };
      });

      const bodyText = clean(iframeDocument.body ? iframeDocument.body.innerText : "");
      const capFields = Array.from(iframeDocument.querySelectorAll(".cap-field[id$='_id']")).map((node) => {
        const id = String(node.id || "").replace(/_id$/, "");
        return {
          fieldId: id,
          key: keyByField[id] || "",
          text: clean(node.innerText || node.textContent),
          className: String(node.getAttribute("class") || "")
        };
      });

      return {
        ok: true,
        href: iframeWindow.location.href,
        title: iframeDocument.title,
        bodyText,
        fields: domFields,
        capFields,
      };
    }`
  );
}

async function snapshotTopPage(cdp, label = "") {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const isVisible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const iframes = Array.from(document.querySelectorAll("iframe")).map((frame, index) => ({
        index,
        id: frame.id || "",
        name: frame.name || "",
        src: frame.src || frame.getAttribute("src") || "",
        visible: isVisible(frame),
      }));
      const dialogs = Array.from(
        document.querySelectorAll(".layui-layer, .layui-layer-content, .layui-layer-title, [role='dialog']")
      ).map((node, index) => ({
        index,
        tag: node.tagName,
        id: node.id || "",
        className: String(node.getAttribute("class") || ""),
        text: clean(node.innerText || node.textContent).slice(0, 1000),
        visible: isVisible(node),
      })).filter((item) => item.visible || item.text);
      const inputs = Array.from(document.querySelectorAll("input, textarea, select")).map((node, index) => ({
        index,
        id: node.id || "",
        name: node.name || "",
        type: node.getAttribute("type") || "",
        value: String(node.value || "").trim(),
        title: node.title || "",
        placeholder: node.getAttribute("placeholder") || "",
        visible: isVisible(node),
      })).filter((item) => item.visible).slice(0, 80);
      const buttons = Array.from(document.querySelectorAll("button, a, span, div")).map((node, index) => {
        const text = clean(node.innerText || node.textContent);
        if (!text || text.length > 80 || !isVisible(node)) return null;
        if (!/(确定|取消|关闭|查询|搜索|清空|选择|部门|人员|客户|省|市|区|县)/.test(text)) return null;
        return {
          index,
          tag: node.tagName,
          id: node.id || "",
          className: String(node.getAttribute("class") || ""),
          text,
        };
      }).filter(Boolean).slice(0, 100);
      return {
        ok: true,
        label: ${JSON.stringify(label)},
        title: document.title,
        url: location.href,
        bodyText: clean(document.body ? document.body.innerText : "").slice(0, 3000),
        iframes,
        dialogs,
        inputs,
        buttons,
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, label, error: "top-snapshot-empty" };
}

async function closeTopLayers(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const clicked = [];
      const fireClick = (element) => {
        if (!element) return false;
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        if (typeof element.click === "function") element.click();
        return true;
      };
      const closeCandidates = Array.from(document.querySelectorAll(
        ".layui-layer-close, .layui-layer-ico, a[title='关闭'], button, a, span"
      ));
      for (const node of closeCandidates) {
        const text = clean(node.innerText || node.textContent || node.title || "");
        const className = String(node.getAttribute("class") || "");
        if (className.includes("layui-layer-close") || text === "取消" || text === "关闭") {
          if (fireClick(node)) {
            clicked.push({ text, className, id: node.id || "" });
          }
        }
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      return { ok: true, clicked };
    })()`,
    returnByValue: true,
  });
  await sleep(400);
  return result.result?.value || { ok: false, error: "close-layers-empty" };
}

async function closeIframeMenus(cdp) {
  const result = await evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      iframeDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      iframeDocument.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      const active = iframeDocument.activeElement;
      if (active && typeof active.blur === "function") active.blur();
      const body = iframeDocument.body;
      if (body) {
        body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: iframeWindow }));
        body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: iframeWindow }));
      }
      return { ok: true };
    }`
  );
  await sleep(300);
  return result;
}

async function openFieldTrigger(cdp, fieldId, triggerKind = "auto") {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const fieldId = ${JSON.stringify(fieldId)};
      const triggerKind = ${JSON.stringify(triggerKind)};
      const host = iframeDocument.getElementById(fieldId + "_id");
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      if (!host) {
        return { ok: false, error: "field-host-not-found", fieldId };
      }
      const isVisible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = iframeWindow.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const fireClick = (element) => {
        if (!element) return false;
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: iframeWindow }));
        if (typeof element.click === "function") element.click();
        return true;
      };
      let trigger = null;
      if (triggerKind === "people") {
        trigger =
          Array.from(host.querySelectorAll(".cap4-people__picker, .cap4-people__right, .cap4-people__cnt, input"))
            .find(isVisible) || null;
      } else if (triggerKind === "select") {
        trigger =
          Array.from(host.querySelectorAll(".cap4-select__icon, .cap4-select__box, input, .cap4-select"))
            .find(isVisible) || null;
      } else {
        trigger =
          Array.from(host.querySelectorAll(".cap4-text__relation, .cap4-field-choose__relation, .cap-icon-zhubiaoxuanzeqi, .cap4-text__right, input"))
            .find(isVisible) || null;
      }
      if (!trigger) trigger = host;
      fireClick(trigger);
      return {
        ok: true,
        fieldId,
        triggerKind,
        hostText: clean(host.innerText || host.textContent),
        triggerTag: trigger.tagName,
        triggerId: trigger.id || "",
        triggerClass: String(trigger.getAttribute("class") || ""),
      };
    }`
  );
}

async function collectIframeMenuSnapshot(cdp, label = "") {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const isVisible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = iframeWindow.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const bodyText = clean(iframeDocument.body ? iframeDocument.body.innerText : "");
      const optionSelectors = [
        ".cap4-select__dropdown-item",
        ".cap4-select-dropdown__item",
        ".el-select-dropdown__item",
        ".cap4-select__item",
        ".cap4-select__option",
        "li",
        "div",
        "span"
      ];
      const options = Array.from(
        new Set(optionSelectors.flatMap((selector) => Array.from(iframeDocument.querySelectorAll(selector))))
      ).map((node) => {
        const text = clean(node.innerText || node.textContent);
        if (!text || text.length > 80 || !isVisible(node)) return null;
        return {
          tag: node.tagName,
          id: node.id || "",
          className: String(node.getAttribute("class") || ""),
          text,
        };
      }).filter(Boolean);
      return {
        ok: true,
        label: ${JSON.stringify(label)},
        bodyText: bodyText.slice(0, 5000),
        options: Array.from(new Map(options.map((item) => [item.text, item])).values()).slice(0, 120),
      };
    }`
  );
}

async function getTopIframeRect(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const iframe = document.getElementById(${JSON.stringify(config.iframeId)});
      if (!iframe) return { ok: false, error: "iframe-not-found" };
      const rect = iframe.getBoundingClientRect();
      return {
        ok: true,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, error: "iframe-rect-empty" };
}

async function clickIframePoint(cdp, point) {
  const iframeRect = await getTopIframeRect(cdp);
  if (!iframeRect.ok) {
    return { ok: false, error: "iframe-rect-failed", iframeRect };
  }
  return clickPagePoint(cdp, {
    x: iframeRect.left + point.x,
    y: iframeRect.top + point.y,
  });
}

async function getSelectTriggerPoint(cdp, fieldId) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const fieldId = ${JSON.stringify(fieldId)};
      const isVisible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = iframeWindow.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const host = iframeDocument.getElementById(fieldId + "_id");
      if (!host) return { ok: false, error: "field-host-not-found", fieldId };
      const trigger =
        Array.from(host.querySelectorAll(".cap4-select__icon, .cap4-select__box, input, .cap4-select"))
          .find(isVisible) || host;
      try {
        trigger.scrollIntoView({ block: "center", inline: "center" });
      } catch (_error) {
        // ignore
      }
      const rect = trigger.getBoundingClientRect();
      return {
        ok: true,
        fieldId,
        triggerTag: trigger.tagName,
        triggerClass: String(trigger.getAttribute("class") || ""),
        point: {
          x: rect.left + Math.min(Math.max(rect.width - 8, 4), Math.max(rect.width / 2, 4)),
          y: rect.top + rect.height / 2,
        },
      };
    }`
  );
}

async function getSelectOptionPoint(cdp, wanted) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const wanted = ${JSON.stringify(String(wanted || "").trim())};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const isRenderable = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = iframeWindow.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const optionSelectors = [
        ".cap4-select__dropdown-item",
        ".cap4-select-dropdown__item",
        ".cap4-select-list li",
        ".cap4-select__item",
        ".cap4-select__option",
        ".el-select-dropdown__item",
        ".layui-layer-content li",
        "li",
        "div",
        "span"
      ];
      const candidates = Array.from(
        new Set(optionSelectors.flatMap((selector) => Array.from(iframeDocument.querySelectorAll(selector))))
      ).filter((node) => {
        const text = clean(node.innerText || node.textContent);
        return text && text.length <= 80;
      });
      const matchesWanted = (text) => text === wanted || (wanted.length >= 2 && text.includes(wanted));
      const option =
        candidates.find((node) => clean(node.innerText || node.textContent) === wanted) ||
        candidates.find((node) => matchesWanted(clean(node.innerText || node.textContent))) ||
        null;
      if (!option) {
        return {
          ok: false,
          error: "option-not-found",
          wanted,
          visibleTexts: candidates
            .filter(isRenderable)
            .map((node) => clean(node.innerText || node.textContent))
            .filter(Boolean)
            .slice(0, 120),
          allTexts: candidates
            .map((node) => clean(node.innerText || node.textContent))
            .filter(Boolean)
            .slice(0, 120),
        };
      }
      try {
        option.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_error) {
        // ignore
      }
      const rect = option.getBoundingClientRect();
      if (!isRenderable(option)) {
        return {
          ok: false,
          error: "option-not-renderable",
          wanted,
          optionText: clean(option.innerText || option.textContent),
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        };
      }
      return {
        ok: true,
        wanted,
        optionText: clean(option.innerText || option.textContent),
        optionClass: String(option.getAttribute("class") || ""),
        point: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        },
      };
    }`
  );
}

async function clickSelectOptionByDom(cdp, fieldId, wanted) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const wanted = ${JSON.stringify(String(wanted || "").trim())};
      const fieldId = ${JSON.stringify(fieldId)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const fireClick = (element) => {
        if (!element) return false;
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: iframeWindow }));
        if (typeof element.click === "function") element.click();
        return true;
      };
      const optionSelectors = [
        ".cap4-scontent__item",
        ".cap4-select__dropdown-item",
        ".cap4-select-dropdown__item",
        ".cap4-select-list li",
        ".cap4-select__item",
        ".cap4-select__option",
        ".el-select-dropdown__item",
        ".layui-layer-content li",
        "li",
        "div",
        "span"
      ];
      const candidates = Array.from(
        new Set(optionSelectors.flatMap((selector) => Array.from(iframeDocument.querySelectorAll(selector))))
      ).filter((node) => {
        const text = clean(node.innerText || node.textContent);
        return text && text.length <= 80;
      });
      const matchesWanted = (text) => text === wanted || (wanted.length >= 2 && text.includes(wanted));
      const option =
        candidates.find((node) => clean(node.innerText || node.textContent) === wanted) ||
        candidates.find((node) => matchesWanted(clean(node.innerText || node.textContent))) ||
        null;
      if (!option) {
        return {
          ok: false,
          error: "option-not-found",
          wanted,
          allTexts: candidates.map((node) => clean(node.innerText || node.textContent)).filter(Boolean).slice(0, 120),
        };
      }
      try {
        option.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_error) {
        // ignore
      }
      const clicked = fireClick(option);
      const host = iframeDocument.getElementById(fieldId + "_id");
      const input = host ? host.querySelector("input") : null;
      return {
        ok: clicked,
        wanted,
        optionText: clean(option.innerText || option.textContent),
        fieldId,
        inputValueAfter: input ? String(input.value || "").trim() : "",
        hostTextAfter: host ? clean(host.innerText || host.textContent) : "",
      };
    }`
  );
}

async function selectMainOptionByText(cdp, fieldId, wanted) {
  const triggerPoint = await getSelectTriggerPoint(cdp, fieldId);
  const nativeOpen =
    triggerPoint?.ok && triggerPoint.point
      ? await clickIframePoint(cdp, triggerPoint.point)
      : { ok: false, error: "trigger-point-unavailable", triggerPoint };
  const openResult = nativeOpen.ok
    ? { ok: true, fieldId, triggerKind: "select", mode: "native", triggerPoint, nativeOpen }
    : await openFieldTrigger(cdp, fieldId, "select");
  await sleep(500);
  const optionPoint = await getSelectOptionPoint(cdp, wanted);
  if (optionPoint?.ok && optionPoint.point) {
    const domOptionClick = await clickSelectOptionByDom(cdp, fieldId, wanted);
    await sleep(800);
    const domReadResult = await evaluateInIframe(
      cdp,
      config.iframeId,
      `(iframeWindow, iframeDocument) => {
        const fieldId = ${JSON.stringify(fieldId)};
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const host = iframeDocument.getElementById(fieldId + "_id");
        const input = host ? host.querySelector("input") : null;
        return {
          ok: true,
          fieldId,
          hostTextAfter: host ? clean(host.innerText || host.textContent) : "",
          inputValueAfter: input ? String(input.value || "").trim() : "",
        };
      }`
    );
    const domInputValue = String(domReadResult?.inputValueAfter || domReadResult?.result?.value?.inputValueAfter || "").trim();
    const domReadValue = domReadResult?.result?.value || domReadResult;
    const domActualValue = String(domReadValue?.inputValueAfter || "").trim();
    const domWantedValue = String(wanted || "").trim();
    if (domActualValue === domWantedValue || (domWantedValue.length >= 2 && domActualValue.includes(domWantedValue))) {
      return {
        openResult,
        optionPoint,
        domOptionClick,
        selectResult: {
          ok: true,
          fieldId,
          wanted,
          mode: "dom-option-after-native-open",
          readResult: domReadValue,
        },
      };
    }
    const nativeOptionClick = await clickIframePoint(cdp, optionPoint.point);
    await sleep(800);
    const readResult = await evaluateInIframe(
      cdp,
      config.iframeId,
      `(iframeWindow, iframeDocument) => {
        const fieldId = ${JSON.stringify(fieldId)};
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const host = iframeDocument.getElementById(fieldId + "_id");
        const input = host ? host.querySelector("input") : null;
        return {
          ok: true,
          fieldId,
          hostTextAfter: host ? clean(host.innerText || host.textContent) : "",
          inputValueAfter: input ? String(input.value || "").trim() : "",
        };
      }`
    );
    return {
      openResult,
      optionPoint,
      domOptionClick,
      domReadResult: domReadValue,
      nativeOptionClick,
      selectResult: {
        ok: Boolean(nativeOptionClick?.ok),
        fieldId,
        wanted,
        mode: "native",
        readResult,
      },
    };
  }

  const result = await evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const wanted = ${JSON.stringify(String(wanted || "").trim())};
      const fieldId = ${JSON.stringify(fieldId)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const isVisible = (node) => {
        if (!node || !node.getBoundingClientRect) return false;
        const rect = node.getBoundingClientRect();
        const style = iframeWindow.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const fireClick = (element) => {
        if (!element) return false;
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: iframeWindow }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: iframeWindow }));
        if (typeof element.click === "function") element.click();
        return true;
      };
      const candidates = Array.from(
        new Set([
          ...iframeDocument.querySelectorAll(".cap4-select__dropdown-item"),
          ...iframeDocument.querySelectorAll(".cap4-select-dropdown__item"),
          ...iframeDocument.querySelectorAll(".el-select-dropdown__item"),
          ...iframeDocument.querySelectorAll(".cap4-select__item"),
          ...iframeDocument.querySelectorAll(".cap4-select__option"),
          ...iframeDocument.querySelectorAll("li"),
          ...iframeDocument.querySelectorAll("div"),
          ...iframeDocument.querySelectorAll("span")
        ])
      );
      const matchesWanted = (text) => text === wanted || (wanted.length >= 2 && text.includes(wanted));
      const option =
        candidates.find((node) => isVisible(node) && clean(node.innerText || node.textContent) === wanted) ||
        candidates.find((node) => isVisible(node) && matchesWanted(clean(node.innerText || node.textContent)));
      if (!option) {
        return {
          ok: false,
          error: "option-not-found",
          fieldId,
          wanted,
          visibleTexts: candidates
            .filter(isVisible)
            .map((node) => clean(node.innerText || node.textContent))
            .filter(Boolean)
            .slice(0, 100),
        };
      }
      fireClick(option);
      const host = iframeDocument.getElementById(fieldId + "_id");
      const input = host ? host.querySelector("input") : null;
      return {
        ok: true,
        fieldId,
        wanted,
        optionText: clean(option.innerText || option.textContent),
        hostTextAfter: host ? clean(host.innerText || host.textContent) : "",
        inputValueAfter: input ? String(input.value || "").trim() : "",
      };
    }`
  );
  await sleep(800);
  return {
    openResult,
    optionPoint,
    selectResult: result,
  };
}

async function connectToTarget(target) {
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("target webSocketDebuggerUrl missing");
  }
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  return cdp;
}

async function clickPagePoint(cdp, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { ok: false, error: "invalid-click-point", point };
  }
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
  return { ok: true, point };
}

async function collectWaitsendProjectCreateRows(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("tr")).map((row, index) => {
        const text = clean(row.innerText || row.textContent);
        const checkbox = row.querySelector("input[type='checkbox']");
        const link = row.querySelector("a");
        const attrs = {};
        for (const attr of row.attributes || []) attrs[attr.name] = attr.value;
        const linkAttrs = {};
        for (const attr of link?.attributes || []) linkAttrs[attr.name] = attr.value;
        return {
          index,
          text,
          attrs,
          checkboxValue: checkbox ? String(checkbox.value || "") : "",
          linkText: link ? clean(link.innerText || link.textContent) : "",
          linkAttrs,
        };
      }).filter((row) => row.text.includes("项目创建"));
    })()`,
    returnByValue: true,
  });
  return result.result?.value || [];
}

async function openProjectCreateWaitsendDraft({ cdp, browserPort }) {
  const waitsendUrl = `${baseUrl}/seeyon/collaboration/collaboration.do?method=listWaitSend`;
  await navigateToUrl(cdp, waitsendUrl, { timeoutMs: 30000 });
  await sleep(800);

  const rows = await collectWaitsendProjectCreateRows(cdp);
  const row = rows.find((item) => item.linkText.startsWith("【项目创建】")) || rows[0] || null;
  if (!row?.checkboxValue) {
    return {
      ok: false,
      error: "project-create-waitsend-row-not-found",
      rows,
    };
  }

  const beforeTargets = await getPageTargets(browserPort);
  const pointResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const affairId = ${JSON.stringify(row.checkboxValue)};
      const checkbox = Array.from(document.querySelectorAll("input[type='checkbox']")).find((node) => String(node.value || "") === affairId);
      if (!checkbox) return { ok: false, error: "checkbox-not-found", affairId };
      const edit = document.getElementById("edit_a") ||
        Array.from(document.querySelectorAll("a,span,div")).find((node) => String(node.innerText || node.textContent || "").trim() === "编辑");
      if (!edit) return { ok: false, error: "edit-button-not-found", affairId, checked: checkbox.checked };
      checkbox.scrollIntoView({ block: "center", inline: "center" });
      edit.scrollIntoView({ block: "center", inline: "center" });
      const checkboxRect = checkbox.getBoundingClientRect();
      const editRect = edit.getBoundingClientRect();
      return {
        ok: true,
        affairId,
        checkedBefore: checkbox.checked,
        checkboxPoint: {
          x: checkboxRect.left + checkboxRect.width / 2,
          y: checkboxRect.top + checkboxRect.height / 2,
        },
        editPoint: {
          x: editRect.left + editRect.width / 2,
          y: editRect.top + editRect.height / 2,
        },
      };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || { ok: false });

  if (!pointResult?.ok) {
    return {
      ok: false,
      error: "edit-click-point-failed",
      pointResult,
      row,
      rows,
    };
  }

  const checkboxClick = await clickPagePoint(cdp, pointResult.checkboxPoint);
  await sleep(500);
  const checkedAfter = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const affairId = ${JSON.stringify(row.checkboxValue)};
      const checkbox = Array.from(document.querySelectorAll("input[type='checkbox']")).find((node) => String(node.value || "") === affairId);
      return { ok: !!checkbox, checked: !!checkbox?.checked, affairId };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || { ok: false });
  const editClick = await clickPagePoint(cdp, pointResult.editPoint);

  const deadline = Date.now() + 30000;
  let selectedTarget = null;
  let targets = [];
  while (Date.now() < deadline) {
    targets = await getPageTargets(browserPort);
    selectedTarget =
      targets.find((target) =>
        target.type === "page" &&
        String(target.url || "").includes("from=waitSend") &&
        String(target.url || "").includes(`affairId=${row.checkboxValue}`)
      ) ||
      targets.find((target) =>
        target.type === "page" &&
        String(target.url || "").includes("method=newColl") &&
        String(target.url || "").includes("from=waitSend") &&
        !beforeTargets.some((oldTarget) => oldTarget.id === target.id)
      );
    if (selectedTarget?.webSocketDebuggerUrl) break;
    await sleep(500);
  }

  if (!selectedTarget?.webSocketDebuggerUrl) {
    return {
      ok: false,
      error: "waitsend-edit-target-not-found",
      row,
      clickResult: {
        pointResult,
        checkboxClick,
        checkedAfter,
        editClick,
      },
      targets,
    };
  }

  const draftCdp = await connectToTarget(selectedTarget);
  await waitForIframeReady(draftCdp, config.iframeId, {
    timeoutMs: config.iframeLoadTimeoutMs,
  });

  return {
    ok: true,
    row,
    target: {
      id: selectedTarget.id,
      title: selectedTarget.title,
      url: selectedTarget.url,
    },
    cdp: draftCdp,
    clickResult: {
      pointResult,
      checkboxClick,
      checkedAfter,
      editClick,
    },
  };
}

async function setProjectCreateRegion(cdp, regionInput = {}) {
  const province = String(regionInput.province || "湖南省").trim();
  const city = String(regionInput.city || "株洲市").trim();
  const district = String(regionInput.district || regionInput.county || "攸县").trim();

  const before = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);
  const selectProvince = await selectMainOptionByText(cdp, config.fields.province, province);
  const afterProvince = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);
  const selectCity = await selectMainOptionByText(cdp, config.fields.city, city);
  const afterCity = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);
  const selectDistrict = await selectMainOptionByText(cdp, config.fields.district, district);
  const afterDistrict = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);

  return {
    requested: { province, city, district },
    before,
    selectProvince,
    afterProvince,
    selectCity,
    afterCity,
    selectDistrict,
    afterDistrict,
  };
}

async function readProjectCreateMainControls(cdp, fieldIds = Object.values(config.fields)) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow) => {
      const api = iframeWindow.thirdPartyFormAPI;
      if (!api || typeof api.getFormData !== "function") {
        return { ok: false, error: "thirdPartyFormAPI.getFormData-unavailable" };
      }
      const fieldIds = ${JSON.stringify(fieldIds)};
      const mainTableName = ${JSON.stringify(config.mainTableName)};
      try {
        const formData = api.getFormData();
        const controls = formData?.formmains?.[mainTableName] || {};
        const result = {};
        for (const fieldId of fieldIds) {
          const control = controls[fieldId] || null;
          result[fieldId] = control ? JSON.parse(JSON.stringify(control)) : null;
        }
        return {
          ok: true,
          mainTableName,
          fields: result,
        };
      } catch (error) {
        return {
          ok: false,
          error: "read-main-controls-failed",
          message: String(error),
        };
      }
    }`
  );
}

async function fillMainTextField(cdp, fieldId, value) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const fieldId = ${JSON.stringify(fieldId)};
      const wanted = ${JSON.stringify(String(value ?? ""))};
      const host = iframeDocument.getElementById(fieldId + "_id");
      if (!host) return { ok: false, error: "field-host-not-found", fieldId };
      const target =
        Array.from(host.querySelectorAll("textarea, input"))
          .find((node) => !node.readOnly && node.type !== "hidden" && !node.disabled) ||
        Array.from(host.querySelectorAll("textarea, input")).find((node) => node.type !== "hidden") ||
        null;
      if (!target) return { ok: false, error: "editable-input-not-found", fieldId };
      try {
        target.scrollIntoView({ block: "center", inline: "center" });
      } catch (_error) {
        // ignore
      }
      target.focus();
      target.value = "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.value = wanted;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
      target.blur();

      const api = iframeWindow.thirdPartyFormAPI;
      let patchedState = false;
      try {
        const formData = typeof api?.getFormData === "function" ? api.getFormData() : null;
        const field = formData?.formmains?.[${JSON.stringify(config.mainTableName)}]?.[fieldId];
        if (field && typeof field === "object") {
          field.value = wanted;
          field.showValue = wanted;
          field.showValue2 = wanted;
          patchedState = true;
        }
      } catch (_error) {
        // ignore
      }

      return {
        ok: true,
        fieldId,
        value: target.value || "",
        patchedState,
      };
    }`
  );
}

function buildControlPatchFromBaseline(control, wantedText = "") {
  if (!control || typeof control !== "object") {
    return null;
  }
  const patch = {};
  for (const key of [
    "value",
    "showValue",
    "showValue2",
    "relationInfo",
    "relationData",
    "triggerData",
    "dataInfo",
    "display",
  ]) {
    if (Object.prototype.hasOwnProperty.call(control, key)) {
      patch[key] = control[key];
    }
  }
  if (wantedText && !String(patch.showValue || patch.display || "").includes(wantedText)) {
    return null;
  }
  return patch;
}

function matchesKnownAlias(wantedText, aliases = [], displayText = "") {
  const wanted = String(wantedText || "").trim();
  if (!wanted) return false;
  const candidates = [...aliases, displayText]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return candidates.some((candidate) => candidate === wanted || candidate.includes(wanted) || wanted.includes(candidate));
}

function buildKnownControlPatch(key, control, wantedText = "") {
  const defaults = config.knownControlDefaults || {};
  const source =
    key === "customerName"
      ? (defaults.customers || []).find((item) => matchesKnownAlias(wantedText, item.aliases, item.showValue))
      : (defaults.people?.[key] || []).find((item) => matchesKnownAlias(wantedText, item.aliases, item.showValue));
  if (!source) {
    return null;
  }

  return {
    value: source.value,
    showValue: source.showValue,
    showValue2: source.showValue2 || source.showValue,
    relationInfo: Array.isArray(control?.relationInfo) ? control.relationInfo : [],
    relationData:
      control?.relationData && typeof control.relationData === "object"
        ? control.relationData
        : {},
    triggerData:
      control?.triggerData && typeof control.triggerData === "object"
        ? control.triggerData
        : {},
    display: control?.display || config.fieldLabels[key] || "",
  };
}

function buildProjectCreateControlPatch(key, control, wantedText = "") {
  return buildControlPatchFromBaseline(control, wantedText) || buildKnownControlPatch(key, control, wantedText);
}

async function applyProjectCreateMainControlPatches(cdp, patches = {}) {
  return evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const patches = ${JSON.stringify(patches)};
      const mainTableName = ${JSON.stringify(config.mainTableName)};
      const api = iframeWindow.thirdPartyFormAPI;
      if (!api || typeof api.getFormData !== "function") {
        return { ok: false, error: "thirdPartyFormAPI.getFormData-unavailable" };
      }
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
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
      const forceVmUpdate = (host) => {
        let currentVm = getNearestVue(host);
        let count = 0;
        while (currentVm && count < 8) {
          try {
            if (typeof currentVm.$forceUpdate === "function") currentVm.$forceUpdate();
          } catch (_error) {
            // ignore
          }
          currentVm = currentVm.$parent || null;
          count += 1;
        }
      };
      let formData = null;
      try {
        formData = api.getFormData();
      } catch (error) {
        return { ok: false, error: "getFormData-failed", message: String(error) };
      }
      const controls = formData?.formmains?.[mainTableName] || {};
      const result = {};
      for (const [fieldId, patch] of Object.entries(patches)) {
        const control = controls[fieldId];
        const host = iframeDocument.getElementById(fieldId + "_id");
        if (!control || typeof control !== "object") {
          result[fieldId] = { ok: false, error: "control-not-found" };
          continue;
        }
        Object.assign(control, patch || {});
        const displayValue = clean(
          patch?.showValue ||
          patch?.display ||
          patch?.showValue2 ||
          patch?.value ||
          ""
        );
        if (host && displayValue) {
          const input = host.querySelector("input");
          if (input) {
            input.value = displayValue;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          for (const node of host.querySelectorAll(".browse-text, .cap4-text__browse span, .cap4-people__browse, .cap4-field-choose__browse, .cap4-select__browse")) {
            node.textContent = displayValue;
          }
          forceVmUpdate(host);
        }
        result[fieldId] = {
          ok: true,
          value: control.value || "",
          showValue: control.showValue || "",
          showValue2: control.showValue2 || "",
          displayValue,
        };
      }
      return { ok: true, fields: result };
    }`
  );
}

function normalizeMoneyForCompare(value) {
  const text = String(value || "").replace(/,/g, "").trim();
  const number = Number(text);
  return Number.isFinite(number) ? String(number) : text;
}

function extractReadValue(readback, controls, fieldId) {
  const visible = readback?.fields?.[fieldId] || {};
  const control = controls?.fields?.[fieldId] || {};
  return String(
    visible.browseText ||
    visible.inputValue ||
    visible.text ||
    control.showValue ||
    control.display ||
    control.value ||
    ""
  ).trim();
}

function buildProjectCreateSaveGate({ input, readback, controls }) {
  const fields = config.fields;
  const actual = {
    projectName: extractReadValue(readback, controls, fields.projectName),
    projectDescription: extractReadValue(readback, controls, fields.projectDescription),
    customerName: extractReadValue(readback, controls, fields.customerName),
    sales: extractReadValue(readback, controls, fields.sales),
    business: extractReadValue(readback, controls, fields.business),
    presales: extractReadValue(readback, controls, fields.presales),
    winRate: extractReadValue(readback, controls, fields.winRate),
    progress: extractReadValue(readback, controls, fields.progress),
    estimatedAmount: extractReadValue(readback, controls, fields.estimatedAmount),
    province: extractReadValue(readback, controls, fields.province),
    city: extractReadValue(readback, controls, fields.city),
    district: extractReadValue(readback, controls, fields.district),
  };
  const expected = {
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    customerName: input.customerName,
    sales: input.sales,
    business: input.business,
    presales: input.presales,
    winRate: input.winRate,
    progress: input.progress,
    estimatedAmount: input.estimatedAmount,
    province: input.province,
    city: input.city,
    district: input.district,
  };
  const containsKeys = new Set(["customerName", "sales", "business", "presales", "district"]);
  const mismatches = Object.entries(expected)
    .filter(([key, wanted]) => {
      if (!String(wanted || "").trim()) return false;
      if (key === "estimatedAmount") {
        return normalizeMoneyForCompare(actual[key]) !== normalizeMoneyForCompare(wanted);
      }
      if (containsKeys.has(key)) {
        return !String(actual[key] || "").includes(String(wanted || "").trim());
      }
      return String(actual[key] || "").trim() !== String(wanted || "").trim();
    })
    .map(([key, wanted]) => ({
      key,
      wanted,
      actual: actual[key] || "",
      fieldId: fields[key],
    }));
  return {
    ok: mismatches.length === 0,
    expected,
    actual,
    mismatches,
  };
}

async function runProjectCreateSaveDraft({ input = {}, mode = "fast", runRoot }) {
  const runMode = ["fast", "normal", "debug"].includes(String(mode || "").toLowerCase())
    ? String(mode || "").toLowerCase()
    : "fast";
  const normalizedInput = {
    projectName: String(input.projectName ?? "").trim(),
    customerName: String(input.customerName ?? "").trim(),
    projectDescription: String(input.projectDescription ?? "").trim(),
    sales: String(input.sales ?? "").trim(),
    business: String(input.business ?? "").trim(),
    presales: String(input.presales ?? "").trim(),
    winRate: String(input.winRate ?? "").trim(),
    progress: String(input.progress ?? "").trim(),
    estimatedAmount: String(input.estimatedAmount ?? "").trim(),
    province: String(input.province ?? "").trim(),
    city: String(input.city ?? "").trim(),
    district: String(input.district ?? input.county ?? "").trim(),
  };

  let opened = null;
  let draftCdp = null;
  try {
    opened = await openProjectCreateBaseSession({ runRoot });
    const { session } = opened;
    let baselineOpen = await openProjectCreateWaitsendDraft({
      cdp: session.cdp,
      browserPort: session.edge.port,
    });

    let baselineControls = null;
    let baselineVisible = null;
    let controlSource = "waitsend-baseline";
    let flowOpenResult = null;
    let before = null;

    if (baselineOpen?.ok) {
      draftCdp = baselineOpen.cdp;
      session.extraCdps.push(draftCdp);
      baselineControls = await readProjectCreateMainControls(draftCdp, [
        config.fields.customerName,
        config.fields.sales,
        config.fields.business,
        config.fields.presales,
      ]);
      baselineVisible = await readVisibleFieldValues(draftCdp, config.iframeId, [
        config.fields.customerName,
        config.fields.sales,
        config.fields.business,
        config.fields.presales,
      ]);

      flowOpenResult = await openFlowPage(session.cdp, config);
      await waitForIframeReady(session.cdp, config.iframeId, {
        timeoutMs: config.iframeLoadTimeoutMs,
      });
      before = await readVisibleFieldValues(session.cdp, config.iframeId, Object.values(config.fields));
    } else {
      controlSource = "empty-template-known-defaults";
      flowOpenResult = await openFlowPage(session.cdp, config);
      await waitForIframeReady(session.cdp, config.iframeId, {
        timeoutMs: config.iframeLoadTimeoutMs,
      });
      before = await readVisibleFieldValues(session.cdp, config.iframeId, Object.values(config.fields));
      baselineControls = await readProjectCreateMainControls(session.cdp, [
        config.fields.customerName,
        config.fields.sales,
        config.fields.business,
        config.fields.presales,
      ]);
      baselineVisible = await readVisibleFieldValues(session.cdp, config.iframeId, [
        config.fields.customerName,
        config.fields.sales,
        config.fields.business,
        config.fields.presales,
      ]);
      baselineOpen = {
        ...baselineOpen,
        ok: true,
        fallback: controlSource,
        originalOk: false,
      };
    }

    const patches = {
      [config.fields.customerName]: buildProjectCreateControlPatch(
        "customerName",
        baselineControls?.fields?.[config.fields.customerName],
        normalizedInput.customerName
      ),
      [config.fields.sales]: buildProjectCreateControlPatch(
        "sales",
        baselineControls?.fields?.[config.fields.sales],
        normalizedInput.sales
      ),
      [config.fields.business]: buildProjectCreateControlPatch(
        "business",
        baselineControls?.fields?.[config.fields.business],
        normalizedInput.business
      ),
      [config.fields.presales]: buildProjectCreateControlPatch(
        "presales",
        baselineControls?.fields?.[config.fields.presales],
        normalizedInput.presales
      ),
    };
    const missingPatches = Object.entries(patches)
      .filter(([, patch]) => !patch)
      .map(([fieldId]) => fieldId);
    if (missingPatches.length > 0) {
      return {
        ok: false,
        stage: "baseline-control-patch",
        mode: runMode,
        missingPatches,
        baselineOpen: { ...baselineOpen, cdp: undefined },
        baselineVisible,
        controlSource,
        missingPatchDetails: missingPatches.map((fieldId) => ({
          fieldId,
          label: config.fieldLabels[Object.entries(config.fields).find(([, value]) => value === fieldId)?.[0]] || fieldId,
          reason: "No wait-send baseline value matched the input and no known default mapping exists.",
        })),
        saveDraftTouched: false,
      };
    }
    const fillProjectName = await fillMainTextField(session.cdp, config.fields.projectName, normalizedInput.projectName);
    const fillProjectDescription = await fillMainTextField(
      session.cdp,
      config.fields.projectDescription,
      normalizedInput.projectDescription
    );
    const applyBaselinePatches = await applyProjectCreateMainControlPatches(session.cdp, patches);
    const selectWinRate = await selectMainOptionByText(session.cdp, config.fields.winRate, normalizedInput.winRate);
    const selectProgress = await selectMainOptionByText(session.cdp, config.fields.progress, normalizedInput.progress);
    const fillAmount = await fillMainTextField(session.cdp, config.fields.estimatedAmount, normalizedInput.estimatedAmount);
    const regionResult = await setProjectCreateRegion(session.cdp, normalizedInput);

    const after = await readVisibleFieldValues(session.cdp, config.iframeId, Object.values(config.fields));
    const afterControls = await readProjectCreateMainControls(session.cdp, Object.values(config.fields));
    const saveGate = buildProjectCreateSaveGate({
      input: normalizedInput,
      readback: after,
      controls: afterControls,
    });
    if (!saveGate.ok) {
      return {
        ok: false,
        stage: "pre-save-gate",
        mode: runMode,
        input: normalizedInput,
        baselineOpen: { ...baselineOpen, cdp: undefined },
        flowOpenResult,
        before,
        baselineVisible,
        controlSource,
        fillResults: {
          fillProjectName,
          fillProjectDescription,
          applyBaselinePatches,
          selectWinRate,
          selectProgress,
          fillAmount,
          regionResult,
        },
        after,
        afterControls,
        saveGate,
        saveDraftTouched: false,
      };
    }

    const saveResult = await saveDraftByMouse(session.cdp, {
      timeoutMs: 45000,
    });
    return {
      ok: Boolean(saveResult?.ok),
      stage: saveResult?.ok ? "save-draft-completed" : "save-draft-failed",
      flow: "project_create_save_draft",
      mode: runMode,
      businessName: config.businessName,
      input: normalizedInput,
      baselineOpen: { ...baselineOpen, cdp: undefined },
      flowOpenResult,
      before,
      baselineVisible,
      controlSource,
      fillResults: {
        fillProjectName,
        fillProjectDescription,
        applyBaselinePatches,
        selectWinRate,
        selectProgress,
        fillAmount,
        regionResult,
      },
      after,
      afterControls,
      saveGate,
      saveResult,
      saveDraftTouched: Boolean(saveResult?.ok),
    };
  } finally {
    if (opened?.session) {
      await closeBrowserSession(opened.session).catch(() => {});
    } else if (draftCdp) {
      await draftCdp.close().catch(() => {});
    }
  }
}

async function probeProjectCreateRegionRuntimeState(cdp) {
  const visible = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);
  const runtime = await evaluateInIframe(
    cdp,
    config.iframeId,
    `(iframeWindow, iframeDocument) => {
      const mainTableName = ${JSON.stringify(config.mainTableName)};
      const fields = ${JSON.stringify({
        province: config.fields.province,
        city: config.fields.city,
        district: config.fields.district,
      })};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const api = iframeWindow.thirdPartyFormAPI;
      const summarizeEnum = (item) => ({
        id: item?.id ?? "",
        enumValue: item?.enumValue ?? "",
        showValue: item?.showValue ?? "",
        value: item?.value ?? "",
        parentId: item?.parentId ?? item?.parentid ?? item?.parentValue ?? "",
        level: item?.level ?? "",
        url: item?.url ?? "",
        inputState: item?.inputState ?? "",
        outputState: item?.outputState ?? "",
        color: item?.color ?? "",
        rawKeys: item && typeof item === "object" ? Object.keys(item).slice(0, 20) : [],
      });
      const compact = (value, depth = 0) => {
        if (value == null) return value;
        if (typeof value !== "object") {
          return typeof value === "string" ? clean(value).slice(0, 240) : value;
        }
        if (Array.isArray(value)) {
          return value.slice(0, 12).map((item) => compact(item, depth + 1));
        }
        const result = {};
        for (const [key, child] of Object.entries(value).slice(0, 80)) {
          if (typeof child === "function") {
            result[key] = "[function]";
          } else if (/^(enums|enumList|items|children|options|sourceData)$/i.test(key) && Array.isArray(child)) {
            result[key] = child.slice(0, 40).map(summarizeEnum);
            result[key + "Count"] = child.length;
          } else if (depth >= 2) {
            if (child == null || typeof child !== "object") {
              result[key] = compact(child, depth + 1);
            } else if (Array.isArray(child)) {
              result[key] = "[array:" + child.length + "]";
            } else {
              result[key] = "{object:" + Object.keys(child).slice(0, 20).join(",") + "}";
            }
          } else {
            result[key] = compact(child, depth + 1);
          }
        }
        return result;
      };
      const nearestVue = (node) => {
        let current = node;
        let depth = 0;
        while (current && depth < 12) {
          if (current.__vue__) return current.__vue__;
          current = current.parentElement;
          depth += 1;
        }
        return null;
      };
      const summarizeVm = (vm, depth) => {
        if (!vm || depth > 8) return null;
        const optionMethods = vm.$options?.methods ? Object.keys(vm.$options.methods).slice(0, 50) : [];
        const ownMethods = Object.keys(vm || {})
          .filter((key) => typeof vm[key] === "function")
          .slice(0, 30);
        return {
          depth,
          name: vm.$options?.name || "",
          keys: Object.keys(vm || {}).slice(0, 60),
          propsData: compact(vm.$options?.propsData || {}, 1),
          data: compact(vm.$data || {}, 1),
          optionMethods,
          ownMethods,
        };
      };
      const summarizeDomField = (fieldId) => {
        const host = iframeDocument.getElementById(fieldId + "_id");
        if (!host) return { found: false, fieldId };
        const inputs = Array.from(host.querySelectorAll("input, textarea, select")).map((node) => ({
          tag: node.tagName,
          id: node.id || "",
          className: String(node.getAttribute("class") || ""),
          type: node.getAttribute("type") || "",
          value: String(node.value || "").trim(),
          title: node.title || "",
          readonly: !!node.readOnly,
          disabled: !!node.disabled,
        }));
        const vmChain = [];
        let vm = nearestVue(host);
        let depth = 0;
        while (vm && depth < 8) {
          vmChain.push(summarizeVm(vm, depth));
          vm = vm.$parent || null;
          depth += 1;
        }
        const descendantVms = Array.from(host.querySelectorAll("*"))
          .map((node) => node.__vue__ || null)
          .filter(Boolean)
          .slice(0, 12)
          .map((childVm, index) => ({
            index,
            name: childVm.$options?.name || "",
            keys: Object.keys(childVm || {}).slice(0, 80),
            propsData: compact(childVm.$options?.propsData || {}, 1),
            data: compact(childVm.$data || {}, 1),
            optionMethods: childVm.$options?.methods ? Object.keys(childVm.$options.methods).slice(0, 80) : [],
            ownMethods: Object.keys(childVm || {}).filter((key) => typeof childVm[key] === "function").slice(0, 50),
            methodSources: Object.fromEntries(
              ["setSelectValue", "inputEvent", "filterEnums", "pickerEvent", "relation", "getSelectValue"]
                .filter((name) => typeof childVm[name] === "function")
                .map((name) => [name, Function.prototype.toString.call(childVm[name]).slice(0, 1200)])
            ),
          }));
        return {
          found: true,
          fieldId,
          text: clean(host.innerText || host.textContent),
          className: String(host.getAttribute("class") || ""),
          htmlSample: String(host.outerHTML || "").slice(0, 1200),
          inputs,
          vmChain,
          descendantVms,
        };
      };

      let formData = null;
      let formDataError = "";
      try {
        formData = typeof api?.getFormData === "function" ? api.getFormData() : null;
      } catch (error) {
        formDataError = String(error);
      }
      const mainControls = formData?.formmains?.[mainTableName] || {};
      const fieldInfo = formData?.tableInfo?.formmain?.fieldInfo || {};
      const fieldsResult = {};
      for (const [key, fieldId] of Object.entries(fields)) {
        fieldsResult[key] = {
          fieldId,
          control: compact(mainControls[fieldId] || null),
          fieldInfo: compact(fieldInfo[fieldId] || null),
          dom: summarizeDomField(fieldId),
        };
      }
      return {
        ok: true,
        hasApi: !!api,
        apiMethods: api ? Object.keys(api).filter((key) => typeof api[key] === "function").sort() : [],
        formDataError,
        formDataKeys: formData ? Object.keys(formData) : [],
        mainTableName,
        fields: fieldsResult,
      };
    }`
  );
  return {
    ok: true,
    visible,
    runtime,
  };
}

async function runProjectCreateRegionRuntimeProbe({ runRoot }) {
  let opened = null;
  let draftCdp = null;
  try {
    opened = await openProjectCreateBaseSession({ runRoot });
    const { session } = opened;
    const draftOpen = await openProjectCreateWaitsendDraft({
      cdp: session.cdp,
      browserPort: session.edge.port,
    });
    if (!draftOpen?.ok) {
      return {
        ok: false,
        stage: "open-waitsend-draft",
        draftOpen,
      };
    }

    draftCdp = draftOpen.cdp;
    session.extraCdps.push(draftCdp);
    const probe = await probeProjectCreateRegionRuntimeState(draftCdp);
    return {
      ok: true,
      stage: "runtime-probe",
      draftOpen: {
        ...draftOpen,
        cdp: undefined,
      },
      probe,
      saveDraftTouched: false,
    };
  } finally {
    if (opened?.session) {
      await closeBrowserSession(opened.session).catch(() => {});
    } else if (draftCdp) {
      await draftCdp.close().catch(() => {});
    }
  }
}

function extractFieldReadback(readback, fieldId) {
  const field = readback?.fields?.[fieldId] || {};
  return String(field.browseText || field.inputValue || field.text || "").trim();
}

function buildRegionSaveGate(regionResult) {
  const requested = regionResult?.requested || {};
  const readback = regionResult?.afterDistrict || {};
  const actual = {
    province: extractFieldReadback(readback, config.fields.province),
    city: extractFieldReadback(readback, config.fields.city),
    district: extractFieldReadback(readback, config.fields.district),
  };
  const mismatches = Object.entries(requested).filter(([key, wanted]) => {
    return String(actual[key] || "").trim() !== String(wanted || "").trim();
  }).map(([key, wanted]) => ({
    key,
    wanted,
    actual: actual[key] || "",
    fieldId: config.fields[key],
  }));
  return {
    ok: mismatches.length === 0,
    requested,
    actual,
    mismatches,
  };
}

async function observePopupForField(cdp, { key, fieldId, triggerKind }) {
  const openResult = await openFieldTrigger(cdp, fieldId, triggerKind);
  await sleep(1000);
  const snapshot = await snapshotTopPage(cdp, `${key}-${triggerKind}`);
  const closeResult = await closeTopLayers(cdp);
  return {
    key,
    fieldId,
    triggerKind,
    openResult,
    snapshot,
    closeResult,
  };
}

async function observeSelectField(cdp, { key, fieldId }) {
  const openResult = await openFieldTrigger(cdp, fieldId, "select");
  await sleep(500);
  const menuSnapshot = await collectIframeMenuSnapshot(cdp, `${key}-select`);
  const closeResult = await closeIframeMenus(cdp);
  return {
    key,
    fieldId,
    openResult,
    menuSnapshot,
    closeResult,
  };
}

async function observeRegionCascade(cdp, sample = {}) {
  const province = sample.province || "四川省";
  const city = sample.city || "成都市";
  const before = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);

  const provinceMenu = await observeSelectField(cdp, {
    key: "province-before-select",
    fieldId: config.fields.province,
  });
  const selectProvince = await selectMainOptionByText(cdp, config.fields.province, province);
  const afterProvince = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);

  const cityMenu = await observeSelectField(cdp, {
    key: "city-after-province",
    fieldId: config.fields.city,
  });
  const selectCity = await selectMainOptionByText(cdp, config.fields.city, city);
  const afterCity = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);

  const districtMenu = await observeSelectField(cdp, {
    key: "district-after-city",
    fieldId: config.fields.district,
  });
  const finalReadback = await readVisibleFieldValues(cdp, config.iframeId, [
    config.fields.province,
    config.fields.city,
    config.fields.district,
  ]);

  return {
    sample: { province, city },
    before,
    provinceMenu,
    selectProvince,
    afterProvince,
    cityMenu,
    selectCity,
    afterCity,
    districtMenu,
    finalReadback,
  };
}

async function runProjectCreateObservation({ input = {}, runRoot }) {
  const executionPlan = buildProjectCreateExecutionPlan(input);
  const sampleValidation = validateProjectCreateInput(
    buildMinimalSaveDraftSample().input
  );

  let opened = null;
  try {
    opened = await openProjectCreateObservationSession({ runRoot });
    const { session, flowOpenResult } = opened;
    const cdp = session.cdp;
    const fieldIds = Object.values(config.fields);

    const [formState, visibleFields, domObservation] = await Promise.all([
      getPageFormState(cdp, config.iframeId),
      readVisibleFieldValues(cdp, config.iframeId, fieldIds),
      observeProjectCreateDom(cdp),
    ]);

    const observedFields = (domObservation?.fields || []).map(compactFieldObservation);
    const formMainControls = formState?.value?.formmains?.[config.mainTableName] || {};
    const relationControlState = {
      [config.fields.customerName]: formMainControls[config.fields.customerName] || null,
      [config.fields.sales]: formMainControls[config.fields.sales] || null,
      [config.fields.business]: formMainControls[config.fields.business] || null,
      [config.fields.presales]: formMainControls[config.fields.presales] || null,
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
      fieldMap: config.fields,
      labels: config.fieldLabels,
      controlTypes: config.controlTypes,
      observedOptions: config.observedOptions,
      cascadeFields: config.cascadeFields,
      visibleFields,
      domObservation: {
        ok: Boolean(domObservation?.ok),
        href: domObservation?.href || "",
        title: domObservation?.title || "",
        fields: observedFields,
      },
      formStateAvailable: Boolean(formState?.ok),
      formStateError: formState?.ok ? "" : formState?.error || formState?.message || "",
      relationControlState,
      minimalSaveDraftSample: buildMinimalSaveDraftSample(),
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

async function runProjectCreateControlObservation({ input = {}, runRoot }) {
  const executionPlan = {
    ...buildProjectCreateExecutionPlan(input),
    flow: "project_create_control_observe",
    mode: "control-observation-only",
  };

  let opened = null;
  try {
    opened = await openProjectCreateObservationSession({ runRoot });
    const { session, flowOpenResult } = opened;
    const cdp = session.cdp;

    const baseObservation = await runProjectCreateObservationWithoutNewSession({
      cdp,
      flowOpenResult,
      input,
      executionPlan,
    });

    const customerRelation = await observePopupForField(cdp, {
      key: "customerName",
      fieldId: config.fields.customerName,
      triggerKind: "relation",
    });

    const peopleControls = [];
    for (const key of ["sales", "business", "presales"]) {
      peopleControls.push(
        await observePopupForField(cdp, {
          key,
          fieldId: config.fields[key],
          triggerKind: "people",
        })
      );
    }

    const selectControls = [];
    for (const key of ["winRate", "progress"]) {
      selectControls.push(
        await observeSelectField(cdp, {
          key,
          fieldId: config.fields[key],
        })
      );
    }

    const regionCascade = await observeRegionCascade(cdp, {
      province: input.province || buildMinimalSaveDraftSample().input.province,
      city: input.city || buildMinimalSaveDraftSample().input.city,
    });

    return {
      ...baseObservation,
      ok: true,
      stage: "control-observation-only",
      flow: "project_create_control_observe",
      executionPlan,
      customerRelation,
      peopleControls,
      selectControls,
      regionCascade,
      saveDraftTouched: false,
    };
  } finally {
    if (opened?.session) {
      await closeBrowserSession(opened.session);
    }
  }
}

async function runProjectCreateWaitsendRegionSave({ input = {}, runRoot }) {
  const regionInput = {
    province: String(input.province ?? "").trim(),
    city: String(input.city ?? "").trim(),
    district: String(input.district ?? input.county ?? "").trim(),
  };
  let opened = null;
  let draftCdp = null;
  try {
    opened = await openProjectCreateBaseSession({ runRoot });
    const { session } = opened;
    const draftOpen = await openProjectCreateWaitsendDraft({
      cdp: session.cdp,
      browserPort: session.edge.port,
    });
    if (!draftOpen?.ok) {
      return {
        ok: false,
        stage: "open-waitsend-draft",
        draftOpen,
        saveDraftTouched: false,
      };
    }
    draftCdp = draftOpen.cdp;
    session.extraCdps.push(draftCdp);

    const beforeAll = await readVisibleFieldValues(draftCdp, config.iframeId, Object.values(config.fields));
    const regionResult = await setProjectCreateRegion(draftCdp, regionInput);
    const saveGate = buildRegionSaveGate(regionResult);
    if (!saveGate.ok) {
      return {
        ok: false,
        stage: "pre-save-region-gate",
        draftOpen: {
          ...draftOpen,
          cdp: undefined,
        },
        beforeAll,
        regionResult,
        saveGate,
        saveDraftTouched: false,
      };
    }

    const saveResult = await saveDraftByMouse(draftCdp, {
      readyTimeoutMs: 20000,
      actionTimeoutMs: 45000,
    });

    return {
      ok: Boolean(saveResult?.ok),
      stage: saveResult?.ok ? "save-draft-completed" : "save-draft-failed",
      flow: "project_create_waitsend_region_save",
      businessName: config.businessName,
      draftOpen: {
        ...draftOpen,
        cdp: undefined,
      },
      beforeAll,
      regionResult,
      saveGate,
      saveResult,
      saveDraftTouched: true,
    };
  } finally {
    if (opened?.session) {
      await closeBrowserSession(opened.session);
    }
  }
}

async function runProjectCreateObservationWithoutNewSession({
  cdp,
  flowOpenResult,
  input,
  executionPlan,
}) {
  const fieldIds = Object.values(config.fields);
  const [formState, visibleFields, domObservation] = await Promise.all([
    getPageFormState(cdp, config.iframeId),
    readVisibleFieldValues(cdp, config.iframeId, fieldIds),
    observeProjectCreateDom(cdp),
  ]);
  const observedFields = (domObservation?.fields || []).map(compactFieldObservation);
  return {
    ok: true,
    stage: "observation-only",
    flow: executionPlan.flow || config.flowName,
    businessName: config.businessName,
    executionPlan,
    templateId: config.templateId,
    targetUrl: config.targetUrl,
    iframeInfo: flowOpenResult?.iframeInfo || null,
    mainTableName: config.mainTableName,
    fieldMap: config.fields,
    labels: config.fieldLabels,
    controlTypes: config.controlTypes,
    observedOptions: config.observedOptions,
    cascadeFields: config.cascadeFields,
    visibleFields,
    domObservation: {
      ok: Boolean(domObservation?.ok),
      href: domObservation?.href || "",
      title: domObservation?.title || "",
      fields: observedFields,
    },
    formStateAvailable: Boolean(formState?.ok),
    formStateError: formState?.ok ? "" : formState?.error || formState?.message || "",
    minimalSaveDraftSample: buildMinimalSaveDraftSample(),
    sampleValidation: validateProjectCreateInput(buildMinimalSaveDraftSample().input),
    risks: summarizeObservationRisks(),
    saveDraftTouched: false,
  };
}

module.exports = {
  buildProjectCreateExecutionPlan,
  buildMinimalSaveDraftSample,
  runProjectCreateObservation,
  runProjectCreateControlObservation,
  runProjectCreateSaveDraft,
  runProjectCreateRegionRuntimeProbe,
  runProjectCreateWaitsendRegionSave,
};
