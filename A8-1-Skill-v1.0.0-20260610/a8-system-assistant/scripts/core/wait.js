"use strict";

const { sleep } = require("./browser");

async function waitForCondition(fn, { timeoutMs = 30000, intervalMs = 500, description = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      lastValue = await fn();
      lastError = "";
      if (lastValue && lastValue.ok) {
        return lastValue;
      }
    } catch (error) {
      lastError = String(error);
      lastValue = { ok: false, error: lastError };
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `${description} timed out. lastValue=${JSON.stringify(lastValue)}${
      lastError ? ` lastError=${lastError}` : ""
    }`
  );
}

async function waitForRuntimeExpression(cdp, expression, options = {}) {
  return waitForCondition(
    async () => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      }, {
        timeoutMs: options.evaluationTimeoutMs || 3000,
      });
      return result.result?.value;
    },
    options
  );
}

async function waitForDocumentReady(cdp, { timeoutMs = 30000 } = {}) {
  return waitForRuntimeExpression(
    cdp,
    `(() => ({
      ok: document.readyState === "complete" || (document.readyState === "interactive" && !!document.body),
      readyState: document.readyState,
      href: location.href,
      title: document.title
    }))()`,
    {
      timeoutMs,
      intervalMs: 500,
      description: "document ready",
    }
  );
}

async function waitForIframeReady(cdp, iframeId = "zwIframe", { timeoutMs = 45000 } = {}) {
  return waitForRuntimeExpression(
    cdp,
    `(() => {
      const iframe = document.getElementById(${JSON.stringify(iframeId)});
      let iframeReady = false;
      let iframeHref = "";
      try {
        iframeHref = iframe ? iframe.src || "" : "";
        iframeReady = !!(
          iframe &&
          iframe.contentWindow &&
          iframe.contentWindow.document &&
          iframe.contentWindow.document.readyState === "complete"
        );
      } catch (_error) {}
      return {
        ok: iframeReady,
        iframeId: ${JSON.stringify(iframeId)},
        iframeReady,
        iframeHref
      };
    })()`,
    {
      timeoutMs,
      intervalMs: 500,
      description: `iframe ${iframeId} ready`,
    }
  );
}

module.exports = {
  waitForCondition,
  waitForRuntimeExpression,
  waitForDocumentReady,
  waitForIframeReady,
};
