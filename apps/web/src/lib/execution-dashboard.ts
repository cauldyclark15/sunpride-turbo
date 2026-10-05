import type { StatusTone } from "@sunpride/ui";

/**
 * ANA-002 daily execution dashboard: pure view rules. The totals arithmetic mirrors
 * `packages/backend/convex/analytics/model.ts` (a test keeps them equal) so the web can add
 * up the pages it subscribed to without importing Convex server code. Nothing here decides
 * access; the endpoints do.
 */

export type ExecutionRow = {
  profileId: string;
  name: string;
  employeeCode: string | null;
  positionLabel: string | null;
  channel: string;
  sellingDay: boolean;
  scheduled: boolean;
  active: boolean;
  inField: boolean;
  planned: number;
  plannedDone: number;
  plannedOutlets: number;
  coveredOutlets: number;
  calls: number;
  productiveCalls: number;
  unplanned: number;
  callsTarget: number | null;
  productiveTargetPct: number | null;
  sales: number;
  salesTarget: number | null;
  firstCheckInAt: number | null;
  lastActivityAt: number | null;
};

export type ExecutionTotals = {
  people: number;
  scheduled: number;
  active: number;
  inField: number;
  planned: number;
  plannedDone: number;
  plannedOutlets: number;
  coveredOutlets: number;
  calls: number;
  productiveCalls: number;
  unplanned: number;
  targetedCalls: number;
  callsTarget: number;
  targetedProductive: number;
  targetedProductiveBase: number;
  productiveTargetWeighted: number;
  sales: number;
  targetedSales: number;
  salesTarget: number;
  peopleWithSalesTarget: number;
};

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

export function addPerson(
  totals: ExecutionTotals,
  row: ExecutionRow,
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

export function mergeTotals(
  a: ExecutionTotals,
  b: ExecutionTotals,
): ExecutionTotals {
  const out = { ...a };
  for (const key of Object.keys(b) as (keyof ExecutionTotals)[])
    out[key] = a[key] + b[key];
  return out;
}

export function summarize(rows: readonly ExecutionRow[]) {
  return rows.reduce(addPerson, emptyTotals());
}

export function ratioPct(part: number, whole: number) {
  return whole > 0 ? Math.floor((part * 100) / whole) : null;
}

export function headline(totals: ExecutionTotals) {
  return {
    salesAttainmentPct: ratioPct(totals.targetedSales, totals.salesTarget),
    callAttainmentPct: ratioPct(totals.targetedCalls, totals.callsTarget),
    productivePct: ratioPct(totals.productiveCalls, totals.calls),
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

const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

/** Amounts arrive in centavos. */
export function formatCentavos(value: number) {
  return peso.format(value / 100);
}

export function pctLabel(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

const HOUR = 3_600_000;
const MANILA_OFFSET_MS = 8 * HOUR;
/** PROVISIONAL, same as Supervision: a planned person with no check-in by 9 AM is late. */
export const EXPECTED_START_HOUR = 9;
/** Client answer 14 (2 Oct 2026): the field day closes at 10 PM Manila. */
export const DAY_CLOSE_HOUR = 22;

function manilaMidnight(serviceDate: string) {
  return Date.parse(`${serviceDate}T00:00:00.000Z`) - MANILA_OFFSET_MS;
}

export type Flag = { key: string; label: string; tone: StatusTone };

/**
 * What a supervisor should look at for one person. Target misses are only called once the
 * day has closed; during the day a low count is simply work still to do.
 */
export function personFlags(
  row: ExecutionRow,
  serviceDate: string,
  now: number,
): Flag[] {
  const midnight = manilaMidnight(serviceDate);
  const closed = now >= midnight + DAY_CLOSE_HOUR * HOUR;
  const flags: Flag[] = [];
  if (
    row.scheduled &&
    !row.active &&
    now >= midnight + EXPECTED_START_HOUR * HOUR
  )
    flags.push({ key: "not-started", label: "Not started", tone: "danger" });
  if (row.inField)
    flags.push({ key: "in-field", label: "In the field", tone: "neutral" });
  if (closed && row.callsTarget !== null && row.calls < row.callsTarget)
    flags.push({
      key: "calls",
      label: `${row.calls}/${row.callsTarget} calls`,
      tone: "warning",
    });
  const productive = ratioPct(row.productiveCalls, row.calls);
  if (
    closed &&
    row.productiveTargetPct !== null &&
    productive !== null &&
    productive < row.productiveTargetPct
  )
    flags.push({
      key: "productive",
      label: `${productive}% productive`,
      tone: "warning",
    });
  if (row.unplanned)
    flags.push({
      key: "unplanned",
      label: `${row.unplanned} unplanned`,
      tone: "neutral",
    });
  return flags;
}

/** One summary per channel (the client's per-channel "field commander" view). */
export function channelSummaries(rows: readonly ExecutionRow[]) {
  const groups = new Map<string, ExecutionRow[]>();
  for (const row of rows)
    groups.set(row.channel, [...(groups.get(row.channel) ?? []), row]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, members]) => {
      const totals = summarize(members);
      return { id: channel, channel, totals, figures: headline(totals) };
    });
}
