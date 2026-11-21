import { invalid } from "./errors.js";

/** Stored when a person leaves an optional reason blank (keeps NOT NULL / length checks happy). */
export const NO_REASON = "No reason given";

/**
 * Reasons are optional (jc, loosen rules): a typed reason is trimmed and kept, a blank one
 * becomes NO_REASON. Over-long text is still refused so it never truncates silently.
 * @param {any} value @param {string} [label] @param {number} [max]
 * @returns {string}
 */
export function optionalReason(value, label = "Reason", max = 500) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return NO_REASON;
  if (text.length > max)
    throw invalid(`${label} is too long (up to ${max} characters)`);
  return text;
}
