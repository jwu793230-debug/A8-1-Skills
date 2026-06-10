"use strict";

const { sleep } = require("./browser");
const { clickByExactTextInIframe, evaluateInPage } = require("./locator");

async function openPickerFromIframeButton(cdp, { iframeId = "zwIframe", buttonText }) {
  const clickResult = await clickByExactTextInIframe(cdp, iframeId, buttonText);
  if (!clickResult?.ok) {
    return {
      ok: false,
      stage: "click-button",
      clickResult,
    };
  }

  await sleep(1200);

  const modalState = await evaluateInPage(
    cdp,
    `(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const texts = Array.from(document.querySelectorAll("body *"))
        .map((element) => normalize(element.innerText || element.textContent || ""))
        .filter(Boolean);
      const interestingTexts = [];
      for (const text of texts) {
        if (interestingTexts.length >= 80) break;
        if (/(存货|产品|编号|查询|确定|取消|选择|多选)/.test(text)) {
          interestingTexts.push(text);
        }
      }
      const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
        .map((element) => ({
          tagName: String(element.tagName || "").toLowerCase(),
          type: element.type || "",
          id: element.id || "",
          name: element.name || "",
          placeholder: element.placeholder || "",
          title: element.title || "",
          value: typeof element.value === "string" ? element.value : ""
        }))
        .slice(0, 120);

      return {
        ok: true,
        interestingTexts,
        inputs
      };
    })()`
  );

  return {
    ok: true,
    stage: "opened",
    clickResult,
    modalState,
  };
}

async function inspectTopPageModal(cdp) {
  return evaluateInPage(
    cdp,
    `(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const bodyText = normalize(document.body ? (document.body.innerText || document.body.textContent || "") : "");
      const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
        .map((element) => ({
          tagName: String(element.tagName || "").toLowerCase(),
          type: element.type || "",
          id: element.id || "",
          name: element.name || "",
          placeholder: element.placeholder || "",
          title: element.title || "",
          value: typeof element.value === "string" ? element.value : "",
          className: element.className || ""
        }))
        .slice(0, 200);
      const buttons = Array.from(document.querySelectorAll("button, a, span, div"))
        .map((element) => ({
          text: normalize(element.innerText || element.textContent || ""),
          id: element.id || "",
          className: element.className || "",
          tagName: String(element.tagName || "").toLowerCase()
        }))
        .filter((item) => item.text && /确定|取消|查询|筛选|项目编号|产品编号|关联列表|选择/.test(item.text))
        .slice(0, 120);
      return {
        ok: true,
        bodyHasRelationList: bodyText.includes("关联列表"),
        bodyHasConfirm: bodyText.includes("确定"),
        inputs,
        buttons
      };
    })()`
  );
}

async function clickTopPageButtonByText(cdp, text) {
  return evaluateInPage(
    cdp,
    `(() => {
      const wanted = ${JSON.stringify(String(text || "").trim())};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const elements = Array.from(document.querySelectorAll("button, a, span, div"));
      const target = elements.find((element) => normalize(element.innerText || element.textContent || "") === wanted);
      if (!target) {
        return { ok: false, error: "button-not-found", wanted };
      }
      const clickable =
        target.closest("button") ||
        target.closest("a") ||
        target.closest(".layui-layer-btn0") ||
        target.closest(".ui-dialog-button") ||
        target;
      clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      if (typeof clickable.click === "function") {
        clickable.click();
      }
      return {
        ok: true,
        wanted,
        id: clickable.id || "",
        className: clickable.className || "",
        tagName: String(clickable.tagName || "").toLowerCase()
      };
    })()`
  );
}

async function fillTopPageInput(cdp, { keyword, preferredHints = [] }) {
  return evaluateInPage(
    cdp,
    `(() => {
      const wanted = ${JSON.stringify(String(keyword || ""))};
      const hints = ${JSON.stringify(preferredHints)};
      const inputs = Array.from(document.querySelectorAll("input[type='text'], input:not([type]), textarea"));
      const score = (element) => {
        const text = [element.id, element.name, element.placeholder, element.title, element.className]
          .map((item) => String(item || ""))
          .join(" ")
          .toLowerCase();
        let value = 0;
        for (const hint of hints) {
          if (text.includes(String(hint || "").toLowerCase())) {
            value += 5;
          }
        }
        if (!element.readOnly && !element.disabled) {
          value += 2;
        }
        return value;
      };
      const candidates = inputs
        .map((element) => ({ element, score: score(element) }))
        .sort((a, b) => b.score - a.score);
      const chosen = candidates.find((item) => item.score > 0)?.element || inputs.find((element) => !element.readOnly && !element.disabled);
      if (!chosen) {
        return { ok: false, error: "input-not-found", wanted, hints };
      }
      chosen.focus();
      chosen.value = "";
      chosen.dispatchEvent(new Event("input", { bubbles: true }));
      chosen.value = wanted;
      chosen.dispatchEvent(new Event("input", { bubbles: true }));
      chosen.dispatchEvent(new Event("change", { bubbles: true }));
      chosen.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      chosen.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      chosen.blur();
      return {
        ok: true,
        id: chosen.id || "",
        name: chosen.name || "",
        placeholder: chosen.placeholder || "",
        title: chosen.title || "",
        className: chosen.className || "",
        value: chosen.value || ""
      };
    })()`
  );
}

module.exports = {
  openPickerFromIframeButton,
  inspectTopPageModal,
  clickTopPageButtonByText,
  fillTopPageInput,
};
