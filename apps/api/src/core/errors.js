import { NOT_SET_UP_MESSAGE, plainMessage } from "./plain-errors.js";
export { NOT_SET_UP_MESSAGE };

/** Whole-request API error. `action` and `retryAfterMs` feed the v2 native envelope (D2). */
export class ApiError extends Error {
  /**
   * @param {string} code snake_case code
   * @param {number} status HTTP status
   * @param {string} [message] plain words
   * @param {boolean} [retryable]
   * @param {{ action?: 'retry'|'reauthenticate'|'rebootstrap'|'hold'|'update'|'none', retryAfterMs?: number|null, details?: Record<string, unknown>|null }} [extra]
   */
  constructor(code, status, message = code, retryable = false, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.action = extra.action ?? defaultAction(status, retryable);
    this.retryAfterMs = extra.retryAfterMs ?? null;
    /** Optional structured detail (e.g. SP-0170 field errors); only the contract §3 envelope carries it. */
    this.details = extra.details ?? null;
  }
}

/** @param {number} status @param {boolean} retryable */
function defaultAction(status, retryable) {
  if (status === 401) return "reauthenticate";
  if (status === 426) return "update";
  if (status === 403 || status === 409) return "hold";
  if (retryable || status === 429 || status === 503) return "retry";
  return "none";
}

export const invalid = (
  /** @type {string} */ message = "Invalid request",
  code = "invalid_request",
) => new ApiError(code, 400, message, false);
export const unauthenticated = (
  message = "Sign in required",
  code = "unauthenticated",
) => new ApiError(code, 401, message, false, { action: "reauthenticate" });
export const forbidden = (message = "Not allowed", code = "forbidden") =>
  new ApiError(code, 403, message, false);
export const notFound = (message = "Not found", code = "not_found") =>
  new ApiError(code, 404, message, false, { action: "none" });
export const conflict = (message = "Conflict", code = "conflict") =>
  new ApiError(code, 409, message, false);

/**
 * Error body. `v2` selects the native D2 envelope; otherwise the contract §3 envelope.
 * @param {ApiError} error
 * @param {boolean} v2
 * @param {number} now
 * @param {string} [path] request path; inventory, van and store POS routes get catalogue messages
 */
export function errorBody(error, v2, now, path) {
  if (v2)
    return {
      version: 2,
      serverTime: now,
      error: {
        code: error.code,
        retryable: error.retryable,
        retryAfterMs: error.retryAfterMs,
        action: error.action,
      },
    };
  return {
    error: {
      code: error.code,
      message: plainMessage(error, path),
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
