/**
 * ANA-007 management exception dashboard: pure view rules. Thresholds and the field-page
 * totals mirror `packages/backend/convex/analytics/exception_model.ts` (a test keeps them
 * equal) so the web can add up the pages it subscribed to and explain each list without
 * importing Convex server code. Nothing here decides access; the endpoints do.
 */

export const BEHIND_PLAN_PCT = 80;
export const MIN_PLANNED_FOR_BEHIND = 5;
export const REPEAT_GEOFENCE_MIN = 3;
export const OOS_OUTLET_MIN = 3;
export const OOS_PRODUCT_MIN_OUTLETS = 3;
/** Longest period one read covers (same as the productivity dashboard). */
export const MAX_PERIOD_DAYS = 31;

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

const DAY_MS = 86_400_000;

/** The first day of the Manila month of a YYYY-MM-DD date: the default period start. */
export function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

/** Inclusive days in a period; 0 when it runs backwards. */
export function periodDays(from: string, to: string) {
  const days =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS +
    1;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/** Why a period is refused before asking the server, or null. */
export function periodProblem(from: string, to: string) {
  if (!from || !to) return "Pick both dates";
  if (from > to) return "The period must start on or before its end";
  if (periodDays(from, to) > MAX_PERIOD_DAYS)
    return `A period covers at most ${MAX_PERIOD_DAYS} days`;
  return null;
}

export const REASON_LABELS = {
  plan: "Behind on plan",
  sales: "Behind on sales",
} as const;

export const SAP_KIND_LABELS = {
  failed: "Failed",
  dead_letter: "Dead letter",
  stuck: "Stuck",
} as const;

export const TRIP_STATUS_LABELS: Record<string, string> = {
  loading: "Loading",
  open: "Open",
  closing: "Closing",
  reconciling: "Reconciling",
  review_required: "Count needs review",
};

export const DIFFERENCE_LABELS: Record<string, string> = {
  mapping: "Mapping",
  timing: "Timing",
  missing_inbound: "Missing inbound",
  missing_outbound: "Missing outbound",
  duplicate: "Duplicate",
  unauthorized_adjustment: "Unauthorized adjustment",
  unresolved: "Unresolved",
};

/** "Sep 29" style Manila date for a YYYY-MM-DD string. */
export function shortDate(date: string) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(Date.parse(`${date}T00:00:00.000Z`));
}

/** "Sep 29, 06:00" style Manila date and time for an instant. */
export function shortDateTime(instant: number) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

/** Whole hours an item has been waiting, for "open 33 h" labels. */
export function hoursSince(instant: number, now: number) {
  return Math.max(0, Math.floor((now - instant) / 3_600_000));
}
