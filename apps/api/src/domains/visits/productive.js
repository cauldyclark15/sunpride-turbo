/** F-208 central policy evaluator. Legacy fallback retains the 2 Oct clarification; completion is not productivity. */
export const RULE_VERSION = "productive-call/2026-10-02";
// Documented beta default when an effective position standard has no rule. Unknown non-null rules
// still fail closed; a completion or note alone never earns productive-call credit.
export const DEFAULT_PRODUCTIVE_RULE = "any_listed_activity";
export const PRODUCTIVE_CODES = Object.freeze([
  "purchase_order",
  "merchandising",
  "inventory_retrieval",
  "suggested_order",
  "negotiation",
  "bad_order_pickup",
  "collection",
  "meeting",
]);

/**
 * visitFacts = {inRoutePlan, state, codes?, activityKinds?, collectionCount?, reasonCode?}.
 * positionRule = {productiveCallRule:'any_listed_activity'|'truck_seller'}.
 * Unknown rules fail closed. Location certification and per diem are separate decisions.
 * @param {Record<string, any>} visitFacts
 * @param {Record<string, any>} positionRule
 * @returns {{productive:boolean, reason:string}}
 */
export function isProductive(visitFacts, positionRule) {
  // F-208: all writers/reports use the visit's immutable definition first.
  const frozen =
    visitFacts.productivePolicySnapshot ??
    visitFacts.productive_policy_snapshot;
  if (
    frozen &&
    (!["published", "provisional"].includes(frozen.source) ||
      !Array.isArray(frozen.allowedCodes) ||
      !frozen.allowedCodes.length ||
      frozen.allowedCodes.some(
        (/** @type {any} */ c) => !PRODUCTIVE_CODES.includes(c),
      ) ||
      !["any", "all"].includes(frozen.matchMode) ||
      frozen.requiresPlanned !== true)
  )
    return { productive: false, reason: "policy_unknown" };
  const rule =
    frozen?.rule ??
    positionRule.productiveCallRule ??
    positionRule.productive_call_rule ??
    positionRule.rule ??
    DEFAULT_PRODUCTIVE_RULE;
  if (!visitFacts.inRoutePlan) return { productive: false, reason: "off_plan" };
  if (!["checked-out", "completed"].includes(visitFacts.state))
    return { productive: false, reason: "not_closed" };
  if (!["any_listed_activity", "truck_seller"].includes(rule))
    return { productive: false, reason: "rule_unknown" };
  if (visitFacts.outcome === "nonproductive")
    return { productive: false, reason: "declared_nonproductive" };
  // SEAM(CALLFLOW): additional governed forms supply these same business codes,
  // never their own productive-call evaluator. Unsupported/unrecorded labels earn nothing.
  const codes = new Set(visitFacts.codes ?? []);
  for (const kind of visitFacts.activityKinds ?? []) {
    if (kind === "order_intent") codes.add("purchase_order");
    else if (["merchandising", "price_check"].includes(kind))
      codes.add("merchandising");
    else if (kind === "inventory_check") codes.add("inventory_retrieval");
    else if (PRODUCTIVE_CODES.includes(kind)) codes.add(kind);
  }
  if (visitFacts.collectionCount > 0) codes.add("collection");
  const marker =
    visitFacts.noSalesDueToInventory === true ||
    visitFacts.reasonCode?.trim().toLowerCase() === "no_sales_due_to_inventory";
  const allowed = frozen?.allowedCodes ?? PRODUCTIVE_CODES;
  const matched = PRODUCTIVE_CODES.filter(
    (code) =>
      allowed.includes(code) &&
      codes.has(code) &&
      (code !== "merchandising" || rule !== "truck_seller" || marker),
  );
  const productive =
    frozen?.matchMode === "all"
      ? matched.length === allowed.length
      : matched.length > 0;
  return {
    productive,
    reason: productive ? matched[0] : "no_qualifying_activity",
  };
}
