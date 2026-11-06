"use client";

import { csvHref, useAnalytics, useValuation, valuationCsvHref } from "../api";
import {
  formatCases,
  formatCasesPieces,
  formatCount,
  formatPct,
  formatPhp,
  humanize,
} from "../format";
import {
  CockpitPage,
  DrillTable,
  EmptyState,
  KpiGrid,
  PageData,
  Panel,
  PeriodScopeBar,
  StatusChip,
  type DrillColumn,
} from "../kit";
import type {
  Kpi,
  StockResponse,
  StockRow,
  ValuationResponse,
  ValuationRow,
} from "../types";
import { usePageQuery } from "./shared";

const STATUS_RANK: Record<string, number> = {
  behind: 0,
  watch: 1,
  unknown: 4,
  out: 0,
  low: 1,
  overstock: 2,
  ok: 3,
};

export const stockColumns: DrillColumn<StockRow>[] = [
  {
    key: "name",
    label: "Product",
    render: (r) => (
      <span className="flex flex-col">
        <span>{r.name}</span>
        <span className="text-[12px] font-normal text-muted">{r.code}</span>
      </span>
    ),
    sort: (r) => r.name,
  },
  {
    key: "category",
    label: "Category",
    render: (r) => r.category,
    sort: (r) => r.category,
  },
  {
    key: "onHand",
    label: "On hand",
    align: "right",
    render: (r) =>
      r.onHand.display || formatCasesPieces(r.onHand.cases, r.onHand.pieces),
    sort: (r) => r.onHand.cases,
  },
  {
    key: "value",
    label: "Cost value",
    align: "right",
    render: (r) =>
      r.costKnown === false ? (
        <span className="text-[#a15c07]" title="No cost recorded yet">
          No cost yet
        </span>
      ) : (
        formatPhp(r.valueCentavos)
      ),
    sort: (r) => r.valueCentavos,
  },
  {
    key: "sellingValue",
    label: "Selling value",
    align: "right",
    render: (r) =>
      r.sellingValueCentavos === undefined ? (
        <span className="text-muted">—</span>
      ) : r.sellingValueCentavos === null ? (
        <span className="text-muted">No price yet</span>
      ) : (
        formatPhp(r.sellingValueCentavos)
      ),
    sort: (r) => r.sellingValueCentavos ?? null,
  },
  {
    key: "rate",
    label: "Sells a day",
    align: "right",
    render: (r) => formatCases(r.avgDailySalesCases),
    sort: (r) => r.avgDailySalesCases,
  },
  {
    key: "cover",
    label: "Days of cover",
    align: "right",
    render: (r) =>
      r.daysCover === null ? (
        <span className="text-muted">Not sold lately</span>
      ) : (
        <span
          className={
            r.status === "out" || r.status === "low"
              ? "font-semibold text-[#b4101f]"
              : ""
          }
        >
          {formatCount(r.daysCover)} {r.daysCover === 1 ? "day" : "days"}
        </span>
      ),
    sort: (r) => r.daysCover,
  },
  {
    key: "reach",
    label: "Stocking distribution",
    align: "right",
    render: (r) => formatPct(r.numericDistributionPct),
    sort: (r) => r.numericDistributionPct,
  },
  {
    key: "buyingReach",
    label: "Buying reach",
    align: "right",
    render: (r) => formatPct(r.buyingReachPct ?? null),
    sort: (r) => r.buyingReachPct ?? null,
  },
  {
    key: "weighted",
    label: "Weighted stocking",
    align: "right",
    render: (r) => formatPct(r.weightedDistributionPct ?? null),
    sort: (r) => r.weightedDistributionPct ?? null,
  },
  {
    key: "unmeasured",
    label: "Not checked",
    align: "right",
    render: (r) => formatCount(r.unmeasuredStores ?? null),
    sort: (r) => r.unmeasuredStores ?? null,
  },
  {
    key: "oos",
    label: "Out at stores",
    align: "right",
    render: (r) => (
      <span className={r.oosStores ? "text-[#a15c07]" : "text-muted"}>
        {formatCount(r.oosStores)}
      </span>
    ),
    sort: (r) => r.oosStores,
  },
  {
    key: "status",
    label: "Status",
    render: (r) => <StatusChip status={r.status} />,
    sort: (r) => STATUS_RANK[r.status] ?? 4,
  },
];

export type StockViewData = Pick<StockResponse, "kpis" | "locations" | "rows">;

const stockKpi = (
  key: string,
  label: string,
  unit: Kpi["unit"],
  value: number | null,
  definition: string,
  status: Kpi["status"] = "ok",
): Kpi => ({
  key,
  label,
  value,
  unit,
  target: null,
  prior: null,
  deltaPct: null,
  status: value === null ? "unknown" : status,
  definition,
});

/**
 * IP-INT2: the stock page's numbers (what is on hand, what it is worth) come from /inventory/valuation, the same figures
 * as Stock on hand and the stock cards. Cost value is first, selling value second. Analytics only adds the selling-rate
 * columns (days of cover, reach) for the same product, when it has them.
 */
export function stockFromValuation(
  valuation: ValuationResponse,
  sales: Pick<StockResponse, "rows"> | null,
): StockViewData {
  const byProduct = new Map<string, ValuationRow[]>();
  for (const r of valuation.rows) {
    const list = byProduct.get(r.productId) ?? [];
    list.push(r);
    byProduct.set(r.productId, list);
  }
  const analytics = new Map((sales?.rows ?? []).map((r) => [r.productId, r]));
  const rows: StockRow[] = [...byProduct.values()].map((list) => {
    const first = list[0]!;
    const base = list.reduce((n, r) => n + r.onHand.base, 0);
    const perCase = first.units?.basePerCase ?? null;
    const onHand =
      list.length === 1
        ? {
            cases: first.onHand.cases ?? 0,
            pieces: first.onHand.pieces ?? 0,
            display: first.onHand.display,
          }
        : perCase
          ? {
              cases: Math.floor(base / perCase),
              pieces: base % perCase,
              display: formatCasesPieces(
                Math.floor(base / perCase),
                base % perCase,
              ),
            }
          : { cases: 0, pieces: base, display: `${base} pc` };
    const known = list.every((r) => r.costKnown);
    const priced = list.every((r) => r.sellingValueCentavos !== null);
    const sold = analytics.get(first.productId);
    return {
      productId: first.productId,
      code: first.code,
      name: first.name,
      category: first.category ?? "",
      onHand,
      valueCentavos: list.reduce((n, r) => n + r.costValueCentavos, 0),
      costKnown: known,
      sellingValueCentavos: priced
        ? list.reduce((n, r) => n + (r.sellingValueCentavos ?? 0), 0)
        : null,
      avgDailySalesCases: sold?.avgDailySalesCases ?? null,
      daysCover: sold?.daysCover ?? null,
      numericDistributionPct: sold?.numericDistributionPct ?? null,
      buyingReachPct: sold?.buyingReachPct ?? null,
      weightedDistributionPct: sold?.weightedDistributionPct ?? null,
      unmeasuredStores: sold?.unmeasuredStores,
      oosStores: sold?.oosStores ?? 0,
      status: sold?.status ?? "unknown",
    };
  });
  const places = new Map<
    string,
    { label: string; valueCentavos: number; cases: number }
  >();
  for (const r of valuation.rows) {
    const place = places.get(r.locationId) ?? {
      label: r.locationName ?? "Place",
      valueCentavos: 0,
      cases: 0,
    };
    place.valueCentavos += r.costValueCentavos;
    place.cases += r.onHand.cases ?? 0;
    places.set(r.locationId, place);
  }
  const t = valuation.totals;
  return {
    kpis: [
      stockKpi(
        "stockValue",
        "Stock value (at cost)",
        "php",
        t.costValueCentavos,
        "Everything on hand valued at the weighted average cost the stock ledger keeps. Same figure as Stock on hand.",
      ),
      stockKpi(
        "sellingValue",
        "Selling value",
        "php",
        t.sellingValueCentavos,
        "The same stock at today's selling price. Shown second; cost is the figure to trust.",
      ),
      stockKpi(
        "withoutCost",
        "Products with no cost yet",
        "count",
        t.rowsWithoutCost,
        "Stock with no cost on record. Its value above is not real cost until a receipt or count gives it one.",
        t.rowsWithoutCost ? "watch" : "ok",
      ),
      stockKpi(
        "withoutPrice",
        "Products with no price yet",
        "count",
        t.rowsWithoutPrice,
        "Stock with no selling price. It is left out of the selling value, never counted as zero.",
        t.rowsWithoutPrice ? "watch" : "ok",
      ),
    ],
    locations: [...places].map(([locationId, p]) => ({
      locationId,
      label: p.label,
      kind: /truck|van/i.test(p.label) ? "truck" : "depot",
      valueCentavos: p.valueCentavos,
      cases: p.cases,
    })),
    rows,
  };
}

export function StockView({
  data,
  csv,
  valuationCsv,
}: {
  data: StockViewData;
  csv: string;
  /** CSV of the valuation (pesos, cost value column first). When set it replaces the analytics Excel link. */
  valuationCsv?: string;
}) {
  return (
    <div className="grid gap-4">
      <KpiGrid kpis={data.kpis} />
      <Panel title="Where the stock is" question="Value and cases by location.">
        {data.locations.length ? (
          <ul className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {data.locations.map((loc) => (
              <li
                key={loc.locationId}
                data-location={loc.locationId}
                className="rounded-xl border border-border px-3 py-2.5"
              >
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  {humanize(loc.kind)}
                </p>
                <p
                  className="mt-0.5 truncate text-[13px] font-medium text-foreground"
                  title={loc.label}
                >
                  {loc.label}
                </p>
                <p className="mt-1 text-[17px] font-semibold tabular-nums text-foreground">
                  {loc.valueCentavos === null ? (
                    <span className="text-muted">Not valued</span>
                  ) : (
                    formatPhp(loc.valueCentavos)
                  )}
                </p>
                <p className="text-[12px] tabular-nums text-muted">
                  {formatCases(loc.cases)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            variant="setup"
            title="No stock locations yet"
            action={{ label: "Open Inventory", href: "/inventory" }}
          />
        )}
      </Panel>
      <Panel
        {...(valuationCsv
          ? {
              actions: (
                <a
                  href={valuationCsv}
                  download
                  className="ck-noprint inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground hover:bg-default-soft"
                >
                  Download CSV (pesos)
                </a>
              ),
            }
          : { csvHref: csv })}
        title="Every product"
        question="Stock exceptions first. Quantities are cases and pieces; cost value comes first, selling value second."
        flush
      >
        <DrillTable
          label="Stock by product"
          columns={stockColumns}
          rows={data.rows}
          rowKey={(r) => r.productId}
          initialSort={{ key: "status", dir: "asc" }}
          empty={
            <EmptyState
              variant="setup"
              title="No opening stock recorded"
              action={{ label: "Import opening stock", href: "/imports" }}
            />
          }
        />
      </Panel>
    </div>
  );
}

export function StockPage() {
  const { query } = usePageQuery();
  const valuation = useValuation(query);
  const sales = useAnalytics("stock", query);
  return (
    <CockpitPage
      title="Products & stock"
      question="Is the right stock in the right place?"
      header={sales.data}
      bar={
        <PeriodScopeBar
          showChannel={false}
          scopeLabel={sales.data?.scope.label}
        />
      }
    >
      <PageData result={valuation} label="stock figures">
        {(data) => (
          <StockView
            data={stockFromValuation(data, sales.data ?? null)}
            csv={csvHref("stock", query)}
            valuationCsv={valuationCsvHref(query)}
          />
        )}
      </PageData>
    </CockpitPage>
  );
}
