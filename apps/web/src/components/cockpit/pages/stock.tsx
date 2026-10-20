"use client";

import { csvHref, useAnalytics } from "../api";
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
import type { StockResponse, StockRow } from "../types";
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
    label: "Value",
    align: "right",
    render: (r) => formatPhp(r.valueCentavos),
    sort: (r) => r.valueCentavos,
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

export function StockView({ data, csv }: { data: StockResponse; csv: string }) {
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
        csvHref={csv}
        title="Every product"
        question="Stock exceptions first. Quantities are cases and pieces."
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
  const result = useAnalytics("stock", query);
  return (
    <CockpitPage
      title="Products & stock"
      question="Is the right stock in the right place?"
      header={result.data}
      bar={
        <PeriodScopeBar
          showChannel={false}
          scopeLabel={result.data?.scope.label}
        />
      }
    >
      <PageData result={result} label="stock figures">
        {(data) => <StockView data={data} csv={csvHref("stock", query)} />}
      </PageData>
    </CockpitPage>
  );
}
