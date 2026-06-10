"use strict";

const { waitForDocumentReady, waitForIframeReady } = require("./wait");
const { getIframeInfoFromPage } = require("./frame");

async function navigateToUrl(cdp, url, { timeoutMs = 30000 } = {}) {
  await cdp.send("Page.navigate", { url });
  return waitForDocumentReady(cdp, { timeoutMs });
}

async function openFlowPage(cdp, flowConfig, { onStage } = {}) {
  const reportStage =
    typeof onStage === "function" ? onStage : async () => undefined;

  await reportStage({
    stage: "page-navigate-start",
    targetUrl: flowConfig.targetUrl,
  });
  const navigateResult = await cdp.send("Page.navigate", {
    url: flowConfig.targetUrl,
  });
  await reportStage({
    stage: "page-navigate-sent",
    targetUrl: flowConfig.targetUrl,
    navigateResult,
  });
  const loadState = await waitForDocumentReady(cdp, {
    timeoutMs: flowConfig.pageLoadTimeoutMs || 30000,
  });
  await reportStage({
    stage: "document-ready",
    loadState,
  });
  const iframeState = await waitForIframeReady(cdp, flowConfig.iframeId || "zwIframe", {
    timeoutMs: flowConfig.iframeLoadTimeoutMs || 45000,
  });
  await reportStage({
    stage: "iframe-ready",
    iframeState,
  });
  const iframeInfo = await getIframeInfoFromPage(cdp, {
    iframeId: flowConfig.iframeId || "zwIframe",
    baseUrl: flowConfig.baseUrl,
  });
  await reportStage({
    stage: "iframe-info",
    iframeInfo,
  });
  return {
    loadState,
    iframeState,
    iframeInfo,
  };
}

module.exports = {
  navigateToUrl,
  openFlowPage,
};
