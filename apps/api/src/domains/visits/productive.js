/** Client clarification, 2 Oct 2026. Pure shared rule; completion is not productivity. */
export const RULE_VERSION = "productive-call/2026-10-02";
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
  const rule =
    positionRule.productiveCallRule ??
    positionRule.productive_call_rule ??
    positionRule.rule;
  if (!visitFacts.inRoutePlan) return { productive: false, reason: "off_plan" };
  if (!["checked-out", "completed"].includes(visitFacts.state))
    return { productive: false, reason: "not_closed" };
  if (!["any_listed_activity", "truck_seller"].includes(rule))
    return { productive: false, reason: "rule_unknown" };
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
  const matched = PRODUCTIVE_CODES.filter(
    (code) =>
      codes.has(code) &&
      (code !== "merchandising" || rule !== "truck_seller" || marker),
  );
  return {
    productive: matched.length > 0,
    reason: matched[0] ?? "no_qualifying_activity",
  };
}
