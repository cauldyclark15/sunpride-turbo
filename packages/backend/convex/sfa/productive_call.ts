import { v } from "convex/values";

/**
 * Sunpride's productive-call rule, confirmed by Sir Francis (email 2026-09-30, call 2026-10-02
 * at 11:23 and 27:00). It replaces the memo's per-channel "all of this checklist" reading:
 *
 * - A call is a store visited that is part of the day's route plan (an unplanned visit is not
 *   a call, and a planned store that was never visited is not a call either).
 * - A call is productive when ANY ONE of the listed activities was recorded at that visit.
 *   It is judged per visit, against the objective of that visit, not only on sales.
 * - Truck sellers (PMOT, PMOT Extruck, RDS) must sell. When the store has no need for stock
 *   they mark the visit "visited, no sales due to inventory", and merchandising then counts as
 *   their productive call. Without that marker, merchandising alone does not make a truck
 *   seller's call productive.
 *
 * This module is pure: no database access, so the web, the field apps' server paths and
 * reports all evaluate a visit the same way.
 */
export const PRODUCTIVE_CALL_RULE_VERSION = "productive-call/2026-10-02";

export const PRODUCTIVE_ACTIVITY_CODES = [
  "purchase_order",
  "merchandising",
  "inventory_retrieval",
  "suggested_order",
  "negotiation",
  "bad_order_pickup",
  "collection",
  "meeting",
] as const;
export type ProductiveActivityCode = (typeof PRODUCTIVE_ACTIVITY_CODES)[number];

/** The truck seller's "visited, no sales due to inventory" marker; never productive alone. */
export const NO_SALES_DUE_TO_INVENTORY = "no_sales_due_to_inventory";

export const PRODUCTIVE_ACTIVITY_LABELS: Record<
  ProductiveActivityCode,
  string
> = {
  purchase_order: "Purchase order",
  merchandising: "Merchandising (display, price tags)",
  inventory_retrieval: "Inventory retrieval",
  suggested_order: "Suggested order (ICO)",
  negotiation: "Negotiation leading to sales or uplift",
  bad_order_pickup: "Bad order (BO) pickup",
  collection: "Collection",
  meeting: "Meeting",
};

export const productiveCallRuleValidator = v.union(
  v.literal("any_listed_activity"),
  v.literal("truck_seller"),
);
export type ProductiveCallRule = "any_listed_activity" | "truck_seller";

export const PRODUCTIVE_CALL_RULE_LABELS: Record<ProductiveCallRule, string> = {
  any_listed_activity: "Any one listed activity",
  truck_seller:
    "Any one listed activity; merchandising counts only with “visited, no sales due to inventory”",
};

export type CallStatus =
  "productive" | "nonproductive" | "open" | "not_visited" | "off_plan";

export type CallEvaluation = {
  status: CallStatus;
  /** True when the visit counts toward the day's call total. */
  isCall: boolean;
  matchedCodes: ProductiveActivityCode[];
  ruleVersion: string;
};

const CLOSED_STATES = new Set(["checked-out", "completed"]);
const OPEN_STATES = new Set(["arrived", "checked-in", "in-progress"]);

export function isProductiveActivityCode(
  code: string,
): code is ProductiveActivityCode {
  return (PRODUCTIVE_ACTIVITY_CODES as readonly string[]).includes(code);
}

/**
 * Evaluates one visit. `codes` are the activity codes recorded at the visit (unknown codes
 * are ignored); `noSalesDueToInventory` is the truck seller's marker.
 */
export function evaluateProductiveCall(input: {
  rule: ProductiveCallRule;
  inRoutePlan: boolean;
  state: string;
  codes: readonly string[];
  noSalesDueToInventory?: boolean;
}): CallEvaluation {
  const base = { ruleVersion: PRODUCTIVE_CALL_RULE_VERSION };
  if (!input.inRoutePlan)
    return { ...base, status: "off_plan", isCall: false, matchedCodes: [] };
  if (OPEN_STATES.has(input.state))
    return { ...base, status: "open", isCall: false, matchedCodes: [] };
  if (!CLOSED_STATES.has(input.state))
    return { ...base, status: "not_visited", isCall: false, matchedCodes: [] };
  const recorded = PRODUCTIVE_ACTIVITY_CODES.filter((code) =>
    input.codes.includes(code),
  );
  const matchedCodes =
    input.rule === "truck_seller" && !input.noSalesDueToInventory
      ? recorded.filter((code) => code !== "merchandising")
      : recorded;
  return {
    ...base,
    status: matchedCodes.length ? "productive" : "nonproductive",
    isCall: true,
    matchedCodes,
  };
}

/**
 * Maps what the field apps record today onto the client's activity codes. The current visit
 * wire carries only some of them; suggested order (ICO), negotiation, BO pickup, meeting and
 * the no-sales marker need dedicated activity kinds from the visit contract.
 */
export function productiveCodesFromVisitRecords(input: {
  activityKinds: readonly string[];
  collectionCount: number;
  reasonCode?: string;
}): { codes: ProductiveActivityCode[]; noSalesDueToInventory: boolean } {
  const codes = new Set<ProductiveActivityCode>();
  for (const kind of input.activityKinds) {
    if (kind === "order_intent") codes.add("purchase_order");
    else if (kind === "merchandising" || kind === "price_check")
      codes.add("merchandising");
    else if (kind === "inventory_check") codes.add("inventory_retrieval");
    else if (isProductiveActivityCode(kind)) codes.add(kind);
  }
  if (input.collectionCount > 0) codes.add("collection");
  const reason = input.reasonCode?.trim().toLowerCase();
  return {
    codes: PRODUCTIVE_ACTIVITY_CODES.filter((code) => codes.has(code)),
    noSalesDueToInventory: reason === NO_SALES_DUE_TO_INVENTORY,
  };
}

export type DayCallSummary = {
  calls: number;
  productiveCalls: number;
  /** Whole percent, rounded down; null when there were no calls. */
  productivePct: number | null;
};

export function summarizeCalls(
  evaluations: readonly CallEvaluation[],
): DayCallSummary {
  const calls = evaluations.filter((e) => e.isCall).length;
  const productiveCalls = evaluations.filter(
    (e) => e.status === "productive",
  ).length;
  return {
    calls,
    productiveCalls,
    productivePct: calls ? Math.floor((productiveCalls * 100) / calls) : null,
  };
}
