/**
 * ANA-003 supervisor productivity dashboard: pure rules (no database access). A supervisor
 * compares the field people in their scope (by default their direct reports) over a period
 * on planned, actual and productive calls, order conversion, sales per call, missed calls
 * and exception rate. `analytics/productivity.ts` gathers each person-day's facts; these
 * functions turn them into period figures and team totals. The web mirror
 * (`apps/web/src/lib/supervisor-productivity.ts`) is kept equal by a test.
 *
 * Definitions (see docs/architecture/SUPERVISOR_PRODUCTIVITY_DASHBOARD.md):
 * - Planned call: an active planned stop (status `planned`) from the signed MCP.
 * - Actual call / productive call: the client's rule (call answers 2 Oct 2026, ADR in
 *   `sfa/productive_call.ts`): a route-plan store visited and checked out; productive when
 *   any one listed activity was recorded.
 * - Converted call: an actual call where the salesman wrote an order that counts as a sale
 *   for that store's customer on the same Manila day (or the visit's own order intent).
 * - Sales per call: all sales of the period (PHP centavos) ÷ actual calls.
 * - Missed call: a planned stop of a closed day (after the 10 PM close) with no completed
 *   visit. Stops of a day still open are pending, never missed.
 * - Exception rate: visits with at least one exception (check-in/out outside the radius
 *   or unreliable, out of MCP order, unplanned) ÷ all visits.
 *
 * Every total sums numerators and denominators before dividing; it never averages people's
 * percentages. Percentages are whole numbers rounded down; null when there is no base.
 */

/** Longest period one read covers (a month). */
export const MAX_PERIOD_DAYS = 31;
export const PRODUCTIVITY_SOURCE =
  "ANA-003 · call answers 2 Oct 2026 · memo 2026-01-20 §2 (provisional KPI definitions)";

export type DayFacts = {
  serviceDate: string;
  /** The 10 PM close has passed: unvisited stops are missed, not pending. */
  closed: boolean;
  sellingDay: boolean;
  planned: number;
  plannedDone: number;
  calls: number;
  productiveCalls: number;
  convertedCalls: number;
  visits: number;
  unplanned: number;
  exceptionVisits: number;
  locationExceptions: number;
  outOfSequence: number;
  orders: number;
  /** PHP centavos. */
  sales: number;
  /** The position's daily call standard on a selling day, else null. */
  callsTarget: number | null;
};

export type PeriodFigures = {
  days: number;
  sellingDays: number;
  planned: number;
  plannedDone: number;
  calls: number;
  productiveCalls: number;
  convertedCalls: number;
  missed: number;
  pending: number;
  visits: number;
  unplanned: number;
  exceptionVisits: number;
  locationExceptions: number;
  outOfSequence: number;
  orders: number;
  sales: number;
  /** Sum of the daily call standard over selling days that have one; null if none. */
  callsTarget: number | null;
};

export type PeriodRates = {
  callsPct: number | null;
  productivePct: number | null;
  conversionPct: number | null;
  /** PHP centavos per actual call, rounded; null without calls. */
  salesPerCall: number | null;
  missedPct: number | null;
  exceptionRatePct: number | null;
  callsTargetPct: number | null;
};

/** Whole percent, rounded down; null without a positive base. */
export function ratePct(part: number, whole: number | null) {
  if (whole === null || whole <= 0) return null;
  return Math.floor((part * 100) / whole);
}

/** Missed stops for one day: only once the day has closed. */
export function missedOf(
  day: Pick<DayFacts, "closed" | "planned" | "plannedDone">,
) {
  return day.closed ? Math.max(day.planned - day.plannedDone, 0) : 0;
}

export function emptyFigures(): PeriodFigures {
  return {
    days: 0,
    sellingDays: 0,
    planned: 0,
    plannedDone: 0,
    calls: 0,
    productiveCalls: 0,
    convertedCalls: 0,
    missed: 0,
    pending: 0,
    visits: 0,
    unplanned: 0,
    exceptionVisits: 0,
    locationExceptions: 0,
    outOfSequence: 0,
    orders: 0,
    sales: 0,
    callsTarget: null,
  };
}

/** One person's period: the sum of their days. */
export function summarizePeriod(days: readonly DayFacts[]): PeriodFigures {
  const out = emptyFigures();
  for (const day of days) {
    const missed = missedOf(day);
    out.days++;
    if (day.sellingDay) out.sellingDays++;
    out.planned += day.planned;
    out.plannedDone += day.plannedDone;
    out.calls += day.calls;
    out.productiveCalls += day.productiveCalls;
    out.convertedCalls += day.convertedCalls;
    out.missed += missed;
    out.pending += day.closed ? 0 : Math.max(day.planned - day.plannedDone, 0);
    out.visits += day.visits;
    out.unplanned += day.unplanned;
    out.exceptionVisits += day.exceptionVisits;
    out.locationExceptions += day.locationExceptions;
    out.outOfSequence += day.outOfSequence;
    out.orders += day.orders;
    out.sales += day.sales;
    if (day.callsTarget !== null)
      out.callsTarget = (out.callsTarget ?? 0) + day.callsTarget;
  }
  return out;
}

const SUMMED = [
  "planned",
  "plannedDone",
  "calls",
  "productiveCalls",
  "convertedCalls",
  "missed",
  "pending",
  "visits",
  "unplanned",
  "exceptionVisits",
  "locationExceptions",
  "outOfSequence",
  "orders",
  "sales",
] as const satisfies readonly (keyof PeriodFigures)[];

/** Team (or channel) totals: the sum of people's period figures. */
export function combineFigures(rows: readonly PeriodFigures[]): PeriodFigures {
  const out = emptyFigures();
  for (const row of rows) {
    for (const key of SUMMED) out[key] += row[key];
    out.days = Math.max(out.days, row.days);
    out.sellingDays = Math.max(out.sellingDays, row.sellingDays);
    if (row.callsTarget !== null)
      out.callsTarget = (out.callsTarget ?? 0) + row.callsTarget;
  }
  return out;
}

export function ratesOf(figures: PeriodFigures): PeriodRates {
  return {
    callsPct: ratePct(figures.calls, figures.planned),
    productivePct: ratePct(figures.productiveCalls, figures.calls),
    conversionPct: ratePct(figures.convertedCalls, figures.calls),
    salesPerCall:
      figures.calls > 0 ? Math.round(figures.sales / figures.calls) : null,
    missedPct: ratePct(
      figures.missed,
      figures.planned - figures.pending > 0
        ? figures.planned - figures.pending
        : null,
    ),
    exceptionRatePct: ratePct(figures.exceptionVisits, figures.visits),
    callsTargetPct: ratePct(figures.calls, figures.callsTarget),
  };
}

const DAY_MS = 86_400_000;

/** Inclusive YYYY-MM-DD dates from `from` to `to`, oldest first (caller validates). */
export function datesBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  const out: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS)
    out.push(new Date(ms).toISOString().slice(0, 10));
  return out;
}

/** Why a period is refused, or null. Both ends are already valid Manila dates. */
export function periodError(from: string, to: string) {
  if (from > to) return "The period must start on or before its end";
  const days =
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
      DAY_MS +
    1;
  if (days > MAX_PERIOD_DAYS)
    return `A period covers at most ${MAX_PERIOD_DAYS} days`;
  return null;
}
