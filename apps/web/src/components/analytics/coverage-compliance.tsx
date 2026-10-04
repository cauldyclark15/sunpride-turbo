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
  combineWeeks,
  COMPLIANCE_VIEWS,
  complianceRows,
  coverageVerdict,
  DEFAULT_WEEKS,
  dueStops,
  manilaToday,
  PERSISTENT_WEEKS,
  pctText,
  UNDER_COVERAGE_PCT,
  weekCompliancePct,
  WEEK_OPTIONS,
  type ComplianceRow,
  type ComplianceView,
  type PersonResult,
} from "../../lib/coverage-compliance";

type Roster = FunctionReturnType<typeof api.analytics.productivity.roster>;
type PersonData = FunctionReturnType<typeof api.analytics.compliance.person>;
type Row = ComplianceRow & { id: string };

/** People with these capabilities see the panel; the server re-checks every read. */
export const COMPLIANCE_CAPABILITIES = [
  "people.read",
  "visit.read",
  "report.read",
] as const;

/** Rows shown at once; the worst come first, so the rest are the best covered. */
const MAX_ROWS = 100;

const muted = (text: string) => (
  <span className="font-mono text-xs text-muted">{text}</span>
);

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

function weekCell(
  week: ComplianceRow["weeks"][number] | undefined,
  closed: boolean,
) {
  if (!week || week.planned === 0) return <span className="text-muted">—</span>;
  const pct = weekCompliancePct(week);
  const detail = muted(
    `${week.done}/${dueStops(week)}${week.pending ? ` +${week.pending} open` : ""}`,
  );
  const under = closed && pct !== null && pct < UNDER_COVERAGE_PCT;
  return (
    <span className="flex flex-col items-end tabular-nums">
      {under ? (
        <StatusPill tone="danger">{pctText(pct)}</StatusPill>
      ) : (
        <span className={closed ? "" : "text-muted"}>{pctText(pct)}</span>
      )}
      {detail}
    </span>
  );
}

function columnsFor(
  view: ComplianceView,
  windows: PersonResult["windows"],
): DataColumn<Row>[] {
  const label = COMPLIANCE_VIEWS.find(([id]) => id === view)?.[1] ?? "";
  return [
    {
      key: "name",
      label,
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.name}
          </span>
          {row.detail ? muted(row.detail) : null}
          {view !== "employee" && row.people.length
            ? muted(row.people.join(", "))
            : null}
        </span>
      ),
    },
    ...windows.map((window, index): DataColumn<Row> => ({
      key: `w${index}`,
      label: `${shortDate(window.weekStart)}${window.closed ? "" : " (open)"}`,
      align: "right",
      render: (row) => weekCell(row.weeks[index], window.closed),
    })),
    {
      key: "compliance",
      label: "Compliance",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end tabular-nums">
          <span>{pctText(row.verdict.compliancePct)}</span>
          {muted(
            `${row.weeks.reduce((sum, week) => sum + week.missed, 0)} missed`,
          )}
        </span>
      ),
    },
    {
      key: "flag",
      label: "Under-coverage",
      render: (row) => {
        if (row.verdict.persistent)
          return (
            <StatusPill tone="danger">
              {`Persistent · ${row.verdict.streak} weeks`}
            </StatusPill>
          );
        if (row.verdict.streak)
          return (
            <StatusPill tone="warning">
              {`${row.verdict.streak} week${row.verdict.streak > 1 ? "s" : ""} under`}
            </StatusPill>
          );
        if (row.verdict.underWeeks)
          return muted(
            `${row.verdict.underWeeks} of ${row.verdict.judgedWeeks} weeks under`,
          );
        return <span className="text-muted">—</span>;
      },
    },
  ];
}

export function CoverageComplianceView({
  roster,
  results,
  view,
  onView,
  weeks,
  onWeeks,
  persistentOnly,
  onPersistentOnly,
  endDate,
}: {
  roster: Roster;
  results: readonly PersonResult[];
  view: ComplianceView;
  onView: (view: ComplianceView) => void;
  weeks: number;
  onWeeks: (weeks: number) => void;
  persistentOnly: boolean;
  onPersistentOnly: (value: boolean) => void;
  endDate: string;
}) {
  const pending = roster.people.length - results.length;
  const windows = results[0]?.windows ?? [];
  const all = complianceRows(results, view);
  const shown = all.filter((row) => !persistentOnly || row.verdict.persistent);
  const rows: Row[] = shown
    .slice(0, MAX_ROWS)
    .map((row) => ({ ...row, id: row.key }));
  const total = combineWeeks(results.map((person) => person.weeks));
  const overall = coverageVerdict(total, windows);
  const missed = total.reduce((sum, week) => sum + week.missed, 0);
  const due = total.reduce((sum, week) => sum + dueStops(week), 0);
  const offPlan = results.reduce(
    (sum, person) => sum + person.offPlanVisits.reduce((a, b) => a + b, 0),
    0,
  );
  const persistentCount = (kind: ComplianceView) =>
    (kind === view ? all : complianceRows(results, kind)).filter(
      (row) => row.verdict.persistent,
    ).length;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Compare by">
            <select
              aria-label="Compare by"
              className="h-10 w-full"
              value={view}
              onChange={(event) => onView(event.target.value as ComplianceView)}
            >
              {COMPLIANCE_VIEWS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="w-[140px] max-w-full">
          <FormField label="Weeks">
            <select
              aria-label="Weeks"
              className="h-10 w-full"
              value={weeks}
              onChange={(event) => onWeeks(Number(event.target.value))}
            >
              {WEEK_OPTIONS.map((count) => (
                <option key={count} value={count}>
                  {`Last ${count} weeks`}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <label className="flex h-10 items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={persistentOnly}
            onChange={(event) => onPersistentOnly(event.target.checked)}
          />
          Persistent under-coverage only
        </label>
        <span className="flex h-10 items-center font-mono text-[13px] text-muted">
          {windows[0]?.from ?? "…"} – {endDate}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Plan compliance"
          value={pctText(overall.compliancePct)}
          detail={`${due - missed} of ${due} due stops visited`}
        />
        <MetricCard
          label="Missed stops"
          value={String(missed)}
          detail={`${offPlan} visits outside the plan`}
        />
        <MetricCard
          label="Persistent under-coverage"
          value={String(persistentCount("employee"))}
          detail="employees"
        />
        <MetricCard
          label="Persistent under-coverage"
          value={`${persistentCount("territory")} · ${persistentCount("customer")}`}
          detail="territories · stores"
        />
      </div>
      {roster.truncated && (
        <p className="text-[13px] text-muted">
          Only the first people in your scope are included.
        </p>
      )}
      {results.some((person) => person.outletsTruncated) && (
        <p className="text-[13px] text-muted">
          Some people plan more stores than one read shows; their totals are
          complete, the store list is not.
        </p>
      )}
      {roster.people.length === 0 ? (
        <Card
          label="Coverage compliance"
          icon={<WorkspaceIcon name="reports" />}
        >
          <p className="text-[13px] text-muted">No field people here</p>
        </Card>
      ) : (
        <Card
          label="Coverage compliance"
          count={shown.length}
          icon={<WorkspaceIcon name="reports" />}
          actions={
            pending > 0 ? (
              <span className="text-[13px] text-muted">Loading {pending}…</span>
            ) : undefined
          }
          flush
        >
          <DataTable
            rows={rows}
            columns={columnsFor(view, windows)}
            bare
            empty={
              <div className="p-4 text-[13px] text-muted">
                {pending > 0
                  ? "Loading…"
                  : persistentOnly
                    ? "No persistent under-coverage"
                    : "No planned stops in these weeks"}
              </div>
            }
          />
        </Card>
      )}
      {shown.length > MAX_ROWS && (
        <p className="text-[13px] text-muted">
          {`Showing the ${MAX_ROWS} least covered of ${shown.length}.`}
        </p>
      )}
      <p className="text-[12px] text-muted">
        Compliance is approved MCP stops visited and checked out on their
        planned day, out of the stops that are due (their day has closed, or
        they are done). A closed week under {UNDER_COVERAGE_PCT}% is
        under-covered; {PERSISTENT_WEEKS} or more in a row (weeks with nothing
        planned are skipped) is persistent under-coverage. Visits outside the
        plan never raise compliance. Stops are attributed to the territory and
        store the plan was signed for. These rules are provisional until
        Sunpride signs them off; do not use them for pay or discipline.
      </p>
    </div>
  );
}

function PersonLoader({
  profileId,
  endDate,
  weeks,
  onResult,
}: {
  profileId: Id<"profiles">;
  endDate: string;
  weeks: number;
  onResult: (key: string, data: PersonData) => void;
}) {
  const data = useQuery(api.analytics.compliance.person, {
    profileId,
    endDate,
    weeks,
  });
  useEffect(() => {
    if (data) onResult(`${profileId}:${endDate}:${weeks}`, data);
  }, [data, profileId, endDate, weeks, onResult]);
  return null;
}

function CoverageCompliancePanel() {
  const [endDate] = useState(() => manilaToday());
  const [weeks, setWeeks] = useState<number>(DEFAULT_WEEKS);
  const [view, setView] = useState<ComplianceView>("employee");
  const [persistentOnly, setPersistentOnly] = useState(false);
  const [results, setResults] = useState<Map<string, PersonData>>(
    () => new Map(),
  );
  const roster = useQuery(api.analytics.productivity.roster, { endDate });
  const onResult = useCallback((key: string, data: PersonData) => {
    setResults((prev) =>
      prev.get(key) === data ? prev : new Map(prev).set(key, data),
    );
  }, []);
  if (roster === undefined)
    return <span className="text-[13px] text-muted">Loading people…</span>;
  const current = roster.people.flatMap((person) => {
    const hit = results.get(`${person.profileId}:${endDate}:${weeks}`);
    return hit ? [hit] : [];
  });
  return (
    <>
      {roster.people.map((person) => (
        <PersonLoader
          key={`${person.profileId}:${endDate}:${weeks}`}
          profileId={person.profileId}
          endDate={endDate}
          weeks={weeks}
          onResult={onResult}
        />
      ))}
      <CoverageComplianceView
        roster={roster}
        results={current}
        view={view}
        onView={setView}
        weeks={weeks}
        onWeeks={setWeeks}
        persistentOnly={persistentOnly}
        onPersistentOnly={setPersistentOnly}
        endDate={endDate}
      />
    </>
  );
}

/** Reports → Coverage compliance (ANA-008); shown only to people who may read it. */
export function CoverageCompliance() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  if (
    !permissions ||
    !COMPLIANCE_CAPABILITIES.every((name) =>
      permissions.capabilities.includes(name),
    )
  )
    return null;
  return <CoverageCompliancePanel />;
}
