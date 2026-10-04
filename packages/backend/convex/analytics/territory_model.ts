/* ANA-004 territory performance dashboard: pure figure rules shared by the query, its
 * tests and the web mirror (`apps/web/src/lib/territory-performance.ts`, kept equal by a
 * test). Nothing here touches the database.
 *
 * Definitions follow `docs/architecture/KPI_DEFINITIONS.md` and the 2 Oct 2026 call
 * answers (a call is a route-plan store visited; productive = any one listed activity).
 * They stay provisional until Sunpride signs the KPIs off (memo §6).
 */

export const TERRITORY_SOURCE =
  "KPI_DEFINITIONS.md (provisional) · call answers 2 Oct 2026 · memo 2026-01-20 §2";

export const MAX_PERIOD_DAYS = 31;

const DAY = 86_400_000;

/** Figures for one territory over a period of Manila dates. Money is PHP centavos. */
export type TerritoryFigures = {
  /** Active stores assigned to the territory at the end of the period. */
  activeOutlets: number;
  /** Of those, stores with at least one sale (positive order) in the period. */
  buyingOutlets: number;
  /** Planned stops of the signed MCP attributed to this territory (not cancelled/replaced). */
  planned: number;
  /** Distinct stores with at least one planned stop. */
  plannedOutlets: number;
  /** Distinct planned stores visited and checked out at least once. */
  coveredOutlets: number;
  /** Planned stops visited and checked out (one call per stop). */
  calls: number;
  productiveCalls: number;
  /** Planned stops of a closed day (after the 10 PM close) with no completed visit. */
  missed: number;
  /** Planned stops of a day still open with no completed visit yet. */
  pending: number;
  orders: number;
  sales: number;
  /** Sum of the territory's sales targets over the period's days; null if none set. */
  salesTarget: number | null;
};

export type TerritoryRates = {
  attainmentPct: number | null;
  coveragePct: number | null;
  strikeRatePct: number | null;
  distributionPct: number | null;
  /** Active stores with no sale in the period. */
  distributionGaps: number;
  planCompletionPct: number | null;
};

/** Whole percent, rounded down; null without a positive base. */
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
] as const;

/**
 * Totals across territories: numerators and denominators are summed, then divided; never
 * an average of percentages. The target total is null only when no territory has one.
 */
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

/** Ranking value: higher ranks first, except distribution gaps (most gaps first, too). */
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

/**
 * Ranks territories best first by the chosen measure (distribution gaps: most gaps first,
 * the place to act). Territories without a figure (no target, no calls) go last; ties keep
 * the territory code order.
 */
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

/** Manila dates from `from` to `to` inclusive (both `YYYY-MM-DD`). */
export function datesBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const dates: string[] = [];
  for (let ms = start; ms <= end; ms += DAY)
    dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}

/** Why a period is not allowed, or null when it is. */
export function periodError(from: string, to: string): string | null {
  if (from > to) return "Period start must not be after its end";
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1;
  if (days > MAX_PERIOD_DAYS)
    return `Pick a period of at most ${MAX_PERIOD_DAYS} days`;
  return null;
}
