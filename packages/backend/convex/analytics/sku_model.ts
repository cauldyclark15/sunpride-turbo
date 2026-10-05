/* ANA-006 SKU distribution dashboard: pure rules shared by the query, its tests and the web
 * mirror (`apps/web/src/lib/sku-distribution.ts`, kept equal by a test). Nothing here
 * touches the database.
 *
 * Definitions (provisional until Sunpride signs the KPIs off, memo §6):
 * - Active stores: active stores assigned to the territory at the end of the period.
 * - Buying store of a SKU: an active store with at least one sale order line of the SKU in
 *   the period, while the store belonged to the territory (DSR sale rules; `orderFigures`
 *   folds lines exactly as the SKU rollups do).
 * - Distribution gap: an active store that did not buy the SKU in the period.
 * - Availability signal: the SKU's status in the store's latest merchandising audit of the
 *   period (available / low stock / out of stock / not carried). Stores never audited in
 *   the period give no signal.
 */

export const SKU_SOURCE =
  "KPI_DEFINITIONS.md (provisional) · memo 2026-01-20 §2 (distribution, OSA) · CVX-030 audits";

/** One SKU's figures in one territory (or summed over several). Money is PHP centavos. */
export type SkuFigures = {
  /** Active stores that bought the SKU in the period. */
  buyingOutlets: number;
  /** Sale orders with a positive line of the SKU. */
  orders: number;
  quantity: number;
  salesMinor: number;
  returnQuantity: number;
  returnsMinor: number;
  /** Active stores whose latest audit in the period recorded the SKU. */
  auditedOutlets: number;
  /** Of those: available or low stock (on shelf). */
  onShelfOutlets: number;
  lowStockOutlets: number;
  outOfStockOutlets: number;
  notCarriedOutlets: number;
};

export type SkuRates = {
  /** Numeric distribution: buying stores out of active stores. */
  distributionPct: number | null;
  distributionGaps: number;
  /** On-shelf availability among audited stores. */
  onShelfPct: number | null;
  netSalesMinor: number;
};

export type ShelfStatus =
  "available" | "low_stock" | "out_of_stock" | "not_carried";

export function emptySkuFigures(): SkuFigures {
  return {
    buyingOutlets: 0,
    orders: 0,
    quantity: 0,
    salesMinor: 0,
    returnQuantity: 0,
    returnsMinor: 0,
    auditedOutlets: 0,
    onShelfOutlets: 0,
    lowStockOutlets: 0,
    outOfStockOutlets: 0,
    notCarriedOutlets: 0,
  };
}

/** Adds one store's latest shelf status for the SKU. */
export function addShelfStatus(figures: SkuFigures, status: ShelfStatus) {
  figures.auditedOutlets++;
  if (status === "available" || status === "low_stock")
    figures.onShelfOutlets++;
  if (status === "low_stock") figures.lowStockOutlets++;
  if (status === "out_of_stock") figures.outOfStockOutlets++;
  if (status === "not_carried") figures.notCarriedOutlets++;
}

/** Whole percent, rounded down; null without a positive base. */
export function ratePct(part: number, whole: number) {
  if (whole <= 0) return null;
  return Math.floor((part * 100) / whole);
}

export function skuRates(figures: SkuFigures, activeOutlets: number): SkuRates {
  return {
    distributionPct: ratePct(figures.buyingOutlets, activeOutlets),
    distributionGaps: Math.max(0, activeOutlets - figures.buyingOutlets),
    onShelfPct: ratePct(figures.onShelfOutlets, figures.auditedOutlets),
    netSalesMinor: figures.salesMinor - figures.returnsMinor,
  };
}

/** Sums figures field by field (territories hold disjoint stores, so stores add up). */
export function combineSkuFigures(rows: readonly SkuFigures[]): SkuFigures {
  const total = emptySkuFigures();
  for (const row of rows)
    for (const key of Object.keys(total) as (keyof SkuFigures)[])
      total[key] += row[key];
  return total;
}

/** Order of gap stores: out of stock first (the most urgent signal), unaudited last. */
const SHELF_RANK: Record<ShelfStatus | "none", number> = {
  out_of_stock: 0,
  low_stock: 1,
  not_carried: 2,
  available: 3,
  none: 4,
};

export function sortGapOutlets<
  T extends { code: string; shelfStatus: ShelfStatus | null },
>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      SHELF_RANK[a.shelfStatus ?? "none"] -
        SHELF_RANK[b.shelfStatus ?? "none"] || a.code.localeCompare(b.code),
  );
}
