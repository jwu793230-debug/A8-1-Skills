"use strict";

class A8AssistantError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "A8AssistantError";
    this.code = options.code || "A8_ASSISTANT_ERROR";
    this.stage = options.stage || "";
    this.details = options.details || null;
  }
}

function buildErrorPayload(error, extra = {}) {
  return {
    success: false,
    code: error?.code || "A8_ASSISTANT_ERROR",
    stage: error?.stage || extra.stage || "",
    error: String(error),
    message: error?.message || "",
    details: error?.details || extra.details || null,
    stack: error?.stack || "",
  };
}

module.exports = {
  A8AssistantError,
  buildErrorPayload,
};
