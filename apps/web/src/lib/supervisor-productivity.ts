/**
 * ANA-003 supervisor productivity dashboard: web mirror of the pure figure rules in
 * `packages/backend/convex/analytics/productivity_model.ts` (a test keeps them equal), plus
 * display helpers. The server is authoritative for every per-person figure; the web only
 * sums people into team totals and formats. Amounts are PHP centavos.
 */

export const MAX_PERIOD_DAYS = 31;

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
  callsTarget: number | null;
};

export type PeriodRates = {
  callsPct: number | null;
  productivePct: number | null;
  conversionPct: number | null;
  salesPerCall: number | null;
  missedPct: number | null;
  exceptionRatePct: number | null;
  callsTargetPct: number | null;
};

export function ratePct(part: number, whole: number | null) {
  if (whole === null || whole <= 0) return null;
  return Math.floor((part * 100) / whole);
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

/** Team (or channel) totals: sum numerators and denominators, never average percentages. */
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

export type PeriodPreset = "7" | "14" | "mtd" | "31";
export const PERIOD_PRESETS: [PeriodPreset, string][] = [
  ["7", "Last 7 days"],
  ["14", "Last 14 days"],
  ["mtd", "Month to date"],
  ["31", "Last 31 days"],
];

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The inclusive Manila period ending at `endDate` for a preset. */
export function periodFor(preset: PeriodPreset, endDate: string) {
  if (preset === "mtd")
    return { from: `${endDate.slice(0, 8)}01`, to: endDate };
  return { from: addDays(endDate, -(Number(preset) - 1)), to: endDate };
}

export function pctText(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});

export function pesoText(centavos: number | null) {
  return centavos === null ? "—" : peso.format(centavos / 100);
}

/** PROVISIONAL: exception rate that earns a warning (no client threshold yet). */
export const EXCEPTION_RATE_WARN_PCT = 20;

export type Flag = { key: string; label: string; tone: "danger" | "warning" };

/** What a supervisor should look at for one person (or the team). */
export function productivityFlags(
  figures: PeriodFigures,
  productiveTargetPct: number | null,
): Flag[] {
  const rates = ratesOf(figures);
  const flags: Flag[] = [];
  if (figures.missed > 0)
    flags.push({
      key: "missed",
      label: `${figures.missed} missed`,
      tone: "danger",
    });
  if (
    productiveTargetPct !== null &&
    rates.productivePct !== null &&
    rates.productivePct < productiveTargetPct
  )
    flags.push({
      key: "productive",
      label: `Productive below ${productiveTargetPct}%`,
      tone: "warning",
    });
  if (
    rates.exceptionRatePct !== null &&
    rates.exceptionRatePct >= EXCEPTION_RATE_WARN_PCT
  )
    flags.push({
      key: "exceptions",
      label: `${rates.exceptionRatePct}% exceptions`,
      tone: "warning",
    });
  return flags;
}
