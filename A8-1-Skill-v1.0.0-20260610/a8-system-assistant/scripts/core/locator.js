"use strict";

async function evaluateInPage(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return result.result?.value;
}

async function clickByExactTextInIframe(cdp, iframeId, text) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const iframe = document.getElementById(${JSON.stringify(iframeId)});
      if (!iframe || !iframe.contentWindow || !iframe.contentWindow.document) {
        return { ok: false, error: "iframe-not-ready", iframeId: ${JSON.stringify(iframeId)} };
      }
      const doc = iframe.contentWindow.document;
      const wanted = ${JSON.stringify(String(text || "").trim())};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const elements = Array.from(doc.querySelectorAll("button, .cap-btn, .button-basics, span, div, a"));
      const target = elements.find((element) => normalize(element.innerText || element.textContent || "") === wanted);
      if (!target) {
        return { ok: false, error: "element-not-found", wanted };
      }
      const clickable =
        target.closest(".formson-list__button") ||
        target.closest(".cap-btn") ||
        target.closest("button") ||
        target.closest("a") ||
        target;
      clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: iframe.contentWindow }));
      clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: iframe.contentWindow }));
      clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: iframe.contentWindow }));
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: iframe.contentWindow }));
      if (typeof clickable.click === "function") {
        clickable.click();
      }
      return {
        ok: true,
        wanted,
        tagName: String(clickable.tagName || "").toLowerCase(),
        className: clickable.className || "",
        id: clickable.id || ""
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value;
}

async function findByText(cdp, text, { tagNames = [] } = {}) {
  return evaluateInPage(
    cdp,
    `(() => {
      const wanted = ${JSON.stringify(String(text || "").trim())};
      const tagNames = ${JSON.stringify(tagNames)};
      const elements = Array.from(document.querySelectorAll("body *"));
      const matches = elements.filter((element) => {
        const elementText = (element.innerText || element.textContent || "").trim();
        if (!elementText || elementText !== wanted) return false;
        if (!tagNames.length) return true;
        return tagNames.includes(String(element.tagName || "").toLowerCase());
      });
      return {
        ok: matches.length > 0,
        count: matches.length,
        samples: matches.slice(0, 5).map((element) => ({
          tagName: String(element.tagName || "").toLowerCase(),
          id: element.id || "",
          className: element.className || "",
          text: (element.innerText || element.textContent || "").trim()
        }))
      };
    })()`
  );
}

async function pageHasText(cdp, text) {
  return evaluateInPage(
    cdp,
    `(() => {
      const wanted = ${JSON.stringify(String(text || "").trim())};
      const bodyText = (document.body && (document.body.innerText || document.body.textContent) || "").trim();
      return {
        ok: bodyText.includes(wanted),
        wanted
      };
    })()`
  );
}

async function getPageSummary(cdp) {
  return evaluateInPage(
    cdp,
    `(() => ({
      ok: true,
      href: location.href,
      title: document.title,
      readyState: document.readyState
    }))()`
  );
}

async function clickTopPageSelector(cdp, selector) {
  return evaluateInPage(
    cdp,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) {
        return { ok: false, error: "element-not-found", selector: ${JSON.stringify(selector)} };
      }
      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      if (typeof element.click === "function") {
        element.click();
      }
      return {
        ok: true,
        selector: ${JSON.stringify(selector)},
        tagName: String(element.tagName || "").toLowerCase(),
        id: element.id || "",
        className: element.className || ""
      };
    })()`
  );
}

module.exports = {
  evaluateInPage,
  clickByExactTextInIframe,
  findByText,
  pageHasText,
  getPageSummary,
  clickTopPageSelector,
};
