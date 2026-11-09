"use client";
import { Card, WorkspaceIcon } from "@sunpride/ui";
import { api, type Summary, type Review } from "./coverage-model";
import { useCoverageQuery } from "./coverage-data";
import { coverageStatusLabel } from "../lib/coverage-view-model";
import { deadlineDate, deadlineStateLabel } from "../lib/mcp-deadlines";
import { formatDate } from "./cockpit/format";
import { ListPage, PAGE_SIZE } from "./list-page/list-page";

/** `Oct 2026` for a `YYYY-MM` month. */
export function monthLabel(month: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15));
}
type Person = Summary["rows"][number];
export const planStatus = (row: Pick<Person, "status">) =>
  row.status === "not_started"
    ? "Not started"
    : coverageStatusLabel(row.status);
/** The one row button: Add plan for nobody's plan yet, Review when it waits on me, else Edit/Open. */
export function planAction(
  row: Pick<Person, "status" | "awaitsMyApproval">,
  canPlan: boolean,
) {
  if (row.status === "not_started") return canPlan ? "Add plan" : null;
  if (row.awaitsMyApproval) return "Review";
  return canPlan ? "Edit" : "Open";
}

/** Coverage plans: one row per person for the month (search · status chips · pages). */
export function CoveragePlansListView({
  data,
  canPlan = false,
  q,
  status,
  page,
  onSearch,
  onFilter,
  onPage,
  onOpen,
  onAdd,
}: {
  data: Summary;
  canPlan?: boolean;
  q: string;
  status: string | null;
  page: number;
  onSearch: (q: string) => void;
  onFilter: (status: string | null) => void;
  onPage: (page: number) => void;
  onOpen: (person: Person) => void;
  onAdd?: () => void;
}) {
  const needle = q.trim().toLowerCase();
  const hits = data.rows.filter(
    (r) =>
      (!status || r.status === status) &&
      (!needle || r.name.toLowerCase().includes(needle)),
  );
  if (!data.rows.length)
    return (
      <p className="text-sm text-muted">
        No field people assigned yet. Assign people in Setup.
      </p>
    );
  return (
    <ListPage<Person>
      noun={{ one: "plan", many: "plans" }}
      rows={hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
      total={hits.length}
      page={page}
      onPage={onPage}
      q={q}
      onSearch={onSearch}
      searchPlaceholder="Search by person"
      onAdd={canPlan && onAdd ? () => onAdd() : undefined}
      filters={Object.entries(data.counts).map(([id, count]) => ({
        id,
        label: planStatus({ status: id }),
        count,
      }))}
      filter={status}
      onFilter={onFilter}
      rowKey={(r) => `${r.name}·${data.rows.indexOf(r)}`}
      columns={[
        {
          key: "name",
          label: "Person",
          primary: true,
          render: (r) => r.name,
          text: (r) => r.name,
        },
        {
          key: "status",
          label: "Plan",
          render: (r) =>
            `${planStatus(r)}${r.version ? ` · v${r.version}` : ""}`,
          text: (r) => planStatus(r),
        },
        {
          key: "deadline",
          label: "Deadline",
          render: (r) =>
            `${deadlineStateLabel(r.state).label}${r.submittedLate ? " · late" : ""}`,
          text: (r) => deadlineStateLabel(r.state).label,
        },
        {
          key: "action",
          label: "",
          align: "right",
          render: (r) => {
            const label = planAction(r, canPlan);
            return label ? (
              <button
                type="button"
                className="h-10 rounded-[10px] border border-border px-3 text-sm font-medium"
                onClick={() => onOpen(r)}
              >
                {label}
              </button>
            ) : null;
          },
        },
      ]}
    />
  );
}

export function CoveragePlansList({
  month,
  ...rest
}: Omit<Parameters<typeof CoveragePlansListView>[0], "data" | "canPlan"> & {
  month: string;
}) {
  const result = useCoverageQuery(api.coverage.summary, { month });
  const permissions = useCoverageQuery(
    api.lib.capabilities.currentPermissions,
    {},
  );
  return result ? (
    <CoveragePlansListView
      data={result}
      canPlan={permissions?.capabilities.includes("mcp.plan") ?? false}
      {...rest}
    />
  ) : (
    <p>Loading plans…</p>
  );
}

export function CoverageSummaryView({
  data,
}: {
  data: Summary;
  canPlan?: boolean;
  onOpen?: (person: Person) => void;
}) {
  return (
    <div className="grid gap-4">
      <Card label="Coverage commitments" icon={<WorkspaceIcon name="field" />}>
        <p className="text-lg">
          {data.ready} of {data.target} people ready for{" "}
          {monthLabel(data.month)}
        </p>
        <p className="text-sm text-muted">
          Prior month: {data.priorReady} ready in {monthLabel(data.priorMonth)}.
        </p>
        <p className="text-sm">
          {data.awaitingMine} waiting for my approval · {data.lateCount} overdue
        </p>
        <p className="text-sm text-muted">
          Submit {deadlineDate(data.deadlines.submissionOpensDate)}–
          {deadlineDate(data.deadlines.submissionDueDate)}. Approve by{" "}
          {deadlineDate(data.deadlines.approvalDueDate)}.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {Object.entries(data.counts).map(([status, count]) => (
            <div key={status}>
              <dt className="text-xs text-muted">
                {status === "not_started"
                  ? "Not started"
                  : coverageStatusLabel(status)}
              </dt>
              <dd className="text-2xl tabular-nums">{count}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card
        label="Approval readiness trend"
        icon={<WorkspaceIcon name="field" />}
      >
        <ul aria-label="Monthly readiness trend" className="grid gap-2">
          {data.trend.map((point) => (
            <li
              key={point.month}
              className="grid grid-cols-[80px_1fr_70px] gap-3 text-sm"
            >
              <span>{monthLabel(point.month)}</span>
              <meter
                className="w-full"
                min={0}
                max={Math.max(point.target, 1)}
                value={point.ready}
              />
              <span>
                {point.ready}/{point.target}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
export function CoverageSummary({ month }: { month: string }) {
  const result = useCoverageQuery(api.coverage.summary, { month });
  return result ? (
    <CoverageSummaryView data={result} />
  ) : (
    <p>Loading coverage summary…</p>
  );
}
export function CoverageStandardsReview({ review }: { review: Review }) {
  return (
    <section
      aria-label="Plan versus standard"
      className="grid gap-3 rounded-xl border border-border p-4"
    >
      <h3 className="font-semibold">Plan versus standard</h3>
      <p>
        {review.planned} planned calls · {review.visited} visited ·{" "}
        {review.productive} verified productive
      </p>
      <p className="text-sm text-muted">
        {review.standardSource
          ? `Position standard: ${review.standardSource}`
          : "No position standard configured — calls target is unknown, not zero."}{" "}
        Activity figures are received evidence, not proof an unsynced phone did
        nothing.
      </p>
      <details open>
        <summary>Calls per day</summary>
        <ul className="grid gap-1 text-sm">
          {review.daily.map((d) => (
            <li key={d.date}>
              {formatDate(d.date)}: {d.calls} calls /{" "}
              {d.target === null ? "no selling target" : `${d.target} standard`}
              {d.target !== null && d.calls < d.target
                ? " · below standard"
                : ""}
            </li>
          ))}
        </ul>
      </details>
      <div>
        <h4>Stores per route</h4>
        <ul>
          {review.routes.map((r) => (
            <li key={r.code}>
              {r.code} · {r.stores} stores
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4>Frequency gaps</h4>
        {review.frequencyGaps.length ? (
          <ul>
            {review.frequencyGaps.map((r) => (
              <li key={r.outletId}>
                {r.name}: {r.planned} planned / {r.expected} cadence visits
              </li>
            ))}
          </ul>
        ) : (
          <p>No frequency gaps.</p>
        )}
        <p className="text-xs text-muted">
          Cadence counts are advisory. Review the calendar and adjust dates
          before approval.
        </p>
      </div>
    </section>
  );
}
