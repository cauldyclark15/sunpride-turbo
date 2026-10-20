"use client";

import { csvHref, useAnalytics } from "../api";
import { formatCases, formatCount, formatPhp, formatTime } from "../format";
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
import type { VanRow, VansResponse } from "../types";
import { usePageQuery } from "./shared";

function Variance({
  value,
  unit,
}: {
  value: number | null;
  unit: "php" | "cases";
}) {
  if (value === null) return <span className="text-muted">Not yet</span>;
  const text =
    value === 0
      ? "Balanced"
      : unit === "php"
        ? `${formatPhp(Math.abs(value), { cents: true })} ${value < 0 ? "short" : "over"}`
        : `${formatCases(Math.abs(value))} ${value > 0 ? "missing" : "extra"}`;
  return (
    <span
      data-variance={value === 0 ? "none" : value < 0 ? "short" : "over"}
      className={
        value === 0
          ? "text-muted"
          : "rounded-md bg-[#c8102e]/[0.08] px-1.5 py-0.5 font-semibold text-[#b4101f]"
      }
    >
      {text}
    </span>
  );
}

export const vanColumns: DrillColumn<VanRow>[] = [
  {
    key: "truck",
    label: "Truck",
    render: (r) => (
      <span className="flex flex-col">
        <span>{r.truck}</span>
        <span className="text-[12px] font-normal text-muted">{r.seller}</span>
      </span>
    ),
    sort: (r) => r.truck,
  },
  {
    key: "status",
    label: "Status",
    render: (r) => (
      <span className="flex flex-col">
        <StatusChip status={r.status} />
        <span className="text-[12px] text-muted">
          {r.closedAt === null
            ? "Still open"
            : `Closed ${formatTime(r.closedAt)}`}
        </span>
      </span>
    ),
    sort: (r) => r.status,
  },
  {
    key: "stock",
    wrap: true,
    label: "Loaded → sold → back",
    align: "right",
    render: (r) => (
      <span className="flex flex-col gap-1">
        <span>
          {formatCount(r.loadedCases)} → {formatCount(r.soldCases)} →{" "}
          {r.returnedCases === null ? (
            <span className="text-muted">on route</span>
          ) : (
            `${formatCount(r.returnedCases)} cs`
          )}
        </span>
        <span className="text-[12px] text-muted">
          Customer returns:{" "}
          {r.customerReturns === undefined
            ? "not recorded"
            : r.customerReturns.length === 0
              ? "none"
              : r.customerReturns
                  .map(
                    (returned) =>
                      `${returned.name} · ${returned.quantity.display}`,
                  )
                  .join("; ")}
        </span>
      </span>
    ),
    sort: (r) => r.soldCases,
  },
  {
    key: "stockVar",
    label: "Stock variance",
    align: "right",
    render: (r) => <Variance value={r.stockVarianceCases} unit="cases" />,
    sort: (r) => r.stockVarianceCases,
  },
  {
    key: "sales",
    label: "Sales",
    align: "right",
    render: (r) => formatPhp(r.salesCentavos),
    sort: (r) => r.salesCentavos,
  },
  {
    key: "cash",
    wrap: true,
    label: "Expected → remitted",
    align: "right",
    render: (r) => (
      <span>
        {formatPhp(r.cashExpected, { cents: true })} →{" "}
        {r.cashRemitted === null ? (
          <span className="text-muted">not yet</span>
        ) : (
          formatPhp(r.cashRemitted, { cents: true })
        )}
      </span>
    ),
    sort: (r) => r.cashExpected,
  },
  {
    key: "variance",
    label: "Cash variance",
    align: "right",
    render: (r) => <Variance value={r.variance} unit="php" />,
    sort: (r) => r.variance,
  },
  {
    key: "voids",
    wrap: true,
    label: "Voids · discounts",
    align: "right",
    render: (r) => (
      <span className={r.voids ? "text-[#a15c07]" : ""}>
        {formatCount(r.voids)} · {formatPhp(r.discountsCentavos)}
      </span>
    ),
    sort: (r) => r.voids,
  },
];

export function VansView({
  data,
  csv,
  link = (href) => href,
}: {
  data: VansResponse;
  csv: string;
  link?: (href: string) => string;
}) {
  return (
    <div className="grid gap-4">
      <KpiGrid kpis={data.kpis} />
      <Panel
        csvHref={csv}
        title="Trips"
        question="Loaded → sold → returned, and cash expected → remitted. Differences are highlighted."
        flush
      >
        <DrillTable
          label="Van trips"
          columns={vanColumns}
          rows={data.rows}
          rowKey={(r) => r.tripId}
          // MOUNT: VanTripsWorkspace (@/components/van) at /van-trips reads ?trip=<tripId>.
          rowHref={(r) =>
            link(`/van-trips?trip=${encodeURIComponent(r.tripId)}`)
          }
          initialSort={{ key: "variance", dir: "asc" }}
          empty={<EmptyState variant="zero" title="No van trips on this day" />}
        />
      </Panel>
    </div>
  );
}

export function VansPage() {
  const { query, link } = usePageQuery(["date"]);
  const result = useAnalytics("vans", query);
  return (
    <CockpitPage
      title="Vans & cash"
      question="Is every truck's stock and money accounted for?"
      header={result.data}
      bar={
        <PeriodScopeBar
          mode="day"
          showChannel={false}
          scopeLabel={result.data?.scope.label}
        />
      }
    >
      <PageData result={result} label="van figures">
        {(data) => (
          <VansView data={data} csv={csvHref("vans", query)} link={link} />
        )}
      </PageData>
    </CockpitPage>
  );
}
