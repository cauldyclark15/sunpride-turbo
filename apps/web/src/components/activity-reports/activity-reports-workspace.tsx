"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  MetricCard,
  Notice,
  StatusPill,
  UnderlineTabs,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import {
  activitySummary,
  callStatusMeta,
  completenessMark,
  completenessMeta,
  dayHeader,
  formatMinutes,
  formatPct,
  longDate,
  REPORT_SHORT,
  REPORT_TITLES,
  submissionLine,
  type ReportKind,
} from "../../lib/activity-reports";
import { PanelErrorBoundary } from "../panel-error-boundary";
import { formatTime, manilaToday } from "../supervision/supervision-model";
import { MODE_LABELS, OBJECTIVE_LABELS } from "../supervision/work-with-model";
import "./activity-reports-print.css";

export type DayReport = NonNullable<
  FunctionReturnType<typeof api.field_reports.reports.day>
>;
export type CompletenessGrid = FunctionReturnType<
  typeof api.field_reports.reports.completeness
>;
type Stop = DayReport["stops"][number] & { id: string };
type WorkWithRow = DayReport["workWith"][number] & { id: string };
type GridPerson = CompletenessGrid["people"][number] & { id: string };

const WEEK = 7;

/** The DAR or ROAR itself: generated figures, stops, Work-With and what was filed. */
export function ReportView({ report }: { report: DayReport }) {
  const s = report.summary;
  const status = completenessMeta(report.status);
  const stops: Stop[] = report.stops.map((stop) => ({ ...stop, id: stop.key }));
  const stopColumns: DataColumn<Stop>[] = [
    {
      key: "seq",
      label: "#",
      align: "right",
      render: (stop) => (
        <span className="font-mono text-[13px]">{stop.sequence ?? "—"}</span>
      ),
    },
    {
      key: "outlet",
      label: "Outlet",
      render: (stop) => (
        <span className="flex flex-col">
          <span className="text-sm text-foreground">{stop.outletName}</span>
          <span className="font-mono text-xs text-muted">
            {[stop.outletCode, stop.routeCode].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      label: "Call",
      render: (stop) => {
        const meta = callStatusMeta(stop.callStatus);
        return <StatusPill tone={meta.tone}>{meta.label}</StatusPill>;
      },
    },
    {
      key: "activities",
      label: "Done at the store",
      render: (stop) => (
        <span className="text-[13px]">
          {activitySummary(stop.activityKinds, stop.collections)}
        </span>
      ),
    },
    {
      key: "in",
      label: "In",
      align: "right",
      render: (stop) => (
        <span className="font-mono text-[13px]">
          {formatTime(stop.checkedInAt)}
        </span>
      ),
    },
    {
      key: "out",
      label: "Out",
      align: "right",
      render: (stop) => (
        <span className="font-mono text-[13px]">
          {formatTime(stop.checkedOutAt)}
        </span>
      ),
    },
    {
      key: "minutes",
      label: "Time",
      align: "right",
      render: (stop) => formatMinutes(stop.callMinutes),
    },
    {
      key: "notes",
      label: "Notes",
      render: (stop) =>
        stop.notes.length || stop.reasonCode ? (
          <span className="text-[13px] text-muted">
            {[stop.reasonCode?.replaceAll("_", " "), ...stop.notes]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ];
  const workWith: WorkWithRow[] = report.workWith.map((row) => ({
    ...row,
    id: row.sessionId,
  }));
  const workWithColumns: DataColumn<WorkWithRow>[] = [
    { key: "trainee", label: "With", render: (row) => row.traineeName },
    {
      key: "objective",
      label: "Objective",
      render: (row) =>
        OBJECTIVE_LABELS[row.objective as keyof typeof OBJECTIVE_LABELS] ??
        row.objective,
    },
    {
      key: "mode",
      label: "Mode",
      render: (row) =>
        MODE_LABELS[row.mode as keyof typeof MODE_LABELS] ?? row.mode,
    },
    {
      key: "mcp",
      label: "MCP stops",
      align: "right",
      render: (row) =>
        row.mcpPlanned === null ? "—" : `${row.mcpDone ?? 0}/${row.mcpPlanned}`,
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <StatusPill tone={row.status === "completed" ? "success" : "neutral"}>
          {row.status === "completed" ? "Done" : "Open"}
        </StatusPill>
      ),
    },
  ];
  const target = report.standard;
  return (
    <section
      className="field-report-print-view grid gap-4"
      aria-label={REPORT_TITLES[report.kind]}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {REPORT_TITLES[report.kind]}
          </h2>
          <p className="text-[13px] text-muted">
            {[
              report.person.name,
              report.person.employeeCode,
              report.person.positionLabel,
              report.person.unitName,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span>{longDate(report.serviceDate)}</span>
          {!report.sellingDay && <span>· not a selling day</span>}
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Calls"
          value={String(s.calls)}
          detail={
            target?.dailyCallsTarget != null
              ? `target ${target.dailyCallsTarget}`
              : `${s.plannedDone}/${s.planned} planned stops`
          }
        />
        <MetricCard
          label="Productive"
          value={`${s.productiveCalls}`}
          detail={`${formatPct(s.productivePct)}${target?.productiveCallTargetPct != null ? ` · target ${target.productiveCallTargetPct}%` : ""}`}
        />
        <MetricCard
          label="Not visited"
          value={String(s.notVisited)}
          detail={`${s.unplanned} unplanned`}
        />
        {report.kind === "dar" ? (
          <MetricCard
            label="Work-With"
            value={`${s.workWithCompleted}/${s.workWithSessions}`}
            detail="done"
          />
        ) : (
          <MetricCard
            label="Field time"
            value={formatMinutes(s.fieldMinutes)}
            detail={`${formatTime(s.firstCheckInAt)}–${formatTime(s.lastCheckOutAt)}`}
          />
        )}
      </div>
      {report.kind === "roar" && report.routes.length > 1 && (
        <p className="text-[13px] text-muted">
          {report.routes
            .map(
              (route) =>
                `${route.routeCode ?? "No route"}: ${route.calls} calls, ${formatPct(route.productivePct)} productive`,
            )
            .join(" · ")}
        </p>
      )}
      {report.kind === "dar" && (
        <Card
          label="Work-With sessions"
          count={workWith.length}
          icon={<WorkspaceIcon name="user" />}
          flush
        >
          <DataTable
            rows={workWith}
            columns={workWithColumns}
            bare
            empty={<p className="p-4 text-[13px] text-muted">None this day</p>}
          />
        </Card>
      )}
      <Card
        label={report.kind === "roar" ? "Route" : "Store calls"}
        count={stops.length}
        icon={<WorkspaceIcon name="field" />}
        flush
      >
        <DataTable
          rows={stops}
          columns={stopColumns}
          bare
          empty={
            <p className="p-4 text-[13px] text-muted">No calls this day</p>
          }
        />
      </Card>
      <Card label="Submission" icon={<WorkspaceIcon name="document" />}>
        {report.submission ? (
          <div className="grid gap-2 text-[13px]">
            <p className="whitespace-pre-wrap text-foreground">
              {report.submission.remarks || "No remarks"}
            </p>
            <p className="text-muted">
              {submissionLine(report)} · filed{" "}
              {formatTime(report.submission.submittedAt)} by{" "}
              {report.submission.submittedByName}
              {report.submission.revision > 1 &&
                ` · first filed ${formatTime(report.submission.firstSubmittedAt)}`}
            </p>
            <p className="text-muted">
              As filed: {report.submission.summary.calls} calls,{" "}
              {report.submission.summary.productiveCalls} productive,{" "}
              {report.submission.summary.notVisited} not visited
              {report.kind === "dar" &&
                `, ${report.submission.summary.workWithCompleted} Work-With done`}
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            Not submitted yet · due {formatTime(report.dueAt)}
          </p>
        )}
      </Card>
    </section>
  );
}

/** The filer's remarks box and Submit / Resubmit button. */
export function SubmitPanel({
  report,
  submit,
}: {
  report: DayReport;
  submit: (args: {
    serviceDate: string;
    remarks: string;
  }) => Promise<{ revision: number; late: boolean }>;
}) {
  const [remarks, setRemarks] = useState(report.submission?.remarks ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  if (!report.canSubmit)
    return report.submitBlockedReason ? (
      <p className="text-[13px] text-muted">{report.submitBlockedReason}</p>
    ) : null;
  const send = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await submit({
        serviceDate: report.serviceDate,
        remarks,
      });
      setMessage({
        text: result.late
          ? `Filed as revision ${result.revision} · after 10 PM, counted late`
          : `Filed as revision ${result.revision}`,
        error: false,
      });
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Could not submit",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid max-w-2xl gap-2 print:hidden">
      <FormField
        label="Remarks"
        hint="Issues, opportunities, reasons for missed stops"
      >
        <textarea
          aria-label="Remarks"
          rows={3}
          maxLength={2000}
          value={remarks}
          onChange={(event) => setRemarks(event.target.value)}
        />
      </FormField>
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          className="h-10"
          isPending={busy}
          onPress={() => void send()}
        >
          {report.submission
            ? "Resubmit"
            : `Submit ${REPORT_SHORT[report.kind]}`}
        </Button>
        {message && (
          <span
            role={message.error ? "alert" : "status"}
            className={`text-[12px] ${message.error ? "text-danger" : "text-muted"}`}
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}

/** Per-person, per-day submission grid with totals. */
export function CompletenessView({
  grid,
  selected,
  onSelect,
}: {
  grid: CompletenessGrid;
  selected: { profileId: string; serviceDate: string } | null;
  onSelect: (profileId: Id<"profiles">, serviceDate: string) => void;
}) {
  const people: GridPerson[] = grid.people.map((person) => ({
    ...person,
    id: person.profileId,
  }));
  const last = grid.totals.at(-1);
  const columns: DataColumn<GridPerson>[] = [
    {
      key: "person",
      label: "Person",
      render: (person) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {person.name}
          </span>
          <span className="font-mono text-xs text-muted">
            {[REPORT_SHORT[person.kind as ReportKind], person.positionLabel]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      ),
    },
    ...grid.dates.map((serviceDate, index): DataColumn<GridPerson> => ({
      key: serviceDate,
      label: dayHeader(serviceDate),
      align: "right",
      render: (person) => {
        const day = person.days[index]!;
        const meta = completenessMeta(day.status);
        const active =
          selected?.profileId === person.profileId &&
          selected.serviceDate === serviceDate;
        return (
          <button
            type="button"
            title={`${person.name} · ${longDate(serviceDate)} · ${meta.label}`}
            aria-label={`${person.name} ${serviceDate} ${meta.label}`}
            aria-pressed={active}
            onClick={() => onSelect(person.profileId, serviceDate)}
            className={`inline-grid h-7 min-w-7 place-items-center rounded-md px-1 font-mono text-[13px] ${
              day.status === "missing"
                ? "text-danger"
                : day.status === "late"
                  ? "text-warning"
                  : "text-foreground"
            } ${active ? "ring-1 ring-accent" : ""}`}
          >
            {completenessMark(day.status) || "\u00a0"}
          </button>
        );
      },
    })),
  ];
  return (
    <div className="grid gap-4">
      {last && (
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard
            label="Filed"
            value={`${last.submitted + last.late}/${last.required}`}
            detail={longDate(last.serviceDate)}
          />
          <MetricCard
            label="Late"
            value={String(last.late)}
            detail="after 10 PM"
          />
          <MetricCard
            label="Missing this week"
            value={String(grid.totals.reduce((n, day) => n + day.missing, 0))}
            detail={`${grid.dates.length} days`}
          />
        </div>
      )}
      {grid.truncated && (
        <p className="text-[13px] text-muted">
          First {people.length} shown. Pick a unit.
        </p>
      )}
      <Card
        label="DAR / ROAR submissions"
        count={people.length}
        icon={<WorkspaceIcon name="document" />}
        actions={
          <span className="text-[12px] text-muted">
            ✓ on time · L late · ✕ missing · · due
          </span>
        }
        flush
      >
        <DataTable
          rows={people}
          columns={columns}
          bare
          empty={
            <p className="p-4 text-[13px] text-muted">
              Nobody here files a DAR or ROAR
            </p>
          }
        />
      </Card>
    </div>
  );
}

function MyReport({ serviceDate }: { serviceDate: string }) {
  const report = useQuery(api.field_reports.reports.day, { serviceDate });
  const submit = useMutation(api.field_reports.reports.submit);
  if (report === undefined)
    return <p className="text-[13px] text-muted">Loading report…</p>;
  if (report === null)
    return (
      <Notice
        tone="neutral"
        title="Your position does not file a DAR or ROAR"
        meta="The memo asks supervisors (SCDM, CDM, DS) for a DAR and route sellers for a ROAR."
      />
    );
  return (
    <div className="grid gap-4">
      <SubmitPanel
        key={`${report.serviceDate}-${report.revisions}`}
        report={report}
        submit={submit}
      />
      <ReportView report={report} />
    </div>
  );
}

function PersonReport({
  profileId,
  serviceDate,
}: {
  profileId: Id<"profiles">;
  serviceDate: string;
}) {
  const report = useQuery(api.field_reports.reports.day, {
    serviceDate,
    profileId,
  });
  if (report === undefined)
    return <p className="text-[13px] text-muted">Loading report…</p>;
  if (report === null)
    return <p className="text-[13px] text-muted">No report for this person</p>;
  return <ReportView report={report} />;
}

function TeamReports({ endDate }: { endDate: string }) {
  const [orgUnitId, setOrgUnitId] = useState<Id<"orgUnits"> | "">("");
  const [kind, setKind] = useState<ReportKind | "">("");
  const [selected, setSelected] = useState<{
    profileId: Id<"profiles">;
    serviceDate: string;
  } | null>(null);
  const grid = useQuery(api.field_reports.reports.completeness, {
    endDate,
    days: WEEK,
    ...(orgUnitId ? { orgUnitId } : {}),
    ...(kind ? { kind } : {}),
  });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        {grid && grid.units.length > 1 && (
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
                {grid.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        <div className="w-[200px] max-w-full">
          <FormField label="Report">
            <select
              aria-label="Report"
              className="h-10 w-full"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as ReportKind | "")
              }
            >
              <option value="">DAR and ROAR</option>
              <option value="dar">DAR only</option>
              <option value="roar">ROAR only</option>
            </select>
          </FormField>
        </div>
      </div>
      {grid === undefined ? (
        <p className="text-[13px] text-muted">Loading submissions…</p>
      ) : (
        <div className="print:hidden">
          <CompletenessView
            grid={grid}
            selected={selected}
            onSelect={(profileId, serviceDate) =>
              setSelected({ profileId, serviceDate })
            }
          />
        </div>
      )}
      {selected && (
        <PanelErrorBoundary
          key={`${selected.profileId}-${selected.serviceDate}`}
          label="Person report"
        >
          <PersonReport
            profileId={selected.profileId}
            serviceDate={selected.serviceDate}
          />
        </PanelErrorBoundary>
      )}
    </div>
  );
}

type Tab = "mine" | "team";

/** SOP-009: the filer's own DAR/ROAR and the supervisor's submission completeness. */
export function ActivityReportsWorkspace() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [serviceDate, setServiceDate] = useState(() => manilaToday());
  const kind = useQuery(api.field_reports.reports.myKind, {});
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canSupervise = !!permissions?.capabilities.includes("people.read");
  const tabs: [Tab, string][] = [
    ...(kind
      ? ([["mine", `My ${REPORT_SHORT[kind]}`]] as [Tab, string][])
      : []),
    ...(canSupervise
      ? ([["team", "Team submissions"]] as [Tab, string][])
      : []),
  ];
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab = tabs.some(([id]) => id === picked) ? picked! : tabs[0]?.[0];
  if (kind === undefined || permissions === undefined)
    return <p className="text-[13px] text-muted">Loading…</p>;
  return (
    <div className="grid gap-4">
      {tabs.length > 1 && tab && (
        <UnderlineTabs
          items={tabs}
          activeId={tab}
          onChange={setPicked}
          label="Activity report views"
        />
      )}
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="w-[180px] max-w-full">
          <FormField label={tab === "team" ? "Week ending" : "Date"}>
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
        <Button
          variant="outline"
          className="h-10"
          onPress={() => window.print()}
        >
          Print / Save PDF
        </Button>
      </div>
      <div role="tabpanel">
        <PanelErrorBoundary
          key={`${tab}-${serviceDate}`}
          label="Activity reports"
        >
          {tab === "team" ? (
            <TeamReports endDate={serviceDate} />
          ) : (
            <MyReport serviceDate={serviceDate} />
          )}
        </PanelErrorBoundary>
      </div>
    </div>
  );
}
