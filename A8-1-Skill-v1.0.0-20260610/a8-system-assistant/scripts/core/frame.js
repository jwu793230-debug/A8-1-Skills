"use strict";

function parseIframeSrcFromHtml(html, iframeId = "zwIframe") {
  const text = String(html || "");
  const singleQuoted = new RegExp(
    `<iframe[^>]+id=['"]${iframeId}['"][^>]+src=["']([^"']+)["']`,
    "i"
  );
  const match = text.match(singleQuoted);
  if (!match) {
    throw new Error(`iframe src not found for id=${iframeId}`);
  }
  return match[1];
}

function parseQuery(urlPath, baseUrl) {
  const url = new URL(urlPath.startsWith("http") ? urlPath : `${baseUrl}${urlPath}`);
  const params = {};
  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value;
  }
  return { href: url.href, params };
}

async function getIframeInfoFromPage(cdp, { iframeId = "zwIframe", baseUrl } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const iframe = document.getElementById(${JSON.stringify(iframeId)});
      return {
        exists: !!iframe,
        id: ${JSON.stringify(iframeId)},
        src: iframe ? iframe.getAttribute("src") || "" : "",
        href: iframe ? iframe.src || "" : ""
      };
    })()`,
    returnByValue: true,
  });

  const value = result.result?.value || {};
  if (!value.exists || !value.src) {
    throw new Error(`iframe not found or src empty for id=${iframeId}`);
  }

  return {
    iframeId,
    src: value.src,
    href: value.href || (baseUrl ? new URL(value.src, baseUrl).href : value.src),
    parsed: baseUrl ? parseQuery(value.src, baseUrl) : null,
  };
}

async function evaluateInIframe(cdp, iframeId, iframeExpression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const iframe = document.getElementById(${JSON.stringify(iframeId)});
      if (!iframe) {
        return { ok: false, error: "iframe-not-found", iframeId: ${JSON.stringify(iframeId)} };
      }
      let iframeWindow = null;
      let iframeDocument = null;
      try {
        iframeWindow = iframe.contentWindow;
        iframeDocument = iframeWindow ? iframeWindow.document : null;
      } catch (error) {
        return {
          ok: false,
          error: "iframe-access-error",
          iframeId: ${JSON.stringify(iframeId)},
          message: String(error)
        };
      }
      if (!iframeWindow || !iframeDocument) {
        return { ok: false, error: "iframe-window-missing", iframeId: ${JSON.stringify(iframeId)} };
      }
      try {
        const runner = ${iframeExpression};
        return runner(iframeWindow, iframeDocument);
      } catch (error) {
        return {
          ok: false,
          error: "iframe-runner-error",
          iframeId: ${JSON.stringify(iframeId)},
          message: String(error),
          stack: error && error.stack ? String(error.stack) : "",
        };
      }
    })()`,
    returnByValue: true,
  });
  return result.result?.value;
}

async function getIframeHtmlSnapshot(cdp, iframeId = "zwIframe") {
  return evaluateInIframe(
    cdp,
    iframeId,
    `(iframeWindow, iframeDocument) => ({
      ok: true,
      html: iframeDocument.documentElement ? iframeDocument.documentElement.outerHTML : ""
    })`
  );
}

module.exports = {
  parseIframeSrcFromHtml,
  parseQuery,
  getIframeInfoFromPage,
  evaluateInIframe,
  getIframeHtmlSnapshot,
};
