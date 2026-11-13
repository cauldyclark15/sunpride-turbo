"use client";

import Link from "next/link";
import { useState } from "react";
import { useAnalytics } from "../api";
import {
  formatAge,
  formatCount,
  formatPct,
  formatPhp,
  humanize,
} from "../format";
import {
  CockpitPage,
  cumulative,
  DrillTable,
  EmptyState,
  ExceptionList,
  KpiGrid,
  PageData,
  Panel,
  PeriodScopeBar,
  StatusChip,
  TrendChart,
  type DrillColumn,
} from "../kit";
import { TONE_TEXT } from "../kit/tone";
import { canAccessWebModule } from "@/lib/module-access";
import type { FieldStatus, TodayResponse } from "../types";
import {
  AttainmentBar,
  buttonClass,
  linkClass,
  Segmented,
  useCockpitAccess,
  usePageQuery,
} from "./shared";

const FIELD: Array<{
  status: FieldStatus;
  count: keyof TodayResponse["field"]["counts"];
  label: string;
}> = [
  { status: "no_plan", count: "noPlan", label: "No plan" },
  { status: "not_started", count: "notStarted", label: "Not started" },
  { status: "in_call", count: "inCall", label: "In a call" },
  { status: "working", count: "working", label: "Working" },
  { status: "idle", count: "idle", label: "Idle" },
  { status: "done", count: "done", label: "Done" },
];

/** SP-0175: office, admin and manager roles open Today on the field team first. */
export const FIELD_FIRST_ROLES = new Set([
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
]);

type Person = TodayResponse["field"]["people"][number];

/** The day's money first; the field measures sit with the field panel. */
const SALES_KPIS = new Set([
  "salesToday",
  "mtdSales",
  "balanceToSell",
  "perDayNeeded",
]);

export function TodayView({
  data,
  now: nowProp,
  link = (href: string) => href,
  canSetTarget = true,
  canOpenDecide = true,
  fieldFirst = false,
}: {
  data: TodayResponse;
  now?: number;
  link?: (href: string) => string;
  canSetTarget?: boolean;
  /** CROSS r6: only roles that may open /decide get "Open all in Decide". */
  canOpenDecide?: boolean;
  /** SP-0175: put "Field right now" above the sales cards (office roles). */
  fieldFirst?: boolean;
}) {
  const now = nowProp ?? data.freshness.asOf;
  const [field, setField] = useState<FieldStatus | null>(null);
  const [trendMode, setTrendMode] = useState<"daily" | "cumulative">("daily");
  const date = data.period.to;
  const people = field
    ? data.field.people.filter((p) => p.status === field)
    : data.field.people;
  const order: Record<FieldStatus, number> = {
    not_started: 0,
    idle: 1,
    no_plan: 2,
    in_call: 3,
    working: 4,
    done: 5,
  };
  const peopleColumns: DrillColumn<Person>[] = [
    {
      key: "name",
      label: "Person",
      render: (p) => p.name,
      sort: (p) => p.name,
    },
    {
      key: "territory",
      label: "Territory",
      render: (p) => p.territory,
      sort: (p) => p.territory,
    },
    {
      key: "status",
      label: "Status",
      render: (p) => <StatusChip status={p.status} />,
      sort: (p) => order[p.status],
    },
    {
      key: "seen",
      label: "Last seen",
      render: (p) =>
        p.lastSeenAt === null
          ? "Not today"
          : `${formatAge(p.lastSeenAt, now)} ago`,
      sort: (p) => p.lastSeenAt ?? 0,
    },
    {
      key: "stops",
      label: "Stops",
      align: "right",
      render: (p) =>
        p.planned
          ? `${formatCount(p.visited)} of ${formatCount(p.planned)}`
          : "No plan",
      sort: (p) => (p.planned ? p.visited / p.planned : -1),
    },
    {
      key: "productive",
      label: "Productive",
      align: "right",
      render: (p) => formatCount(p.productive),
      sort: (p) => p.productive,
    },
    {
      key: "sales",
      label: "Sales",
      align: "right",
      render: (p) => formatPhp(p.sales),
      sort: (p) => p.sales,
    },
  ];
  const dates = data.trend.map((t) => t.date);
  const sales = data.trend.map((t) => t.sales);
  const targets = data.trend.map((t) => t.target);
  const hasTarget = targets.some((t) => t !== null);
  const salesKpis = data.kpis.filter((k) => SALES_KPIS.has(k.key));
  const fieldKpis = data.kpis.filter((k) => !SALES_KPIS.has(k.key));

  const fieldPanel = (
    <Panel
      title="Field right now"
      question="Who is working, in a call, idle, done or not started yet."
      flush
      actions={
        <Link
          href={link(`/coverage-people?from=${date}&to=${date}`)}
          className={buttonClass}
        >
          Coverage & people
        </Link>
      }
    >
      <div className="grid grid-cols-3 gap-1.5 px-4 pb-3 min-[480px]:grid-cols-6 sm:gap-2 sm:px-5">
        {FIELD.map((item) => {
          const value = data.field.counts[item.count] ?? 0;
          const on = field === item.status;
          return (
            <button
              key={item.status}
              type="button"
              aria-pressed={on}
              onClick={() => setField(on ? null : item.status)}
              className={`rounded-xl border px-2 py-2 text-left transition-colors sm:px-3 ${
                on
                  ? "border-foreground bg-default-soft"
                  : "border-border hover:bg-default-soft/60"
              }`}
            >
              <span className="block text-[22px] font-semibold leading-none tabular-nums text-foreground">
                {formatCount(value)}
              </span>
              <span className="mt-1 block text-[11px] sm:text-[12px] [&>span]:whitespace-normal [&>span]:text-[11px] sm:[&>span]:text-[12px]">
                <StatusChip status={item.status} label={item.label} />
              </span>
            </button>
          );
        })}
      </div>
      <DrillTable
        label="People in the field"
        columns={peopleColumns}
        rows={people}
        rowKey={(p) => p.profileId}
        rowHref={(p) =>
          link(
            `/coverage-people/agent?profileId=${encodeURIComponent(p.profileId)}&date=${date}`,
          )
        }
        initialSort={{ key: "status", dir: "asc" }}
        empty={<EmptyState variant="zero" title="Nobody with this status" />}
      />
    </Panel>
  );

  return (
    <div className="grid gap-4">
      {fieldFirst ? fieldPanel : null}
      <KpiGrid
        kpis={salesKpis}
        canSetTarget={canSetTarget}
        strip
        label="Sales this day and month"
      />

      <div className="grid items-start gap-4 lg:grid-cols-5">
        <Panel
          title="Needs you now"
          question="Up to five urgent items, with who owns each."
          className="lg:col-span-3"
          actions={
            canOpenDecide ? (
              <Link href={link("/decide")} className={buttonClass}>
                Open all in Decide
              </Link>
            ) : undefined
          }
        >
          <ExceptionList items={data.exceptions} now={now} link={link} />
        </Panel>
        <Panel
          title="Sales vs target by channel"
          question="Selected day against its daily target."
          className="lg:col-span-2"
        >
          {data.byChannel.length ? (
            <ul className="grid gap-3">
              {data.byChannel.map((row) => (
                <li key={row.channel} data-channel={row.channel}>
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <Link
                      href={link(
                        `/sales?groupBy=territory&channel=${encodeURIComponent(row.channel)}`,
                      )}
                      className="font-medium text-foreground hover:underline max-lg:-my-3 max-lg:inline-block max-lg:py-3"
                    >
                      {humanize(row.label)}
                    </Link>
                    <span className="tabular-nums text-foreground">
                      {formatPhp(row.sales)}
                      <span
                        className={`ml-2 text-[12px] ${TONE_TEXT[row.status === "unknown" ? "neutral" : row.status]}`}
                      >
                        {row.attainmentPct === null
                          ? ""
                          : formatPct(row.attainmentPct)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <AttainmentBar
                      pct={row.attainmentPct}
                      status={row.status}
                      scale={120}
                    />
                  </div>
                  <p className="mt-1 text-[12px] text-muted tabular-nums">
                    {row.target === null ? (
                      canSetTarget ? (
                        <>
                          No target ·{" "}
                          <Link
                            href={link(
                              `/sales?tab=targets&level=channel&key=${encodeURIComponent(row.channel)}`,
                            )}
                            className={linkClass}
                          >
                            Set target
                          </Link>
                        </>
                      ) : (
                        "No target set"
                      )
                    ) : (
                      <>
                        Daily target {formatPhp(row.target)} ·{" "}
                        {humanize(row.status)}
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              variant="zero"
              title="No sales recorded on this day yet"
            />
          )}
        </Panel>
      </div>

      {fieldKpis.length ? (
        <KpiGrid
          kpis={fieldKpis}
          canSetTarget={canSetTarget}
          strip
          label="Field, cash and vans"
        />
      ) : null}

      {fieldFirst ? null : fieldPanel}

      <div className="grid items-start gap-4 lg:grid-cols-5">
        <Panel
          title="Vans"
          question="Every truck's sales and cash today."
          className="lg:col-span-2"
          actions={
            <Link href={link(`/vans?date=${date}`)} className={buttonClass}>
              Vans & cash
            </Link>
          }
        >
          {data.vans.length ? (
            <ul className="grid gap-2">
              {data.vans.map((van) => {
                const short = van.variance !== null && van.variance < 0;
                return (
                  <li
                    key={van.tripId}
                    data-van={van.tripId}
                    className={`rounded-xl border px-3 py-2.5 ${short || van.status === "unclosed" ? "border-[#c8102e]/40 bg-[#c8102e]/[0.03]" : "border-border"}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {van.truck}
                      </span>
                      <StatusChip status={van.status} />
                    </div>
                    <p className="text-[12px] text-muted">{van.seller}</p>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                      <div>
                        <dt className="text-muted">Sales</dt>
                        <dd className="font-medium tabular-nums text-foreground">
                          {formatPhp(van.salesCentavos)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted">Cash expected</dt>
                        <dd className="font-medium tabular-nums text-foreground">
                          {formatPhp(van.cashExpected)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted">Remitted</dt>
                        <dd className="font-medium tabular-nums text-foreground">
                          {van.cashRemitted === null ? (
                            <span className="text-muted">Not yet</span>
                          ) : (
                            formatPhp(van.cashRemitted)
                          )}
                        </dd>
                      </div>
                    </dl>
                    {van.variance !== null && van.variance !== 0 ? (
                      <p
                        className={`mt-2 text-[12.5px] font-semibold tabular-nums ${short ? "text-[#b4101f]" : "text-[#a15c07]"}`}
                      >
                        {short ? "Short" : "Over"}{" "}
                        {formatPhp(Math.abs(van.variance), { cents: true })}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState variant="zero" title="No van trips today" />
          )}
        </Panel>
        <Panel
          title="Last 14 days"
          question="Daily sales against the daily target. Sundays are not selling days."
          className="lg:col-span-3"
          actions={
            <Segmented
              label="Trend view"
              value={trendMode}
              options={[
                { id: "daily", label: "Daily" },
                { id: "cumulative", label: "Cumulative" },
              ]}
              onChange={setTrendMode}
            />
          }
        >
          <TrendChart
            label="Sales for the last 14 days"
            dates={dates}
            unit="php"
            series={[
              trendMode === "daily"
                ? { key: "sales", label: "Sales", kind: "bar", values: sales }
                : {
                    key: "sales",
                    label: "Sales",
                    kind: "line",
                    values: cumulative(sales),
                  },
              ...(hasTarget
                ? [
                    {
                      key: "target",
                      label: "Target",
                      kind: "target" as const,
                      values:
                        trendMode === "daily" ? targets : cumulative(targets),
                    },
                  ]
                : []),
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}

export function TodayPage() {
  const { query, link } = usePageQuery(["date"]);
  const access = useCockpitAccess();
  const result = useAnalytics("today", query);
  return (
    <CockpitPage
      title="Today"
      question={
        access.isSales
          ? "How is my day going, and what needs me?"
          : "How are we doing right now, and what needs me?"
      }
      header={result.data}
      bar={<PeriodScopeBar mode="day" scopeLabel={result.data?.scope.label} />}
    >
      <PageData result={result} label="today's figures">
        {(data) => (
          <TodayView
            data={data}
            link={link}
            canSetTarget={access.canSetTarget}
            canOpenDecide={canAccessWebModule("decide", access.role)}
            fieldFirst={FIELD_FIRST_ROLES.has(access.role ?? "")}
          />
        )}
      </PageData>
    </CockpitPage>
  );
}
