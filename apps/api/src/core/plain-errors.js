/**
 * One catalogue of plain-language error messages (SPEC §8.4) for the inventory, van and store POS routes.
 * The HTTP body keeps the machine `code`; only `message` is rewritten. People read `message`, code reads `code`.
 */

export const NOT_SET_UP_MESSAGE =
  "This handheld is not set up for you. Ask your supervisor to hand it over.";

/** Routes whose messages go through the catalogue. */
export const PLAIN_ROUTES = /^\/api\/v1\/(inventory|van|storepos)(\/|$)/;

/** Codes whose internal text is never shown to people. */
export const PLAIN_BY_CODE = Object.freeze({
  stale_snapshot:
    "Stock moved on this line while you counted. It will be rechecked automatically.",
  device_revoked: NOT_SET_UP_MESSAGE,
  device_not_set_up_for_you: NOT_SET_UP_MESSAGE,
  device_suspended: "This handheld is paused. Ask your supervisor.",
  device_unavailable: "This handheld is not available for this work.",
  device_unbound:
    "This handheld is not finished being set up. Ask your supervisor.",
  device_integrity_required:
    "This handheld needs a quick safety check. Open the app and try again.",
  value_overflow: "That amount is too large. Check the quantity and price.",
  rate_limited: "Too many tries. Wait a moment and try again.",
  internal: "Something went wrong on our side. Try again in a moment.",
});

/** Codes with a plain default, used only when the server text is blank or just a generic word. */
export const PLAIN_FALLBACK = Object.freeze({
  stock_conflict:
    "Stock changed while you were working. Refresh the page and try again.",
  idempotency_conflict:
    "This was already sent with different details. Refresh to see what was saved.",
  scope_withdrawn: "Your access changed. Sign in again or ask your supervisor.",
  load_not_posted: "The load is not on the truck yet. Finish the load first.",
  wrong_date: "This belongs to a different day. Check the date.",
  forbidden: "You are not allowed to do this. Ask your supervisor.",
  out_of_scope: "This belongs to another team or seller.",
  not_found: "We could not find that. It may have been removed.",
  conflict: "Someone changed this first. Refresh and try again.",
  invalid_request:
    "Something in that request is not right. Check it and try again.",
  invalid_transition: "That cannot be done at this stage.",
  unauthenticated: "Sign in again to continue.",
});

/**
 * Known awkward server sentences. Each pattern is anchored to the one internal message it targets, so an unrelated
 * message that merely shares words (for example "…is no longer active") is never rewritten. Device refusals are
 * matched by code only (PLAIN_BY_CODE), never by text. First match wins.
 */
export const PLAIN_BY_TEXT = /** @type {Array<[RegExp,string]>} */ ([
  [
    /^(The (product|lot) roster changed|Stock changed since this count began)\. Start a new count\.?$/,
    PLAIN_BY_CODE.stale_snapshot,
  ],
  [
    /^This movement needs more than 50 lots; split the document$/,
    "Too many batches on one line. Split this line in two.",
  ],
  [
    /^(Unit conversion needs setup|The product quantity scale needs correction)$/,
    "Case size not set for this product. Enter pieces.",
  ],
  [
    /^(Download the register's current configuration|Sync the current register configuration)$/,
    "Settings changed in the office. Tap Sync.",
  ],
]);

const GENERIC_TEXT =
  /^(not allowed|not found|conflict|invalid request|forbidden|sign in required|insufficient permission|something went wrong)\.?$/i;

/**
 * @param {{code:string,message:string}} error
 * @param {string} [path] request path; when given, only catalogued routes are rewritten
 */
export function plainMessage(error, path) {
  if (path !== undefined && !PLAIN_ROUTES.test(path)) return error.message;
  const byCode = /** @type {Record<string,string>} */ (PLAIN_BY_CODE)[
    error.code
  ];
  if (byCode) return byCode;
  for (const [pattern, plain] of PLAIN_BY_TEXT)
    if (pattern.test(error.message)) return plain;
  const blank =
    !error.message ||
    error.message === error.code ||
    GENERIC_TEXT.test(error.message);
  const fallback = /** @type {Record<string,string>} */ (PLAIN_FALLBACK)[
    error.code
  ];
  return blank && fallback ? fallback : error.message;
}
