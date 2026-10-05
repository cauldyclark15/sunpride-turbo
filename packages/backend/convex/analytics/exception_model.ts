/**
 * ANA-007 management exception dashboard: pure rules shared by `analytics/exceptions.ts`,
 * its tests and the web mirror (`apps/web/src/lib/management-exceptions.ts`, kept equal by
 * a test). Nothing here touches the database.
 *
 * Managers manage exceptions instead of inspecting every transaction (blueprint §58). The
 * dashboard surfaces, for the caller's own scope and a period of Manila dates:
 * - missed high-value outlets (planned stops of closed days with no completed visit);
 * - field people materially behind plan (plan completion or sales attainment to date);
 * - repeated geofence issues (people and outlets with several off-radius/unreliable fixes);
 * - SAP failures (failed, dead-lettered or stuck integration events; connector down);
 * - unclosed van trips (route sessions still open after their day's 10 PM close);
 * - stock variances (route-close and other counts, open SAP reconciliation differences);
 * - out-of-stock hotspots (outlets and products repeatedly found out of stock).
 *
 * Every threshold below is PROVISIONAL: Sunpride has not defined "high value", "materially
 * behind" or "repeated". They live here, never inline, so a client answer is one change.
 */

/** People per field page: each person reads up to a month of stops, visits and orders. */
export const EXCEPTION_PAGE_SIZE = 6;
/** Planned stops / visits read per person for one period (30 calls × 31 days + headroom). */
export const MAX_PERIOD_ROWS = 1_000;
/** Orders read per person for one period. */
export const MAX_PERIOD_ORDERS = 2_000;
/** Missed high-value stops listed per person (all are counted). */
export const MAX_MISSED_LISTED = 10;
/** Rows listed per section; counts always cover everything read. */
export const MAX_LISTED = 25;

/** Materially behind = below this share of plan-to-date (i.e. 20 points or more short). */
export const BEHIND_PLAN_PCT = 80;
/** Plan completion is judged only with at least this many planned stops of closed days. */
export const MIN_PLANNED_FOR_BEHIND = 5;
/** A person or outlet with at least this many geofence issues in the period repeats. */
export const REPEAT_GEOFENCE_MIN = 3;
/** An outlet with at least this many out-of-stock findings in the period is a hotspot. */
export const OOS_OUTLET_MIN = 3;
/** A product out of stock in at least this many outlets in the period is a hotspot. */
export const OOS_PRODUCT_MIN_OUTLETS = 3;
/** A pending/processing integration event older than this is stuck. */
export const SAP_STUCK_MS = 2 * 3_600_000;
/** A connector heartbeat older than this means the connector is down. */
export const CONNECTOR_STALE_MS = 15 * 60_000;

/**
 * Outlet classifications and channels treated as high value. Sunpride has not sent its
 * outlet classes yet; "A"-class and key accounts are the usual FMCG reading. Matching is
 * case- and punctuation-insensitive.
 */
export const HIGH_VALUE_CLASSES: readonly string[] = [
  "A",
  "AA",
  "AAA",
  "A+",
  "KA",
  "KEY ACCOUNT",
  "KEY ACCOUNTS",
  "PLATINUM",
  "GOLD",
];
export const HIGH_VALUE_CHANNELS: readonly string[] = [
  "KA",
  "KAG",
  "KEY ACCOUNT",
  "KEY ACCOUNTS",
  "MODERN TRADE",
];

export const EXCEPTION_SOURCE =
  "ANA-007 · blueprint §58 · call answers 2 Oct 2026 (10 PM day close) · provisional thresholds";

/** Open (not yet closed) van route statuses; `review_required` is a variance awaiting review. */
export const UNCLOSED_TRIP_STATUSES = [
  "loading",
  "open",
  "closing",
  "reconciling",
  "review_required",
] as const;

const HOUR = 3_600_000;
const MANILA_OFFSET = 8 * HOUR;
const DAY_CLOSE_HOUR = 22;

function normalized(value: string | undefined | null) {
  return (value ?? "")
    .toUpperCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isHighValueOutlet(outlet: {
  classification?: string | null;
  channel?: string | null;
}) {
  const cls = normalized(outlet.classification);
  const channel = normalized(outlet.channel);
  return (
    (cls !== "" && HIGH_VALUE_CLASSES.includes(cls)) ||
    (channel !== "" && HIGH_VALUE_CHANNELS.includes(channel))
  );
}

/** Whole percent, rounded down like every other SFA report; null without a base. */
export function pctOf(part: number, whole: number | null) {
  if (whole === null || whole <= 0) return null;
  return Math.floor((part * 100) / whole);
}

export type BehindReason = "plan" | "sales";

/**
 * Plan-to-date judgement for one person. Plan: completed planned stops ÷ planned stops of
 * closed days (≥ MIN_PLANNED_FOR_BEHIND). Sales: sales of closed days ÷ the sum of their
 * daily targets (DSR rule). Either below BEHIND_PLAN_PCT is materially behind.
 */
export function behindPlan(input: {
  plannedClosed: number;
  doneClosed: number;
  sales: number;
  salesTarget: number | null;
}) {
  const planPct =
    input.plannedClosed >= MIN_PLANNED_FOR_BEHIND
      ? pctOf(input.doneClosed, input.plannedClosed)
      : null;
  const salesPct = pctOf(input.sales, input.salesTarget);
  const reasons: BehindReason[] = [];
  if (planPct !== null && planPct < BEHIND_PLAN_PCT) reasons.push("plan");
  if (salesPct !== null && salesPct < BEHIND_PLAN_PCT) reasons.push("sales");
  return { planPct, salesPct, reasons };
}

/** The 10 PM Manila close of the day an instant falls on. */
export function dayCloseOf(instant: number) {
  const date = new Date(instant + MANILA_OFFSET).toISOString().slice(0, 10);
  return (
    Date.parse(`${date}T00:00:00.000Z`) - MANILA_OFFSET + DAY_CLOSE_HOUR * HOUR
  );
}

/**
 * A van trip is unclosed once the 10 PM close of the day it started has passed and it is
 * still not `closed` (call answer 14: the day closes at 10 PM). `review_required` is always
 * listed: its final count disagreed and nobody has resolved it.
 */
export function tripUnclosed(
  trip: {
    status: string;
    openedAt?: number;
    createdAt: number;
  },
  now: number,
) {
  if (trip.status === "closed" || trip.status === "planned") return false;
  if (trip.status === "review_required") return true;
  return dayCloseOf(trip.openedAt ?? trip.createdAt) < now;
}

export type SapIssueKind = "failed" | "dead_letter" | "stuck";

export function sapIssueKind(
  event: { status: string; receivedAt: number; nextAttemptAt?: number },
  now: number,
): SapIssueKind | null {
  if (event.status === "failed") return "failed";
  if (event.status === "dead_letter") return "dead_letter";
  if (
    (event.status === "pending" || event.status === "processing") &&
    event.receivedAt < now - SAP_STUCK_MS &&
    (event.nextAttemptAt === undefined || event.nextAttemptAt < now)
  )
    return "stuck";
  return null;
}

export function connectorDown(
  heartbeat: { status: string; lastSeenAt: number },
  now: number,
) {
  return (
    heartbeat.status !== "online" ||
    heartbeat.lastSeenAt < now - CONNECTOR_STALE_MS
  );
}

/** Keeps groups with at least `min` items, largest first, then by key for stability. */
export function repeated<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  min: number,
) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length >= min)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, rows]) => ({ key, rows }));
}

export type OosFinding = {
  outletId: string;
  productId: string;
  orgUnitId: string;
  serviceDate: string;
};

/**
 * Out-of-stock hotspots: outlets with at least OOS_OUTLET_MIN out-of-stock findings, and
 * products out of stock in at least OOS_PRODUCT_MIN_OUTLETS distinct outlets.
 */
export function oosHotspots(findings: readonly OosFinding[]) {
  const outlets = repeated(findings, (row) => row.outletId, OOS_OUTLET_MIN).map(
    ({ key, rows }) => ({
      outletId: key,
      findings: rows.length,
      products: new Set(rows.map((row) => row.productId)).size,
      lastDate: rows.reduce(
        (max, row) => (row.serviceDate > max ? row.serviceDate : max),
        "",
      ),
    }),
  );
  const byProduct = new Map<string, Set<string>>();
  for (const row of findings)
    byProduct.set(
      row.productId,
      (byProduct.get(row.productId) ?? new Set()).add(row.outletId),
    );
  const products = [...byProduct.entries()]
    .filter(([, set]) => set.size >= OOS_PRODUCT_MIN_OUTLETS)
    .map(([productId, set]) => ({
      productId,
      outlets: set.size,
      findings: findings.filter((row) => row.productId === productId).length,
    }))
    .sort(
      (a, b) =>
        b.outlets - a.outlets ||
        b.findings - a.findings ||
        a.productId.localeCompare(b.productId),
    );
  return { outlets, products };
}

/** Field page totals; the web adds the pages it subscribed to. */
export type FieldTotals = {
  people: number;
  behind: number;
  behindPlan: number;
  behindSales: number;
  missedHighValue: number;
  peopleMissingHighValue: number;
};

export function emptyFieldTotals(): FieldTotals {
  return {
    people: 0,
    behind: 0,
    behindPlan: 0,
    behindSales: 0,
    missedHighValue: 0,
    peopleMissingHighValue: 0,
  };
}

export function mergeFieldTotals(a: FieldTotals, b: FieldTotals): FieldTotals {
  const out = { ...a };
  for (const key of Object.keys(b) as (keyof FieldTotals)[])
    out[key] = a[key] + b[key];
  return out;
}

export function fieldTotals(
  rows: readonly {
    reasons: readonly BehindReason[];
    missedHighValueCount: number;
  }[],
): FieldTotals {
  const out = emptyFieldTotals();
  for (const row of rows) {
    out.people++;
    if (row.reasons.length) out.behind++;
    if (row.reasons.includes("plan")) out.behindPlan++;
    if (row.reasons.includes("sales")) out.behindSales++;
    out.missedHighValue += row.missedHighValueCount;
    if (row.missedHighValueCount > 0) out.peopleMissingHighValue++;
  }
  return out;
}
