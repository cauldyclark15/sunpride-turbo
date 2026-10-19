"use client";

import Link from "next/link";
import { useState } from "react";
import { csvHref, useAnalytics } from "../api";
import { breadcrumbs, decodeCrumbs, drillHref, GROUP_LABEL } from "../drill";
import { formatCount, formatDelta, formatPct, formatPhp } from "../format";
import {
  Breadcrumbs,
  CockpitPage,
  DrillTable,
  EmptyState,
  KpiGrid,
  PageData,
  Panel,
  PeriodScopeBar,
  StatusChip,
  TrendChart,
  type DrillColumn,
} from "../kit";
import type { SalesGroupBy, SalesResponse, SalesRow } from "../types";
import {
  AttainmentBar,
  linkClass,
  Segmented,
  useCockpitAccess,
  usePageQuery,
} from "./shared";
import { TargetsEditor } from "./targets-editor";

const GROUPS: SalesGroupBy[] = [
  "channel",
  "territory",
  "agent",
  "category",
  "sku",
  "store",
];
const TARGET_LEVELS = new Set(["channel", "territory", "agent"]);

export function salesColumns(
  groupBy: SalesGroupBy,
  options: { canSetTarget: boolean; link: (href: string) => string },
): DrillColumn<SalesRow>[] {
  return [
    {
      key: "label",
      label: GROUP_LABEL[groupBy],
      render: (r) => r.label,
      sort: (r) => r.label,
    },
    {
      key: "sales",
      label: "Sales",
      align: "right",
      render: (r) => formatPhp(r.sales),
      sort: (r) => r.sales,
    },
    {
      key: "target",
      label: "Target",
      align: "right",
      render: (r) =>
        r.target !== null ? (
          formatPhp(r.target)
        ) : TARGET_LEVELS.has(groupBy) && options.canSetTarget ? (
          <Link
            href={options.link(
              `/sales?tab=targets&level=${groupBy}&key=${encodeURIComponent(r.key)}`,
            )}
            className={linkClass}
          >
            Set target
          </Link>
        ) : (
          <span className="text-muted">No target</span>
        ),
      sort: (r) => r.target,
    },
    {
      key: "attainment",
      label: "Attainment",
      render: (r) => (
        <span className="flex min-w-28 items-center gap-2">
          <AttainmentBar pct={r.attainmentPct} status={r.status} />
          <span className="w-12 shrink-0 text-right">
            {formatPct(r.attainmentPct)}
          </span>
        </span>
      ),
      sort: (r) => r.attainmentPct,
    },
    {
      key: "delta",
      label: "vs prior",
      align: "right",
      render: (r) => {
        const d = formatDelta(r.deltaPct);
        return (
          <span
            className={
              d.direction === "up"
                ? "text-[#1f7a43]"
                : d.direction === "down"
                  ? "text-[#b4101f]"
                  : "text-muted"
            }
          >
            {d.direction === "none" ? "—" : d.text}
          </span>
        );
      },
      sort: (r) => r.deltaPct,
    },
    {
      key: "orders",
      label: "Orders",
      align: "right",
      render: (r) => formatCount(r.orders),
      sort: (r) => r.orders,
    },
    {
      key: "drop",
      label: "Drop size",
      align: "right",
      render: (r) => formatPhp(r.dropSize),
      sort: (r) => r.dropSize,
    },
    {
      key: "ubo",
      label: "Buying stores",
      align: "right",
      render: (r) => formatCount(r.ubo),
      sort: (r) => r.ubo,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusChip status={r.status} />,
      sort: (r) => ({ behind: 0, watch: 1, ok: 2, unknown: 3 })[r.status],
    },
  ];
}

export function SalesView({
  data,
  groupBy,
  pathname,
  params,
  csv,
  link = (href) => href,
  canSetTarget = true,
  onGroupBy,
}: {
  onGroupBy?: (groupBy: SalesGroupBy) => void;
  data: SalesResponse;
  groupBy: SalesGroupBy;
  pathname: string;
  params: URLSearchParams;
  csv: string;
  link?: (href: string) => string;
  canSetTarget?: boolean;
}) {
  const [mode, setMode] = useState<"cumulative" | "daily">("cumulative");
  const first = decodeCrumbs(params)[0];
  const rootGroupBy = first ? (first.parent.split(":")[0] ?? groupBy) : groupBy;
  const crumbs = breadcrumbs(pathname, params, {
    label: `All of ${data.scope.label}`,
    groupBy: rootGroupBy,
  });
  const dates = data.trend.map((t) => t.date);
  const total = data.stages.booked;
  const stages = [
    {
      key: "booked",
      label: "Booked",
      value: data.stages.booked,
      note: "Every order that counts as sales",
    },
    {
      key: "approved",
      label: "Approved",
      value: data.stages.approved,
      note: "Passed credit and price checks",
    },
    {
      key: "posted",
      label: "Posted",
      value: data.stages.posted,
      note: "Posted, fulfilled or sent to SAP",
    },
  ];
  return (
    <div className="grid gap-4">
      <KpiGrid kpis={data.kpis} canSetTarget={canSetTarget} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title={
            mode === "cumulative"
              ? "Running total against target"
              : "Daily sales"
          }
          question={
            mode === "cumulative"
              ? "Where the month is heading, against target and the prior period."
              : "Each day's sales."
          }
          className="lg:col-span-2"
          actions={
            <Segmented
              label="Chart"
              value={mode}
              options={[
                { id: "cumulative", label: "Cumulative" },
                { id: "daily", label: "Daily" },
              ]}
              onChange={setMode}
            />
          }
        >
          <TrendChart
            label="Sales trend"
            dates={dates}
            height={220}
            series={
              mode === "cumulative"
                ? [
                    {
                      key: "cumSales",
                      label: "Sales",
                      kind: "line",
                      values: data.trend.map((t) => t.cumSales),
                    },
                    ...(data.trend.some((t) => t.cumTarget !== null)
                      ? [
                          {
                            key: "cumTarget",
                            label: "Target",
                            kind: "target" as const,
                            values: data.trend.map((t) => t.cumTarget),
                          },
                        ]
                      : []),
                    {
                      key: "cumPrior",
                      label:
                        data.compare.from.slice(0, 4) <
                        data.period.from.slice(0, 4)
                          ? "Last year"
                          : "Prior period",
                      kind: "prior",
                      values: data.trend.map((t) => t.cumPrior),
                    },
                  ]
                : [
                    {
                      key: "sales",
                      label: "Sales",
                      kind: "bar",
                      values: data.trend.map((t) => t.sales),
                    },
                  ]
            }
          />
        </Panel>
        <Panel
          title="From order to posting"
          question="How much of the sales has moved through each step."
        >
          <ol className="grid gap-3">
            {stages.map((stage) => (
              <li key={stage.key} data-stage={stage.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium text-foreground">
                    {stage.label}
                  </span>
                  <span className="text-[15px] font-semibold tabular-nums text-foreground">
                    {formatPhp(stage.value)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-default-soft">
                  <div
                    className="h-full rounded-full bg-foreground"
                    style={{
                      width: `${total ? Math.round((stage.value / total) * 100) : 0}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-[12px] text-muted">
                  {total
                    ? `${formatPct(Math.round((stage.value / total) * 1000) / 10)} of booked · `
                    : ""}
                  {stage.note}
                </p>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
      <Panel
        csvHref={csv}
        title={`Sales by ${GROUP_LABEL[groupBy].toLowerCase()}`}
        question="Behind first. Click a row to drill down."
        flush
        actions={
          <label className="flex items-center gap-2 text-[12px] text-muted">
            View by
            <select
              aria-label="View by"
              className="!min-h-8 h-8 !rounded-lg !text-[13px]"
              value={groupBy}
              onChange={(event) =>
                onGroupBy?.(event.target.value as SalesGroupBy)
              }
            >
              {GROUPS.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </label>
        }
      >
        <div className="px-4 pb-2 sm:px-5">
          <Breadcrumbs items={crumbs} />
        </div>
        <DrillTable
          label={`Sales by ${GROUP_LABEL[groupBy].toLowerCase()}`}
          columns={salesColumns(groupBy, { canSetTarget, link })}
          rows={data.rows}
          rowKey={(r) => r.key}
          rowHref={(r) =>
            r.drill
              ? drillHref(pathname, params, { label: r.label, drill: r.drill })
              : null
          }
          initialSort={{ key: "status", dir: "asc" }}
          empty={
            <EmptyState variant="zero" title="No sales in this period">
              Nothing was sold here between these dates.
            </EmptyState>
          }
        />
      </Panel>
    </div>
  );
}

export function SalesPage() {
  const { query, params, pathname, link, set } = usePageQuery([
    "groupBy",
    "parent",
  ]);
  const access = useCockpitAccess();
  const tab = params.get("tab") === "targets" ? "targets" : "performance";
  const groupBy = (
    GROUPS.includes(params.get("groupBy") as SalesGroupBy)
      ? params.get("groupBy")
      : "territory"
  ) as SalesGroupBy;
  const result = useAnalytics(
    "sales",
    tab === "performance" ? { ...query, groupBy } : null,
  );
  return (
    <CockpitPage
      title="Sales & targets"
      question="Are we on target, and where are we behind?"
      header={tab === "performance" ? result.data : undefined}
      bar={
        <div className="grid gap-3">
          <Segmented
            label="Sales view"
            value={tab}
            options={[
              { id: "performance", label: "Performance" },
              {
                id: "targets",
                label: access.canSetTarget ? "Set targets" : "Targets",
              },
            ]}
            onChange={(next) =>
              set({ tab: next === "targets" ? "targets" : null })
            }
          />
          {tab === "performance" ? (
            <PeriodScopeBar scopeLabel={result.data?.scope.label} />
          ) : null}
        </div>
      }
    >
      {tab === "targets" ? (
        <TargetsEditor canEdit={access.canSetTarget} />
      ) : (
        <PageData result={result} label="sales figures">
          {(data) => (
            <SalesView
              data={data}
              groupBy={groupBy}
              pathname={pathname}
              params={params}
              csv={csvHref("sales", { ...query, groupBy })}
              link={link}
              canSetTarget={access.canSetTarget}
              onGroupBy={(next) =>
                set({ groupBy: next, parent: null, crumb: null })
              }
            />
          )}
        </PageData>
      )}
    </CockpitPage>
  );
}
