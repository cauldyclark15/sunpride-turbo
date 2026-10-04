/**
 * ANA-006 SKU distribution dashboard: web mirror of the pure rules in
 * `packages/backend/convex/analytics/sku_model.ts` (a test keeps them equal), plus the
 * client-side grouping. The server is authoritative for every per-territory figure; the
 * web only sums territories into SKU totals and territory / channel splits, ranks and
 * formats. Amounts are PHP centavos.
 */

export type SkuFigures = {
  buyingOutlets: number;
  orders: number;
  quantity: number;
  salesMinor: number;
  returnQuantity: number;
  returnsMinor: number;
  auditedOutlets: number;
  onShelfOutlets: number;
  lowStockOutlets: number;
  outOfStockOutlets: number;
  notCarriedOutlets: number;
};

export type SkuRates = {
  distributionPct: number | null;
  distributionGaps: number;
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

export function combineSkuFigures(rows: readonly SkuFigures[]): SkuFigures {
  const total = emptySkuFigures();
  for (const row of rows)
    for (const key of Object.keys(total) as (keyof SkuFigures)[])
      total[key] += row[key];
  return total;
}

export const SHELF_LABELS: Record<ShelfStatus, string> = {
  available: "On shelf",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  not_carried: "Not carried",
};

/** What one territory read returns (the subset the grouping needs). */
export type TerritorySkus = {
  territoryId: string;
  code: string;
  name: string;
  channel: string | null;
  activeOutlets: number;
  auditedOutlets: number;
  skus: {
    productCode: string;
    name: string | null;
    category: string | null;
    figures: SkuFigures;
  }[];
};

export type SkuRow = {
  productCode: string;
  name: string | null;
  category: string | null;
  /** Active stores of the territories summed (every SKU's denominator). */
  activeOutlets: number;
  figures: SkuFigures;
};

/** Sums territories into one row per SKU; a SKU absent from a territory has no buyers there. */
export function skuRows(territories: readonly TerritorySkus[]): SkuRow[] {
  const activeOutlets = territories.reduce((n, t) => n + t.activeOutlets, 0);
  const rows = new Map<string, SkuRow>();
  for (const territory of territories)
    for (const sku of territory.skus) {
      const row = rows.get(sku.productCode) ?? {
        productCode: sku.productCode,
        name: sku.name,
        category: sku.category,
        activeOutlets,
        figures: emptySkuFigures(),
      };
      row.figures = combineSkuFigures([row.figures, sku.figures]);
      rows.set(sku.productCode, row);
    }
  return [...rows.values()];
}

export type SplitRow = {
  key: string;
  label: string;
  detail: string;
  activeOutlets: number;
  figures: SkuFigures;
};

/** One SKU per territory: every territory appears, including those where it never sold. */
export function territorySplit(
  territories: readonly TerritorySkus[],
  productCode: string,
): SplitRow[] {
  return territories.map((territory) => ({
    key: territory.territoryId,
    label: territory.name,
    detail: [territory.code, territory.channel].filter(Boolean).join(" · "),
    activeOutlets: territory.activeOutlets,
    figures:
      territory.skus.find((sku) => sku.productCode === productCode)?.figures ??
      emptySkuFigures(),
  }));
}

/** One SKU per channel (territory channel; territories without one are "No channel"). */
export function channelSplit(
  territories: readonly TerritorySkus[],
  productCode: string,
): SplitRow[] {
  const groups = new Map<string, { row: SplitRow; territories: number }>();
  const split = territorySplit(territories, productCode);
  territories.forEach((territory, index) => {
    const row = split[index]!;
    const key = territory.channel ?? "";
    const group = groups.get(key) ?? {
      row: {
        key: key || "none",
        label: territory.channel ?? "No channel",
        detail: "",
        activeOutlets: 0,
        figures: emptySkuFigures(),
      },
      territories: 0,
    };
    group.territories++;
    group.row.activeOutlets += row.activeOutlets;
    group.row.figures = combineSkuFigures([group.row.figures, row.figures]);
    group.row.detail = `${group.territories} ${group.territories === 1 ? "territory" : "territories"}`;
    groups.set(key, group);
  });
  return [...groups.values()]
    .map((group) => group.row)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export type SkuSortKey = "sales" | "distribution" | "gaps" | "outOfStock";
export const SKU_SORTS: [SkuSortKey, string][] = [
  ["sales", "Sales"],
  ["distribution", "Distribution"],
  ["gaps", "Most gaps"],
  ["outOfStock", "Most out of stock"],
];

function sortValue(row: SkuRow, key: SkuSortKey): number {
  const rates = skuRates(row.figures, row.activeOutlets);
  if (key === "sales") return rates.netSalesMinor;
  if (key === "distribution") return rates.distributionPct ?? -1;
  if (key === "gaps") return rates.distributionGaps;
  return row.figures.outOfStockOutlets;
}

/** Best (or most urgent) first; ties by SKU code. */
export function rankSkus(rows: readonly SkuRow[], key: SkuSortKey): SkuRow[] {
  return [...rows].sort(
    (a, b) =>
      sortValue(b, key) - sortValue(a, key) ||
      a.productCode.localeCompare(b.productCode),
  );
}

/** Case-insensitive match on code, name or category. */
export function matchesSku(row: SkuRow, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [row.productCode, row.name, row.category].some((text) =>
    text?.toLowerCase().includes(needle),
  );
}
