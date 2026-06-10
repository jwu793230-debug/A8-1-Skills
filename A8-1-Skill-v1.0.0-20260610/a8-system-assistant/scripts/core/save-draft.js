"use strict";

const { sleep } = require("./browser");

function buildSaveDraftGateResult({ precheck, allowed, reason = "" } = {}) {
  return {
    ok: Boolean(allowed),
    precheck: precheck || null,
    reason: String(reason || ""),
  };
}

async function installSaveDraftHooks(cdp) {
  return cdp.send("Runtime.evaluate", {
    expression: `(() => {
      if (window.__a8PageSaveHookInstalled) {
        return { ok: true, reused: true };
      }
      window.__a8PageSaveHookInstalled = true;
      window.__a8PageSaveData = { dialogs: [], triggerLog: [] };

      const originalEndSaveDraft = window.endSaveDraft;
      window.endSaveDraft = function patchedEndSaveDraft(summaryId, contentId, affairId, newSubject) {
        window.__a8PageSaveData.endSaveDraft = {
          summaryId: summaryId || "",
          contentId: contentId || "",
          affairId: affairId || "",
          newSubject: newSubject || ""
        };
        if (typeof originalEndSaveDraft === "function") {
          return originalEndSaveDraft.apply(this, arguments);
        }
        return undefined;
      };

      const pushTriggerLog = (record) => {
        window.__a8PageSaveData = window.__a8PageSaveData || { dialogs: [], triggerLog: [] };
        window.__a8PageSaveData.triggerLog = window.__a8PageSaveData.triggerLog || [];
        window.__a8PageSaveData.triggerLog.push({
          at: Date.now(),
          ...record
        });
      };

      const saveBtn = document.getElementById("saveDraft_a");
      if (saveBtn) {
        saveBtn.addEventListener("click", function observedSaveDraftClick(event) {
          pushTriggerLog({
            action: "saveDraft_a-click-event",
            targetId: event && event.target ? event.target.id || "" : "",
            currentTargetId: event && event.currentTarget ? event.currentTarget.id || "" : "",
            isTrusted: Boolean(event && event.isTrusted)
          });
        }, true);
      }

      const originalToolbarSaveDraft = window.toolbarsaveDraft_aClick;
      if (typeof originalToolbarSaveDraft === "function") {
        window.toolbarsaveDraft_aClick = function patchedToolbarSaveDraft() {
          try {
            const result = originalToolbarSaveDraft.apply(this, arguments);
            pushTriggerLog({
              action: "toolbarsaveDraft_aClick-called",
              returnType: typeof result,
              returnValue: result == null ? "" : String(result).slice(0, 300)
            });
            return result;
          } catch (error) {
            pushTriggerLog({ action: "toolbarsaveDraft_aClick-called", error: String(error) });
            throw error;
          }
        };
      }

      const originalSaveDraft = window.saveDraft;
      if (typeof originalSaveDraft === "function") {
        window.saveDraft = function patchedSaveDraft() {
          try {
            const result = originalSaveDraft.apply(this, arguments);
            pushTriggerLog({
              action: "saveDraft-called",
              returnType: typeof result,
              returnValue: result == null ? "" : String(result).slice(0, 300)
            });
            return result;
          } catch (error) {
            pushTriggerLog({ action: "saveDraft-called", error: String(error) });
            throw error;
          }
        };
      }

      const originalAlert = window.alert;
      window.alert = function patchedAlert(message) {
        window.__a8PageSaveData.lastAlert = String(message || "");
        window.__a8PageSaveData.dialogs.push(String(message || ""));
        if (typeof originalAlert === "function") {
          return originalAlert.apply(this, arguments);
        }
        return undefined;
      };

      const originalConfirm = window.confirm;
      window.confirm = function patchedConfirm(message) {
        window.__a8PageSaveData.lastConfirm = String(message || "");
        window.__a8PageSaveData.dialogs.push(String(message || ""));
        pushTriggerLog({ action: "confirm-called", message: String(message || ""), response: true });
        return true;
      };

      const originalPrompt = window.prompt;
      window.prompt = function patchedPrompt(message, defaultValue) {
        window.__a8PageSaveData.lastPrompt = String(message || "");
        window.__a8PageSaveData.dialogs.push(String(message || ""));
        pushTriggerLog({
          action: "prompt-called",
          message: String(message || ""),
          defaultValue: String(defaultValue || "")
        });
        return defaultValue == null ? "" : String(defaultValue);
      };

      return {
        ok: true,
        reused: false,
        hasSaveDraft: typeof originalSaveDraft === "function",
        hasToolbarSaveDraft: typeof originalToolbarSaveDraft === "function",
        hasEndSaveDraft: typeof originalEndSaveDraft === "function",
        hasButton: !!saveBtn
      };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || { ok: false });
}

async function getSaveDraftButtonBox(cdp) {
  return cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const byId = document.getElementById("saveDraft_a");
      const byText = Array.from(document.querySelectorAll("button, a, span, div"))
        .find((element) => normalize(element.innerText || element.textContent || "") === "保存待发");
      const element = byId || byText;
      if (!element) {
        return { ok: false, error: "save-draft-button-not-found" };
      }
      const clickable =
        element.closest("a") ||
        element.closest("button") ||
        element.closest(".common_button") ||
        element;
      const rect = clickable.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        return {
          ok: false,
          error: "save-draft-button-not-visible",
          id: clickable.id || "",
          className: clickable.className || ""
        };
      }
      return {
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        id: clickable.id || "",
        className: clickable.className || "",
        tagName: String(clickable.tagName || "").toLowerCase(),
        text: normalize(clickable.innerText || clickable.textContent || "")
      };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || { ok: false });
}

async function snapshotSaveDraftState(cdp) {
  return cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const saveBtn = document.getElementById("saveDraft_a");
      return {
        href: location.href,
        contentLoaded: window.contentLoaded,
        hasSaveDraft: typeof window.saveDraft === "function",
        hasToolbarFn: typeof window.toolbarsaveDraft_aClick === "function",
        hasEndSaveDraft: typeof window.endSaveDraft === "function",
        saveBtn: saveBtn ? {
          id: saveBtn.id || "",
          className: saveBtn.className || "",
          text: normalize(saveBtn.innerText || saveBtn.textContent || ""),
          disabled: !!saveBtn.disabled,
          pointerEvents: getComputedStyle(saveBtn).pointerEvents,
          display: getComputedStyle(saveBtn).display,
          visibility: getComputedStyle(saveBtn).visibility
        } : null,
        hookData: window.__a8PageSaveData || null
      };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || null);
}

async function waitForSaveButtonEnabled(cdp, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await snapshotSaveDraftState(cdp);
    const className = String(lastState?.saveBtn?.className || "");
    if (
      lastState?.saveBtn &&
      !lastState.saveBtn.disabled &&
      !className.includes("common_menu_dis") &&
      lastState.saveBtn.visibility !== "hidden" &&
      lastState.saveBtn.display !== "none" &&
      lastState.saveBtn.pointerEvents !== "none"
    ) {
      return {
        ok: true,
        state: lastState,
      };
    }
    await sleep(intervalMs);
  }

  return {
    ok: false,
    state: lastState,
  };
}

async function clickSaveDraftButtonByMouse(cdp) {
  const box = await getSaveDraftButtonBox(cdp);
  if (!box?.ok) {
    return box || { ok: false, error: "save-draft-button-box-unavailable" };
  }

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: box.x,
    y: box.y,
    button: "none",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: box.x,
    y: box.y,
    button: "left",
    clickCount: 1,
  });

  return {
    ok: true,
    source: "native-mouse",
    ...box,
  };
}

async function triggerDomSaveDraftClick(cdp) {
  return cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const saveBtn = document.getElementById("saveDraft_a");
      if (!saveBtn) {
        return { ok: false, error: "save-draft-button-not-found" };
      }
      window.__a8PageSaveData = window.__a8PageSaveData || { dialogs: [], triggerLog: [] };
      window.__a8PageSaveData.triggerLog = window.__a8PageSaveData.triggerLog || [];
      window.setTimeout(() => {
        const record = {
          action: "dom-click",
          startedAt: Date.now(),
        };
        window.__a8PageSaveData.triggerLog.push(record);
        try {
          for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
            saveBtn.dispatchEvent(new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
            }));
          }
          if (typeof saveBtn.click === "function") {
            saveBtn.click();
          }
          record.finishedAt = Date.now();
          record.ok = true;
        } catch (error) {
          record.finishedAt = Date.now();
          record.ok = false;
          record.error = String(error);
          window.__a8PageSaveData.lastTriggerError = String(error);
        }
      }, 100);
      return { ok: true, source: "dom-click-async", hasButton: true };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || { ok: false });
}

async function waitForSaveDraftCompletion(cdp, { timeoutMs = 45000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  const pollErrors = [];

  while (Date.now() < deadline) {
    const state = await cdp.send("Runtime.evaluate", {
      expression: `(() => ({
        ok: !!(window.__a8PageSaveData && window.__a8PageSaveData.endSaveDraft),
        data: window.__a8PageSaveData || null,
        href: location.href
      }))()`,
      returnByValue: true,
    }, {
      timeoutMs: Math.min(5000, Math.max(1000, intervalMs * 4)),
    }).then((result) => result.result?.value || null).catch((error) => {
      const record = {
        at: new Date().toISOString(),
        error: String(error),
      };
      pollErrors.push(record);
      return {
        ok: false,
        stage: "save-draft-poll-page-busy",
        error: record.error,
      };
    });
    lastState = state;
    if (state?.ok) {
      return {
        ...state,
        pollErrors,
      };
    }
    await sleep(intervalMs);
  }

  return {
    ok: false,
    stage: "wait-save-draft-completion-timeout",
    lastState,
    pollErrors,
  };
}

async function triggerToolbarSaveDraft(cdp) {
  return cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const saveBtn = document.getElementById("saveDraft_a");
      if (typeof window.toolbarsaveDraft_aClick !== "function") {
        return { ok: false, error: "toolbarsaveDraft_aClick-unavailable" };
      }
      window.setTimeout(() => {
        window.__a8PageSaveData = window.__a8PageSaveData || { dialogs: [], triggerLog: [] };
        window.__a8PageSaveData.triggerLog = window.__a8PageSaveData.triggerLog || [];
        const record = {
          action: "toolbarsaveDraft_aClick",
          startedAt: Date.now(),
        };
        window.__a8PageSaveData.triggerLog.push(record);
        try {
          window.toolbarsaveDraft_aClick(saveBtn || null);
          record.finishedAt = Date.now();
          record.ok = true;
        } catch (error) {
          record.finishedAt = Date.now();
          record.ok = false;
          record.error = String(error);
          window.__a8PageSaveData.lastTriggerError = String(error);
        }
      }, 100);
      return { ok: true, source: "toolbarsaveDraft_aClick-async", hasButton: !!saveBtn };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || { ok: false });
}

async function triggerDirectSaveDraft(cdp) {
  return cdp.send("Runtime.evaluate", {
    expression: `(() => {
      if (typeof window.saveDraft !== "function") {
        return { ok: false, error: "saveDraft-unavailable" };
      }
      window.setTimeout(() => {
        window.__a8PageSaveData = window.__a8PageSaveData || { dialogs: [], triggerLog: [] };
        window.__a8PageSaveData.triggerLog = window.__a8PageSaveData.triggerLog || [];
        const record = {
          action: "saveDraft",
          startedAt: Date.now(),
        };
        window.__a8PageSaveData.triggerLog.push(record);
        try {
          window.saveDraft();
          record.finishedAt = Date.now();
          record.ok = true;
        } catch (error) {
          record.finishedAt = Date.now();
          record.ok = false;
          record.error = String(error);
          window.__a8PageSaveData.lastTriggerError = String(error);
        }
      }, 100);
      return { ok: true, source: "saveDraft()-async" };
    })()`,
    returnByValue: true,
  }).then((result) => result.result?.value || { ok: false });
}

async function trySaveDraftAction(cdp, actionName, action, { timeoutMs = 12000 } = {}) {
  let trigger = null;
  try {
    trigger = await action();
  } catch (error) {
    return {
      ok: false,
      action: actionName,
      trigger: {
        ok: false,
        error: "save-draft-trigger-threw",
        message: String(error),
      },
      completion: null,
    };
  }
  if (!trigger?.ok) {
    return {
      ok: false,
      action: actionName,
      trigger,
      completion: null,
    };
  }

  let completion = null;
  try {
    completion = await waitForSaveDraftCompletion(cdp, {
      timeoutMs,
      intervalMs: 500,
    });
  } catch (error) {
    completion = {
      ok: false,
      stage: "wait-save-draft-completion-threw",
      error: String(error),
    };
  }
  return {
    ok: Boolean(completion?.ok),
    action: actionName,
    trigger,
    completion,
  };
}

async function saveDraftWithFallback(cdp, {
  readyTimeoutMs = 20000,
  actionTimeoutMs = 12000,
  actions = ["mouse", "toolbar", "direct"],
} = {}) {
  const hook = await installSaveDraftHooks(cdp);
  const ready = await waitForSaveButtonEnabled(cdp, {
    timeoutMs: readyTimeoutMs,
    intervalMs: 500,
  });
  const attempts = [];
  const actionList = [...new Set(actions.filter(Boolean))];

  const actionMap = {
    mouse: {
      name: "mouse-saveDraft_a",
      fn: () => clickSaveDraftButtonByMouse(cdp),
      requiresReady: true,
    },
    toolbar: {
      name: "toolbar-function",
      fn: () => triggerToolbarSaveDraft(cdp),
    },
    direct: {
      name: "direct-saveDraft",
      fn: () => triggerDirectSaveDraft(cdp),
    },
    dom: {
      name: "dom-click-saveDraft_a",
      fn: () => triggerDomSaveDraftClick(cdp),
    },
  };

  for (const actionKey of actionList) {
    const action = actionMap[actionKey];
    if (!action) continue;
    if (action.requiresReady && !ready?.ok) continue;

    attempts.push(
      await trySaveDraftAction(cdp, action.name, action.fn, {
        timeoutMs: actionTimeoutMs,
      })
    );
    if (attempts.at(-1)?.ok) {
      return {
        ok: true,
        stage: "save-draft-completed",
        hook,
        ready,
        attempts,
        completion: attempts.at(-1).completion,
      };
    }
  }

  const completion = attempts.at(-1)?.completion || null;
  return {
    ok: Boolean(completion?.ok),
    stage: completion?.ok ? "save-draft-completed" : "save-draft-timeout",
    hook,
    ready,
    attempts,
    completion,
  };
}

async function saveDraftByMouse(cdp, options = {}) {
  return saveDraftWithFallback(cdp, options);
}

module.exports = {
  buildSaveDraftGateResult,
  installSaveDraftHooks,
  getSaveDraftButtonBox,
  snapshotSaveDraftState,
  waitForSaveButtonEnabled,
  clickSaveDraftButtonByMouse,
  waitForSaveDraftCompletion,
  triggerToolbarSaveDraft,
  triggerDirectSaveDraft,
  triggerDomSaveDraftClick,
  saveDraftWithFallback,
  saveDraftByMouse,
};
