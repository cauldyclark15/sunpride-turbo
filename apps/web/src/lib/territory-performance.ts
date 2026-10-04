/**
 * ANA-004 territory performance dashboard: web mirror of the pure figure rules in
 * `packages/backend/convex/analytics/territory_model.ts` (a test keeps them equal), plus
 * display helpers. The server is authoritative for every per-territory figure; the web only
 * sums territories into totals, ranks and formats. Amounts are PHP centavos.
 */

export const MAX_PERIOD_DAYS = 31;

export type TerritoryFigures = {
  activeOutlets: number;
  buyingOutlets: number;
  planned: number;
  plannedOutlets: number;
  coveredOutlets: number;
  calls: number;
  productiveCalls: number;
  missed: number;
  pending: number;
  orders: number;
  sales: number;
  salesTarget: number | null;
};

export type TerritoryRates = {
  attainmentPct: number | null;
  coveragePct: number | null;
  strikeRatePct: number | null;
  distributionPct: number | null;
  distributionGaps: number;
  planCompletionPct: number | null;
};

export function ratePct(part: number, whole: number | null) {
  if (whole === null || whole <= 0) return null;
  return Math.floor((part * 100) / whole);
}

export function emptyTerritoryFigures(): TerritoryFigures {
  return {
    activeOutlets: 0,
    buyingOutlets: 0,
    planned: 0,
    plannedOutlets: 0,
    coveredOutlets: 0,
    calls: 0,
    productiveCalls: 0,
    missed: 0,
    pending: 0,
    orders: 0,
    sales: 0,
    salesTarget: null,
  };
}

export function territoryRates(figures: TerritoryFigures): TerritoryRates {
  return {
    attainmentPct: ratePct(figures.sales, figures.salesTarget),
    coveragePct: ratePct(figures.coveredOutlets, figures.plannedOutlets),
    strikeRatePct: ratePct(figures.productiveCalls, figures.calls),
    distributionPct: ratePct(figures.buyingOutlets, figures.activeOutlets),
    distributionGaps: Math.max(
      figures.activeOutlets - figures.buyingOutlets,
      0,
    ),
    planCompletionPct: ratePct(figures.calls, figures.planned),
  };
}

const SUMMED = [
  "activeOutlets",
  "buyingOutlets",
  "planned",
  "plannedOutlets",
  "coveredOutlets",
  "calls",
  "productiveCalls",
  "missed",
  "pending",
  "orders",
  "sales",
] as const satisfies readonly (keyof TerritoryFigures)[];

/** Totals: sum numerators and denominators, never average percentages. */
export function combineTerritoryFigures(
  rows: readonly TerritoryFigures[],
): TerritoryFigures {
  const total = emptyTerritoryFigures();
  for (const row of rows) {
    for (const key of SUMMED) total[key] += row[key];
    if (row.salesTarget !== null)
      total.salesTarget = (total.salesTarget ?? 0) + row.salesTarget;
  }
  return total;
}

export type TerritorySortKey =
  "sales" | "attainment" | "coverage" | "strikeRate" | "distributionGaps";

export const TERRITORY_SORTS: [TerritorySortKey, string][] = [
  ["sales", "Sales"],
  ["attainment", "Target attainment"],
  ["coverage", "Coverage"],
  ["strikeRate", "Strike rate"],
  ["distributionGaps", "Distribution gaps"],
];

function rankValue(figures: TerritoryFigures, key: TerritorySortKey) {
  const rates = territoryRates(figures);
  switch (key) {
    case "sales":
      return figures.sales;
    case "attainment":
      return rates.attainmentPct;
    case "coverage":
      return rates.coveragePct;
    case "strikeRate":
      return rates.strikeRatePct;
    case "distributionGaps":
      return figures.activeOutlets ? rates.distributionGaps : null;
  }
}

/** Best first (distribution gaps: most gaps first); missing figures last; ties by code. */
export function rankTerritories<
  T extends { code: string; figures: TerritoryFigures },
>(rows: readonly T[], key: TerritorySortKey): T[] {
  return [...rows].sort((a, b) => {
    const va = rankValue(a.figures, key);
    const vb = rankValue(b.figures, key);
    if (va === null || vb === null) {
      if (va !== vb) return Number(va === null) - Number(vb === null);
    } else if (va !== vb) return vb - va;
    return a.code.localeCompare(b.code);
  });
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

export function manilaToday(now = Date.now()) {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
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

/** True when a territory has a sales target and is below it for the period. */
export function belowTarget(figures: TerritoryFigures) {
  const pct = territoryRates(figures).attainmentPct;
  return pct !== null && pct < 100;
}
