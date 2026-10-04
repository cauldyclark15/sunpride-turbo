/**
 * ANA-005 customer execution dashboard: pure rules (no database access). For one store
 * (outlet) and a period of whole weeks ending on a Manila date, `analytics/customer.ts`
 * gathers the store's visits, planned stops, orders and merchandising audits; these
 * functions turn them into visit regularity, order trend, days since last order, missed
 * planned calls and assortment/distribution status.
 *
 * Definitions (see docs/architecture/CUSTOMER_EXECUTION_DASHBOARD.md):
 * - Visit day: a Manila date with at least one visit to the store that was checked out
 *   (planned or unplanned, by anyone). Several visits on one day are one visit day.
 * - Expected cycle: the store's visit cycle in days (outlet assignment, else route, else
 *   the outlet profile's visit frequency); null when nobody has set one.
 * - Regularity: gaps between consecutive visit days; "on cadence" gaps are no longer than
 *   the expected cycle. Overdue: days since the last visit day exceed the expected cycle.
 * - Missed planned call: an active planned stop (signed MCP) of a closed day (after the
 *   10 PM close) without a checked-out visit to that stop. Open days are "still due".
 * - Order trend: orders that count as a sale (DSR rule) for the store's customer, by the
 *   Manila day written, in weekly buckets; the change compares the latest 4 weeks with
 *   the 4 weeks before (sums, PHP centavos).
 * - Distribution: a required-assortment SKU is "distributed" when the customer ordered it
 *   in the period; availability is the latest merchandising audit's finding for it.
 *
 * Percentages are whole numbers rounded down; null when there is no base.
 */

export const DEFAULT_CUSTOMER_WEEKS = 12;
/** Longest period one read covers: a quarter (13 weeks). */
export const MAX_CUSTOMER_WEEKS = 13;
/** Weeks compared on each side of the order trend. */
export const TREND_WEEKS = 4;
/** PROVISIONAL: a change within ±10% is "steady" (no client figure yet). */
export const STEADY_BAND_PCT = 10;
export const CUSTOMER_SOURCE =
  "ANA-005 · call answers 2 Oct 2026 · memo 2026-01-20 §2 (provisional KPI definitions)";

const DAY_MS = 86_400_000;

function dayNumber(date: string) {
  return Date.parse(`${date}T00:00:00.000Z`) / DAY_MS;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string) {
  return Math.round(dayNumber(to) - dayNumber(from));
}

export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Whole percent, rounded down; null without a positive base. */
export function ratePct(part: number, whole: number | null) {
  if (whole === null || whole <= 0) return null;
  return Math.floor((part * 100) / whole);
}

/** Why a week count is refused, or null. */
export function weeksError(weeks: number) {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_CUSTOMER_WEEKS)
    return `Pick 1 to ${MAX_CUSTOMER_WEEKS} weeks`;
  return null;
}

/**
 * The period: `weeks` whole weeks ending on `asOfDate`. Week 0 is the oldest; each week
 * starts on `weekStarts[i]` and covers seven Manila dates.
 */
export function customerPeriod(asOfDate: string, weeks: number) {
  const from = addDays(asOfDate, -(weeks * 7 - 1));
  return {
    from,
    to: asOfDate,
    weekStarts: Array.from({ length: weeks }, (_, i) => addDays(from, i * 7)),
  };
}

/** Index of the week a date falls in, or -1 outside the period. */
export function weekIndex(period: { from: string; to: string }, date: string) {
  if (date < period.from || date > period.to) return -1;
  return Math.floor(daysBetween(period.from, date) / 7);
}

export type RegularityStatus =
  "on_cadence" | "overdue" | "not_visited" | "no_cadence";

export type Regularity = {
  visitDays: number;
  lastVisitDate: string | null;
  daysSinceLastVisit: number | null;
  expectedCycleDays: number | null;
  averageGapDays: number | null;
  longestGapDays: number | null;
  gaps: number;
  gapsOnCadence: number;
  onCadencePct: number | null;
  status: RegularityStatus;
};

/**
 * Regularity from the store's visit days in the period. `lastVisitBefore` is the latest
 * visit day before the period (so the first gap and "days since" are honest when the
 * period starts mid-cycle); pass null when unknown.
 */
export function visitRegularity(input: {
  visitDates: readonly string[];
  lastVisitBefore: string | null;
  asOfDate: string;
  expectedCycleDays: number | null;
}): Regularity {
  const days = [...new Set(input.visitDates)]
    .filter((date) => date <= input.asOfDate)
    .sort();
  const all = input.lastVisitBefore ? [input.lastVisitBefore, ...days] : days;
  const gaps: number[] = [];
  for (let i = 1; i < all.length; i++)
    gaps.push(daysBetween(all[i - 1]!, all[i]!));
  const lastVisitDate = all.length ? all[all.length - 1]! : null;
  const daysSinceLastVisit =
    lastVisitDate === null ? null : daysBetween(lastVisitDate, input.asOfDate);
  const cycle = input.expectedCycleDays;
  const gapsOnCadence =
    cycle === null ? 0 : gaps.filter((gap) => gap <= cycle).length;
  let status: RegularityStatus;
  if (lastVisitDate === null) status = "not_visited";
  else if (cycle === null) status = "no_cadence";
  else if (daysSinceLastVisit! > cycle) status = "overdue";
  else status = "on_cadence";
  return {
    visitDays: days.length,
    lastVisitDate,
    daysSinceLastVisit,
    expectedCycleDays: cycle,
    averageGapDays: gaps.length
      ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10
      : null,
    longestGapDays: gaps.length ? Math.max(...gaps) : null,
    gaps: gaps.length,
    gapsOnCadence,
    onCadencePct: cycle === null ? null : ratePct(gapsOnCadence, gaps.length),
    status,
  };
}

export type TrendDirection = "up" | "down" | "steady" | "new" | "none";

export type WeekOrders = { orders: number; sales: number };

/** Latest TREND_WEEKS weeks against the TREND_WEEKS before them (sales, centavos). */
export function orderTrend(weeks: readonly WeekOrders[]) {
  const recent = weeks.slice(-TREND_WEEKS);
  const prior = weeks.slice(-2 * TREND_WEEKS, -TREND_WEEKS);
  const recentSales = recent.reduce((sum, week) => sum + week.sales, 0);
  const priorSales = prior.reduce((sum, week) => sum + week.sales, 0);
  const comparable = prior.length === TREND_WEEKS;
  let changePct: number | null = null;
  let direction: TrendDirection;
  if (comparable && priorSales > 0) {
    changePct = Math.round(((recentSales - priorSales) * 100) / priorSales);
    direction =
      Math.abs(changePct) <= STEADY_BAND_PCT
        ? "steady"
        : changePct > 0
          ? "up"
          : "down";
  } else if (recentSales > 0) direction = "new";
  else direction = "none";
  return {
    recentSales,
    priorSales: comparable ? priorSales : null,
    recentOrders: recent.reduce((sum, week) => sum + week.orders, 0),
    changePct,
    direction,
  };
}

export type StopFacts = {
  serviceDate: string;
  /** The 10 PM close has passed. */
  closed: boolean;
  /** A checked-out visit exists for this stop. */
  done: boolean;
};

/** Planned stops split into done, missed (closed day, not done) and still due. */
export function plannedCallSummary(stops: readonly StopFacts[]) {
  let done = 0,
    missed = 0,
    pending = 0;
  for (const stop of stops) {
    if (stop.done) done++;
    else if (stop.closed) missed++;
    else pending++;
  }
  return {
    planned: stops.length,
    done,
    missed,
    pending,
    missedPct: ratePct(missed, stops.length - pending),
  };
}

export type AvailabilityStatus =
  "available" | "low_stock" | "out_of_stock" | "not_carried";

export type SkuFacts = {
  ordered: boolean;
  /** Latest audit finding for the SKU; null when no audit checked it. */
  availability: AvailabilityStatus | null;
};

/** Required-assortment SKUs: how many were ordered, and how the last audit found them. */
export function distributionSummary(skus: readonly SkuFacts[]) {
  const count = (status: AvailabilityStatus) =>
    skus.filter((sku) => sku.availability === status).length;
  const ordered = skus.filter((sku) => sku.ordered).length;
  const available = count("available") + count("low_stock");
  const checked = skus.filter((sku) => sku.availability !== null).length;
  return {
    required: skus.length,
    ordered,
    distributionPct: ratePct(ordered, skus.length),
    checked,
    available,
    outOfStock: count("out_of_stock"),
    notCarried: count("not_carried"),
    availabilityPct: ratePct(available, checked),
    gaps: skus.filter(
      (sku) =>
        !sku.ordered &&
        (sku.availability === null ||
          sku.availability === "out_of_stock" ||
          sku.availability === "not_carried"),
    ).length,
  };
}
