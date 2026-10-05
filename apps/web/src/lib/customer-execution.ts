/**
 * ANA-005 customer execution dashboard: display helpers only. Every figure is computed by
 * `packages/backend/convex/analytics/customer.ts` (rules in `customer_model.ts`); the web
 * formats them. Amounts are PHP centavos.
 */
import type { StatusTone } from "@sunpride/ui";

export { pctText, pesoText } from "./supervisor-productivity";

/** Must equal the backend's MAX_CUSTOMER_WEEKS (a test checks it). */
export const MAX_CUSTOMER_WEEKS = 13;
export const WEEK_PRESETS: [number, string][] = [
  [4, "Last 4 weeks"],
  [8, "Last 8 weeks"],
  [12, "Last 12 weeks"],
  [13, "Last 13 weeks"],
];

export type RegularityStatus =
  "on_cadence" | "overdue" | "not_visited" | "no_cadence";

export const REGULARITY_LABELS: Record<
  RegularityStatus,
  { label: string; tone: StatusTone }
> = {
  on_cadence: { label: "On cadence", tone: "success" },
  overdue: { label: "Overdue", tone: "danger" },
  not_visited: { label: "Not visited", tone: "danger" },
  no_cadence: { label: "No visit cycle set", tone: "neutral" },
};

export type TrendDirection = "up" | "down" | "steady" | "new" | "none";

export const TREND_LABELS: Record<
  TrendDirection,
  { label: string; tone: StatusTone }
> = {
  up: { label: "Growing", tone: "success" },
  steady: { label: "Steady", tone: "neutral" },
  down: { label: "Declining", tone: "warning" },
  new: { label: "No earlier sales to compare", tone: "neutral" },
  none: { label: "No sales", tone: "danger" },
};

export type Availability =
  "available" | "low_stock" | "out_of_stock" | "not_carried";

export const AVAILABILITY_LABELS: Record<
  Availability,
  { label: string; tone: StatusTone }
> = {
  available: { label: "On shelf", tone: "success" },
  low_stock: { label: "Low stock", tone: "warning" },
  out_of_stock: { label: "Out of stock", tone: "danger" },
  not_carried: { label: "Not carried", tone: "danger" },
};

export function daysText(days: number | null) {
  if (days === null) return "—";
  if (days === 0) return "Today";
  return days === 1 ? "1 day" : `${days} days`;
}

export function changeText(changePct: number | null) {
  if (changePct === null) return "—";
  return changePct > 0 ? `+${changePct}%` : `${changePct}%`;
}

/** Short "5 Sep" label for a YYYY-MM-DD week start. */
export function weekLabel(date: string) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(Date.parse(`${date}T00:00:00.000Z`));
}

/** Days since the last order: warn after two expected cycles, else after 14 days. */
export function lastOrderTone(
  daysSince: number | null,
  cycleDays: number | null,
): StatusTone {
  if (daysSince === null) return "danger";
  const limit = cycleDays ? cycleDays * 2 : 14;
  return daysSince > limit ? "warning" : "neutral";
}
