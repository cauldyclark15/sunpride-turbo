import { v, type Infer } from "convex/values";

/**
 * ANA-002 daily execution dashboard: pure rules shared by the read endpoint, its tests and
 * the web mirror (`apps/web/src/lib/execution-dashboard.ts`, kept equal by a test). Nothing
 * here touches the database.
 *
 * Definitions follow `docs/architecture/KPI_DEFINITIONS.md` and the 2 Oct 2026 call answers
 * (which win): a call is a route-plan store visited; it is productive when any one listed
 * activity was recorded (`sfa/productive_call.ts`), judged per visit exactly as the DAR/ROAR
 * and the Daily Sales Report judge it. Higher scopes sum numerators and denominators and
 * then divide; they never average people's percentages.
 */

/** People per dashboard page. A page reads each person's day, so it stays well inside the
 * per-query read limits; the web subscribes to every page of the selected scope. */
export const EXECUTION_PAGE_SIZE = 20;

/** Exceptions listed by name on the dashboard; the full queue lives in Supervision. */
export const MAX_KEY_EXCEPTIONS = 8;

const nullableNumber = v.union(v.number(), v.null());

export const executionPersonRow = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: v.union(v.string(), v.null()),
  positionLabel: v.union(v.string(), v.null()),
  channel: v.string(),
  orgUnitId: v.id("orgUnits"),
  sellingDay: v.boolean(),
  /** Had at least one planned store for the day. */
  scheduled: v.boolean(),
  /** Checked in at least once on the day. */
  active: v.boolean(),
  /** A visit is still open (checked in, not yet checked out). */
  inField: v.boolean(),
  planned: v.number(),
  plannedDone: v.number(),
  plannedOutlets: v.number(),
  coveredOutlets: v.number(),
  calls: v.number(),
  productiveCalls: v.number(),
  unplanned: v.number(),
  /** Position standard on a selling day; null when none applies. */
  callsTarget: nullableNumber,
  productiveTargetPct: nullableNumber,
  /** PHP centavos, from orders attributed to the day the salesman wrote them. */
  sales: v.number(),
  /** PHP centavos: the daily target, or the monthly target spread over selling days. */
  salesTarget: nullableNumber,
  firstCheckInAt: nullableNumber,
  lastActivityAt: nullableNumber,
});
export type ExecutionPersonRow = Infer<typeof executionPersonRow>;

export const executionTotals = v.object({
  people: v.number(),
  scheduled: v.number(),
  active: v.number(),
  inField: v.number(),
  planned: v.number(),
  plannedDone: v.number(),
  plannedOutlets: v.number(),
  coveredOutlets: v.number(),
  calls: v.number(),
  productiveCalls: v.number(),
  unplanned: v.number(),
  /** Calls and call targets of the people who have a call target today. */
  targetedCalls: v.number(),
  callsTarget: v.number(),
  /** Productive and total calls of the people who have a productive-call target today. */
  targetedProductive: v.number(),
  targetedProductiveBase: v.number(),
  /** Sum of each targeted person's productive target × calls (weighted target). */
  productiveTargetWeighted: v.number(),
  sales: v.number(),
  /** Sales and sales targets of the people who have a sales target today. */
  targetedSales: v.number(),
  salesTarget: v.number(),
  peopleWithSalesTarget: v.number(),
});
export type ExecutionTotals = Infer<typeof executionTotals>;

export function emptyTotals(): ExecutionTotals {
  return {
    people: 0,
    scheduled: 0,
    active: 0,
    inField: 0,
    planned: 0,
    plannedDone: 0,
    plannedOutlets: 0,
    coveredOutlets: 0,
    calls: 0,
    productiveCalls: 0,
    unplanned: 0,
    targetedCalls: 0,
    callsTarget: 0,
    targetedProductive: 0,
    targetedProductiveBase: 0,
    productiveTargetWeighted: 0,
    sales: 0,
    targetedSales: 0,
    salesTarget: 0,
    peopleWithSalesTarget: 0,
  };
}

/** Adds one person's day to running totals. */
export function addPerson(
  totals: ExecutionTotals,
  row: ExecutionPersonRow,
): ExecutionTotals {
  const callsTargeted = row.callsTarget !== null;
  const productiveTargeted = row.productiveTargetPct !== null;
  const salesTargeted = row.salesTarget !== null;
  return {
    people: totals.people + 1,
    scheduled: totals.scheduled + Number(row.scheduled),
    active: totals.active + Number(row.active),
    inField: totals.inField + Number(row.inField),
    planned: totals.planned + row.planned,
    plannedDone: totals.plannedDone + row.plannedDone,
    plannedOutlets: totals.plannedOutlets + row.plannedOutlets,
    coveredOutlets: totals.coveredOutlets + row.coveredOutlets,
    calls: totals.calls + row.calls,
    productiveCalls: totals.productiveCalls + row.productiveCalls,
    unplanned: totals.unplanned + row.unplanned,
    targetedCalls: totals.targetedCalls + (callsTargeted ? row.calls : 0),
    callsTarget: totals.callsTarget + (row.callsTarget ?? 0),
    targetedProductive:
      totals.targetedProductive +
      (productiveTargeted ? row.productiveCalls : 0),
    targetedProductiveBase:
      totals.targetedProductiveBase + (productiveTargeted ? row.calls : 0),
    productiveTargetWeighted:
      totals.productiveTargetWeighted +
      (productiveTargeted ? row.productiveTargetPct! * row.calls : 0),
    sales: totals.sales + row.sales,
    targetedSales: totals.targetedSales + (salesTargeted ? row.sales : 0),
    salesTarget: totals.salesTarget + (row.salesTarget ?? 0),
    peopleWithSalesTarget: totals.peopleWithSalesTarget + Number(salesTargeted),
  };
}

/** Sums totals from separate pages (the web adds the pages it subscribed to). */
export function mergeTotals(
  a: ExecutionTotals,
  b: ExecutionTotals,
): ExecutionTotals {
  const out = { ...a };
  for (const key of Object.keys(b) as (keyof ExecutionTotals)[])
    out[key] = a[key] + b[key];
  return out;
}

export function summarize(rows: readonly ExecutionPersonRow[]) {
  return rows.reduce(addPerson, emptyTotals());
}

/** Whole percent, rounded down like every other SFA report; null without a base. */
export function ratioPct(part: number, whole: number) {
  return whole > 0 ? Math.floor((part * 100) / whole) : null;
}

/** The headline figures the dashboard shows for a set of totals. */
export function headline(totals: ExecutionTotals) {
  return {
    salesAttainmentPct: ratioPct(totals.targetedSales, totals.salesTarget),
    callAttainmentPct: ratioPct(totals.targetedCalls, totals.callsTarget),
    productivePct: ratioPct(totals.productiveCalls, totals.calls),
    /** The productive-call target weighted by each targeted person's calls. */
    productiveTargetPct:
      totals.targetedProductiveBase > 0
        ? Math.floor(
            totals.productiveTargetWeighted / totals.targetedProductiveBase,
          )
        : null,
    coveragePct: ratioPct(totals.coveredOutlets, totals.plannedOutlets),
    planCompletionPct: ratioPct(totals.plannedDone, totals.planned),
    activePct: ratioPct(totals.active, totals.scheduled),
  };
}

/**
 * Outlet coverage (KPI definitions): distinct planned outlets with at least one completed
 * visit over distinct planned outlets. Off-plan outlets never raise it.
 */
export function outletCoverage(
  plannedOutletIds: readonly string[],
  doneOutletIds: ReadonlySet<string>,
) {
  const planned = new Set(plannedOutletIds);
  let covered = 0;
  for (const id of planned) if (doneOutletIds.has(id)) covered++;
  return { plannedOutlets: planned.size, coveredOutlets: covered };
}
