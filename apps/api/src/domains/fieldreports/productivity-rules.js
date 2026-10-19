/** Source-compatible KPI rules shared with the management web mirror. All money is centavos.
 * @typedef {{days:number,sellingDays:number,planned:number,plannedDone:number,calls:number,productiveCalls:number,convertedCalls:number,missed:number,pending:number,visits:number,unplanned:number,exceptionVisits:number,locationExceptions:number,outOfSequence:number,orders:number,sales:number,callsTarget:number|null}} Figures
 */
export const MAX_PERIOD_DAYS = 31;
/** @param {number} part @param {number|null} whole */
export function ratePct(part, whole) {
  return whole !== null && whole > 0 ? Math.floor((part * 100) / whole) : null;
}
/** @returns {Figures} */
export function emptyFigures() {
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
/** @param {{closed:boolean,planned:number,plannedDone:number}} day */
export function missedOf(day) {
  return day.closed ? Math.max(0, day.planned - day.plannedDone) : 0;
}
/** @type {Array<Exclude<keyof Figures,'callsTarget'>>} */
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
];
/** @param {Figures[]} rows */
export function combineFigures(rows) {
  const out = emptyFigures();
  for (const row of rows) {
    for (const k of SUMMED) out[k] += row[k];
    out.days = Math.max(out.days, row.days);
    out.sellingDays = Math.max(out.sellingDays, row.sellingDays);
    if (row.callsTarget !== null)
      out.callsTarget = (out.callsTarget ?? 0) + row.callsTarget;
  }
  return out;
}
/** @param {any[]} days */
export function summarizePeriod(days) {
  const out = emptyFigures();
  for (const day of days) {
    out.days++;
    if (day.sellingDay) out.sellingDays++;
    for (const k of SUMMED)
      if (k !== "missed" && k !== "pending") out[k] += day[k];
    out.missed += missedOf(day);
    out.pending += day.closed ? 0 : Math.max(0, day.planned - day.plannedDone);
    if (day.callsTarget !== null)
      out.callsTarget = (out.callsTarget ?? 0) + day.callsTarget;
  }
  return out;
}
/** @param {Figures} figures */
export function ratesOf(figures) {
  return {
    callsPct: ratePct(figures.calls, figures.planned),
    productivePct: ratePct(figures.productiveCalls, figures.calls),
    conversionPct: ratePct(figures.convertedCalls, figures.calls),
    salesPerCall: figures.calls
      ? Math.round(figures.sales / figures.calls)
      : null,
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
/** @param {string} from @param {string} to */
export function datesBetween(from, to) {
  const out = [];
  for (
    let at = Date.parse(from + "T00:00:00Z");
    at <= Date.parse(to + "T00:00:00Z");
    at += 86400000
  )
    out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}
/** @param {string} from @param {string} to */
export function periodError(from, to) {
  if (from > to) return "The period must start on or before its end";
  return datesBetween(from, to).length > MAX_PERIOD_DAYS
    ? `A period covers at most ${MAX_PERIOD_DAYS} days`
    : null;
}
