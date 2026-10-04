"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  MetricCard,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useQueries, useQuery, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import {
  channelSummaries,
  formatCentavos,
  headline,
  mergeTotals,
  pctLabel,
  personFlags,
  ratioPct,
  emptyTotals,
  type ExecutionRow,
  type ExecutionTotals,
} from "../../lib/execution-dashboard";
import { PanelErrorBoundary } from "../panel-error-boundary";
import {
  EXCEPTION_LABELS,
  formatTime,
  manilaToday,
  reasonLabel,
  type SupervisionFilters,
} from "../supervision/supervision-model";

type DayPage = FunctionReturnType<typeof api.analytics.execution.day>;
type Exceptions = FunctionReturnType<typeof api.analytics.execution.exceptions>;
type PersonRow = DayPage["rows"][number] & { id: string };

/** The viewer's clock, refreshed every minute, for time-based flags. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function salesDetail(totals: ExecutionTotals) {
  const pct = headline(totals).salesAttainmentPct;
  if (pct === null) return "No sales target";
  return `${pct}% of ${formatCentavos(totals.salesTarget)} target`;
}

export function ExecutionDashboardView({
  serviceDate,
  rows,
  totals,
  peopleInScope,
  loading,
  truncated,
  exceptions,
  now,
}: {
  serviceDate: string;
  rows: readonly ExecutionRow[];
  totals: ExecutionTotals;
  peopleInScope: number;
  loading: boolean;
  truncated: boolean;
  exceptions: Exceptions | undefined;
  now: number;
}) {
  const figures = headline(totals);
  const people: PersonRow[] = rows.map((row) => ({
    ...(row as DayPage["rows"][number]),
    id: row.profileId,
  }));
  const channels = channelSummaries(rows);

  const personColumns: DataColumn<PersonRow>[] = [
    {
      key: "person",
      label: "Person",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.name}
          </span>
          <span className="font-mono text-xs text-muted">
            {[row.employeeCode, row.channel].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "calls",
      label: "Calls",
      align: "right",
      render: (row) =>
        row.callsTarget === null
          ? String(row.calls)
          : `${row.calls}/${row.callsTarget}`,
    },
    {
      key: "productive",
      label: "Productive",
      align: "right",
      render: (row) =>
        `${row.productiveCalls} · ${pctLabel(ratioPct(row.productiveCalls, row.calls))}`,
    },
    {
      key: "coverage",
      label: "Coverage",
      align: "right",
      render: (row) =>
        row.plannedOutlets
          ? `${row.coveredOutlets}/${row.plannedOutlets}`
          : "—",
    },
    {
      key: "sales",
      label: "Sales",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end">
          <span className="tabular-nums">{formatCentavos(row.sales)}</span>
          <span className="text-xs text-muted">
            {row.salesTarget === null
              ? "No target"
              : `${pctLabel(ratioPct(row.sales, row.salesTarget))} of target`}
          </span>
        </span>
      ),
    },
    {
      key: "first",
      label: "First in",
      align: "right",
      render: (row) => (
        <span className="font-mono text-[13px]">
          {formatTime(row.firstCheckInAt)}
        </span>
      ),
    },
    {
      key: "flags",
      label: "Flags",
      render: (row) => {
        const flags = personFlags(row, serviceDate, now);
        return flags.length ? (
          <span className="flex flex-wrap gap-1">
            {flags.map((flag) => (
              <StatusPill key={flag.key} tone={flag.tone}>
                {flag.label}
              </StatusPill>
            ))}
          </span>
        ) : (
          <span className="text-muted">—</span>
        );
      },
    },
  ];

  const channelColumns: DataColumn<(typeof channels)[number]>[] = [
    {
      key: "channel",
      label: "Channel",
      render: (row) => (
        <span className="text-sm font-medium text-foreground">
          {row.channel}
        </span>
      ),
    },
    {
      key: "active",
      label: "Active",
      align: "right",
      render: (row) => `${row.totals.active}/${row.totals.scheduled}`,
    },
    {
      key: "calls",
      label: "Calls",
      align: "right",
      render: (row) =>
        row.totals.callsTarget
          ? `${row.totals.calls} · ${pctLabel(row.figures.callAttainmentPct)} of target`
          : String(row.totals.calls),
    },
    {
      key: "productive",
      label: "Productive",
      align: "right",
      render: (row) => pctLabel(row.figures.productivePct),
    },
    {
      key: "coverage",
      label: "Coverage",
      align: "right",
      render: (row) => pctLabel(row.figures.coveragePct),
    },
    {
      key: "sales",
      label: "Sales",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end">
          <span className="tabular-nums">
            {formatCentavos(row.totals.sales)}
          </span>
          <span className="text-xs text-muted">{salesDetail(row.totals)}</span>
        </span>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          label="Sales"
          value={formatCentavos(totals.sales)}
          detail={salesDetail(totals)}
        />
        <MetricCard
          label="Call target"
          value={pctLabel(figures.callAttainmentPct)}
          detail={
            totals.callsTarget
              ? `${totals.targetedCalls} of ${totals.callsTarget} calls`
              : "No call target today"
          }
        />
        <MetricCard
          label="Productive calls"
          value={pctLabel(figures.productivePct)}
          detail={`${totals.productiveCalls} of ${totals.calls} calls${
            figures.productiveTargetPct === null
              ? ""
              : ` · target ${figures.productiveTargetPct}%`
          }`}
        />
        <MetricCard
          label="Coverage"
          value={pctLabel(figures.coveragePct)}
          detail={`${totals.coveredOutlets} of ${totals.plannedOutlets} planned outlets`}
        />
        <MetricCard
          label="Active field force"
          value={`${totals.active}/${totals.scheduled}`}
          detail={`${totals.inField} in the field now · ${totals.people} people`}
        />
        <MetricCard
          label="Exceptions"
          value={exceptions ? String(exceptions.total) : "—"}
          detail={exceptions ? `${exceptions.open} to review` : "Loading…"}
        />
      </div>
      {loading ? (
        <p className="text-[13px] text-muted">
          Loading {people.length} of {peopleInScope} people…
        </p>
      ) : null}
      {truncated ? (
        <p className="text-[13px] text-muted">
          Only the first {peopleInScope} people are counted. Pick a unit or
          channel.
        </p>
      ) : null}
      <p className="text-[13px] text-muted">
        Provisional KPI definitions: not for pay or disciplinary decisions until
        Sunpride signs them off.
      </p>
      {people.length === 0 && !loading ? (
        <Card label="Field force" icon={<WorkspaceIcon name="user" />}>
          <p className="text-[13px] text-muted">No field people here</p>
        </Card>
      ) : (
        <>
          <Card
            label="By channel"
            count={channels.length}
            icon={<WorkspaceIcon name="field" />}
            flush
          >
            <DataTable
              rows={channels}
              columns={channelColumns}
              bare
              empty={null}
            />
          </Card>
          <Card
            label="Key exceptions"
            count={exceptions?.open ?? 0}
            icon={<WorkspaceIcon name="queue" />}
          >
            <KeyExceptions exceptions={exceptions} />
          </Card>
          <Card
            label="People"
            count={people.length}
            icon={<WorkspaceIcon name="user" />}
            flush
          >
            <DataTable
              rows={people}
              columns={personColumns}
              bare
              empty={null}
            />
          </Card>
        </>
      )}
    </div>
  );
}

function KeyExceptions({ exceptions }: { exceptions: Exceptions | undefined }) {
  if (!exceptions)
    return <p className="text-[13px] text-muted">Loading exceptions…</p>;
  if (exceptions.total === 0)
    return <p className="text-[13px] text-muted">No exceptions today</p>;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {exceptions.kinds.map((kind) => (
          <StatusPill key={kind.kind} tone={kind.open ? "danger" : "neutral"}>
            {`${EXCEPTION_LABELS[kind.kind]} ${kind.total}${
              kind.open ? ` · ${kind.open} open` : ""
            }`}
          </StatusPill>
        ))}
      </div>
      <ul className="grid gap-1 text-[13px]">
        {exceptions.items.map((item) => (
          <li key={item.id} className="flex flex-wrap gap-x-2 text-foreground">
            <span className="font-medium">{item.personName}</span>
            <span className="text-muted">
              {[
                EXCEPTION_LABELS[item.kind],
                `${item.outletCode} ${item.outletName}`,
                reasonLabel(item.reason),
                item.at === null ? null : formatTime(item.at),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted">
        Review and decide them in Supervision → Exceptions.
      </p>
    </div>
  );
}

/** Subscribes to every page of the scope and adds their totals. */
function ExecutionDashboardData({
  filters,
  now,
}: {
  filters: SupervisionFilters;
  now: number;
}) {
  const first = useQuery(api.analytics.execution.day, { ...filters, page: 0 });
  const pageCount = first?.pageCount ?? 1;
  const requests: RequestForQueries = {};
  for (let page = 1; page < pageCount; page++)
    requests[String(page)] = {
      query: api.analytics.execution.day,
      args: { ...filters, page },
    };
  const more = useQueries(requests) as Record<
    string,
    DayPage | Error | undefined
  >;
  const exceptions = useQuery(api.analytics.execution.exceptions, filters);
  if (first === undefined)
    return <span className="text-[13px] text-muted">Loading dashboard…</span>;
  const pages: DayPage[] = [first];
  let loading = false;
  for (let page = 1; page < pageCount; page++) {
    const result = more[String(page)];
    if (result instanceof Error) throw result;
    if (result === undefined) loading = true;
    else pages.push(result);
  }
  return (
    <ExecutionDashboardView
      serviceDate={filters.serviceDate}
      rows={pages.flatMap((page) => page.rows)}
      totals={pages.reduce(
        (sum, page) => mergeTotals(sum, page.totals),
        emptyTotals(),
      )}
      peopleInScope={first.peopleInScope}
      loading={loading}
      truncated={first.truncated}
      exceptions={exceptions}
      now={now}
    />
  );
}

/**
 * ANA-002 daily execution dashboard for supervisors: sales, target attainment, coverage,
 * productive calls, active field force and key exceptions for the selected scope and date.
 */
export function ExecutionDashboard() {
  const now = useNow();
  const [serviceDate, setServiceDate] = useState(() => manilaToday());
  const [orgUnitId, setOrgUnitId] = useState<Id<"orgUnits"> | "">("");
  const [channel, setChannel] = useState("");
  const [directOnly, setDirectOnly] = useState(false);
  const options = useQuery(api.supervision.team.options, { serviceDate });
  const filters: SupervisionFilters = {
    serviceDate,
    ...(orgUnitId ? { orgUnitId } : {}),
    ...(channel ? { channel } : {}),
    ...(directOnly ? { directOnly } : {}),
  };
  const key = `${serviceDate}-${orgUnitId}-${channel}-${directOnly}`;
  return (
    <section className="grid gap-4" aria-label="Daily execution">
      <h2 className="text-base font-semibold text-foreground">
        Daily execution
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Date">
            <input
              type="date"
              aria-label="Service date"
              className="h-10 w-full"
              value={serviceDate}
              max={manilaToday(now)}
              onChange={(event) => {
                if (event.target.value) setServiceDate(event.target.value);
              }}
            />
          </FormField>
        </div>
        {options && options.units.length > 1 && (
          <div className="w-[220px] max-w-full">
            <FormField label="Unit">
              <select
                aria-label="Unit"
                className="h-10 w-full"
                value={orgUnitId}
                onChange={(event) =>
                  setOrgUnitId(event.target.value as Id<"orgUnits"> | "")
                }
              >
                <option value="">All units</option>
                {options.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        {options && options.channels.length > 0 && (
          <div className="w-[200px] max-w-full">
            <FormField label="Channel">
              <select
                aria-label="Channel"
                className="h-10 w-full"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="">All channels</option>
                {options.channels.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        <label className="flex h-10 items-center gap-2 text-[13px] text-foreground">
          <input
            type="checkbox"
            checked={directOnly}
            onChange={(event) => setDirectOnly(event.target.checked)}
          />
          My team only
        </label>
      </div>
      <PanelErrorBoundary key={key} label="Daily execution">
        <ExecutionDashboardData filters={filters} now={now} />
      </PanelErrorBoundary>
    </section>
  );
}
