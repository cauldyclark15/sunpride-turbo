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
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useCallback, useEffect, useState } from "react";
import {
  combineFigures,
  PERIOD_PRESETS,
  pctText,
  periodFor,
  pesoText,
  productivityFlags,
  ratesOf,
  type PeriodPreset,
} from "../../lib/supervisor-productivity";
import type { SupervisionFilters } from "./supervision-model";

type Roster = FunctionReturnType<typeof api.analytics.productivity.roster>;
type PersonFigures = FunctionReturnType<
  typeof api.analytics.productivity.person
>;
type Row = {
  id: string;
  person: Roster["people"][number];
  data?: PersonFigures;
};

type SortKey =
  | "name"
  | "productive"
  | "conversion"
  | "salesPerCall"
  | "missed"
  | "exceptions";
const SORTS: [SortKey, string][] = [
  ["name", "Name"],
  ["productive", "Productive %"],
  ["conversion", "Order conversion"],
  ["salesPerCall", "Sales per call"],
  ["missed", "Missed calls"],
  ["exceptions", "Exception rate"],
];

function sortRows(rows: Row[], key: SortKey) {
  const value = (row: Row) => {
    if (!row.data) return null;
    const rates = ratesOf(row.data.figures);
    if (key === "productive") return rates.productivePct;
    if (key === "conversion") return rates.conversionPct;
    if (key === "salesPerCall") return rates.salesPerCall;
    if (key === "missed") return row.data.figures.missed;
    if (key === "exceptions") return rates.exceptionRatePct;
    return null;
  };
  if (key === "name") return rows;
  // Missed calls and exceptions: worst (highest) first; the rest: lowest first.
  const worstHigh = key === "missed" || key === "exceptions";
  return [...rows].sort((a, b) => {
    const va = value(a),
      vb = value(b);
    if (va === null || vb === null)
      return Number(va === null) - Number(vb === null);
    return worstHigh ? vb - va : va - vb;
  });
}

const muted = (text: string) => (
  <span className="font-mono text-xs text-muted">{text}</span>
);

const columns: DataColumn<Row>[] = [
  {
    key: "person",
    label: "Person",
    render: (row) => (
      <span className="flex flex-col">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {row.person.name}
          {row.person.direct && <StatusPill tone="neutral">Direct</StatusPill>}
        </span>
        {muted(
          [row.person.employeeCode, row.person.positionLabel]
            .filter(Boolean)
            .join(" · ") || "—",
        )}
      </span>
    ),
  },
  {
    key: "calls",
    label: "Actual / planned",
    align: "right",
    render: (row) =>
      row.data ? (
        <span className="flex flex-col items-end tabular-nums">
          <span>
            {row.data.figures.calls}/{row.data.figures.planned}
          </span>
          {muted(
            row.data.figures.callsTarget === null
              ? pctText(ratesOf(row.data.figures).callsPct)
              : `${pctText(ratesOf(row.data.figures).callsTargetPct)} of ${row.data.figures.callsTarget} target`,
          )}
        </span>
      ) : (
        "…"
      ),
  },
  {
    key: "productive",
    label: "Productive",
    align: "right",
    render: (row) =>
      row.data ? (
        <span className="flex flex-col items-end tabular-nums">
          <span>{pctText(ratesOf(row.data.figures).productivePct)}</span>
          {muted(
            `${row.data.figures.productiveCalls} calls${
              row.data.productiveCallTargetPct === null
                ? ""
                : ` · target ${row.data.productiveCallTargetPct}%`
            }`,
          )}
        </span>
      ) : (
        "…"
      ),
  },
  {
    key: "conversion",
    label: "Order conversion",
    align: "right",
    render: (row) =>
      row.data ? (
        <span className="flex flex-col items-end tabular-nums">
          <span>{pctText(ratesOf(row.data.figures).conversionPct)}</span>
          {muted(`${row.data.figures.convertedCalls} with order`)}
        </span>
      ) : (
        "…"
      ),
  },
  {
    key: "salesPerCall",
    label: "Sales / call",
    align: "right",
    render: (row) =>
      row.data ? (
        <span className="flex flex-col items-end tabular-nums">
          <span>{pesoText(ratesOf(row.data.figures).salesPerCall)}</span>
          {muted(pesoText(row.data.figures.sales))}
        </span>
      ) : (
        "…"
      ),
  },
  {
    key: "missed",
    label: "Missed",
    align: "right",
    render: (row) =>
      row.data ? (
        <span className="flex flex-col items-end tabular-nums">
          <span>{row.data.figures.missed}</span>
          {muted(
            row.data.figures.pending
              ? `${row.data.figures.pending} still due`
              : pctText(ratesOf(row.data.figures).missedPct),
          )}
        </span>
      ) : (
        "…"
      ),
  },
  {
    key: "exceptions",
    label: "Exception rate",
    align: "right",
    render: (row) =>
      row.data ? (
        <span className="flex flex-col items-end tabular-nums">
          <span>{pctText(ratesOf(row.data.figures).exceptionRatePct)}</span>
          {muted(
            `${row.data.figures.exceptionVisits} of ${row.data.figures.visits} visits`,
          )}
        </span>
      ) : (
        "…"
      ),
  },
  {
    key: "flags",
    label: "Flags",
    render: (row) => {
      const list = row.data
        ? productivityFlags(row.data.figures, row.data.productiveCallTargetPct)
        : [];
      return list.length ? (
        <span className="flex flex-wrap gap-1">
          {list.map((flag) => (
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

export function ProductivityView({
  roster,
  results,
  period,
  preset,
  onPreset,
  sort,
  onSort,
  directOnly,
}: {
  roster: Roster;
  results: ReadonlyMap<string, PersonFigures>;
  period: { from: string; to: string };
  preset: PeriodPreset;
  onPreset: (preset: PeriodPreset) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  directOnly: boolean;
}) {
  const rows: Row[] = roster.people.map((person) => ({
    id: person.profileId,
    person,
    data: results.get(person.profileId),
  }));
  const loaded = rows.flatMap((row) => (row.data ? [row.data] : []));
  const team = combineFigures(loaded.map((row) => row.figures));
  const rates = ratesOf(team);
  const pending = rows.length - loaded.length;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Period">
            <select
              aria-label="Period"
              className="h-10 w-full"
              value={preset}
              onChange={(event) => onPreset(event.target.value as PeriodPreset)}
            >
              {PERIOD_PRESETS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-[200px] max-w-full">
          <FormField label="Sort by">
            <select
              aria-label="Sort by"
              className="h-10 w-full"
              value={sort}
              onChange={(event) => onSort(event.target.value as SortKey)}
            >
              {SORTS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <span className="flex h-10 items-center font-mono text-[13px] text-muted">
          {period.from} – {period.to}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Actual / planned calls"
          value={`${team.calls}/${team.planned}`}
          detail={pctText(rates.callsPct)}
        />
        <MetricCard
          label="Productive calls"
          value={pctText(rates.productivePct)}
          detail={`${team.productiveCalls} of ${team.calls} calls`}
        />
        <MetricCard
          label="Order conversion"
          value={pctText(rates.conversionPct)}
          detail={`${team.convertedCalls} calls with an order`}
        />
        <MetricCard
          label="Sales per call"
          value={pesoText(rates.salesPerCall)}
          detail={`${pesoText(team.sales)} sales · ${team.orders} orders`}
        />
        <MetricCard
          label="Missed calls"
          value={String(team.missed)}
          detail={
            team.pending
              ? `${pctText(rates.missedPct)} · ${team.pending} still due`
              : pctText(rates.missedPct)
          }
        />
        <MetricCard
          label="Exception rate"
          value={pctText(rates.exceptionRatePct)}
          detail={`${team.exceptionVisits} of ${team.visits} visits`}
        />
      </div>
      {roster.truncated && (
        <p className="text-[13px] text-muted">
          First {rows.length} shown. Pick a unit.
        </p>
      )}
      {rows.length === 0 ? (
        <Card label="Productivity" icon={<WorkspaceIcon name="user" />}>
          <p className="text-[13px] text-muted">
            {directOnly
              ? "No direct reports here. Turn off My team only to see everyone in your area."
              : "No field people here"}
          </p>
        </Card>
      ) : (
        <Card
          label={directOnly ? "Direct reports" : "Field people"}
          count={rows.length}
          icon={<WorkspaceIcon name="user" />}
          actions={
            pending ? (
              <span className="text-[13px] text-muted">Loading {pending}…</span>
            ) : undefined
          }
          flush
        >
          <DataTable
            rows={sortRows(rows, sort)}
            columns={columns}
            bare
            empty={null}
          />
        </Card>
      )}
      <p className="text-[12px] text-muted">
        A call is a route-plan store visited and checked out; productive when
        any one listed activity was recorded. Conversion counts calls where an
        order was written for that store the same day. Missed calls are planned
        stops not visited by the 10 PM close. Exceptions are visits outside the
        store radius, out of route order or unplanned. These definitions are
        provisional until Sunpride signs them off; do not use them for pay or
        discipline.
      </p>
    </div>
  );
}

function PersonLoader({
  profileId,
  from,
  to,
  onResult,
}: {
  profileId: Id<"profiles">;
  from: string;
  to: string;
  onResult: (key: string, data: PersonFigures) => void;
}) {
  const data = useQuery(api.analytics.productivity.person, {
    profileId,
    from,
    to,
  });
  useEffect(() => {
    if (data) onResult(`${profileId}:${from}:${to}`, data);
  }, [data, profileId, from, to, onResult]);
  return null;
}

export function Productivity({ filters }: { filters: SupervisionFilters }) {
  const [preset, setPreset] = useState<PeriodPreset>("7");
  const [sort, setSort] = useState<SortKey>("name");
  const [results, setResults] = useState<Map<string, PersonFigures>>(
    () => new Map(),
  );
  const period = periodFor(preset, filters.serviceDate);
  const roster = useQuery(api.analytics.productivity.roster, {
    endDate: filters.serviceDate,
    ...(filters.orgUnitId ? { orgUnitId: filters.orgUnitId } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.directOnly ? { directOnly: true } : {}),
  });
  const onResult = useCallback((key: string, data: PersonFigures) => {
    setResults((prev) =>
      prev.get(key) === data ? prev : new Map(prev).set(key, data),
    );
  }, []);
  if (roster === undefined)
    return (
      <span className="text-[13px] text-muted">Loading productivity…</span>
    );
  const current = new Map<string, PersonFigures>();
  for (const person of roster.people) {
    const hit = results.get(`${person.profileId}:${period.from}:${period.to}`);
    if (hit) current.set(person.profileId, hit);
  }
  return (
    <>
      {roster.people.map((person) => (
        <PersonLoader
          key={`${person.profileId}:${period.from}:${period.to}`}
          profileId={person.profileId}
          from={period.from}
          to={period.to}
          onResult={onResult}
        />
      ))}
      <ProductivityView
        roster={roster}
        results={current}
        period={period}
        preset={preset}
        onPreset={setPreset}
        sort={sort}
        onSort={setSort}
        directOnly={!!filters.directOnly}
      />
    </>
  );
}
