"use client";
import { Card, WorkspaceIcon } from "@sunpride/ui";
import { api, type Summary, type Review } from "./coverage-model";
import { useCoverageQuery } from "./coverage-data";
import { coverageStatusLabel } from "../lib/coverage-view-model";
import { deadlineDate, deadlineStateLabel } from "../lib/mcp-deadlines";

export function CoverageSummaryView({
  data,
  onOpen,
}: {
  data: Summary;
  onOpen: (person: Summary["rows"][number]) => void;
}) {
  return (
    <div className="grid gap-4">
      <Card label="Coverage commitments" icon={<WorkspaceIcon name="field" />}>
        <p className="text-lg">
          {data.ready} of {data.target} people ready for {data.month}
        </p>
        <p className="text-sm text-muted">
          Target: every person approved. Prior month: {data.priorReady} ready in{" "}
          {data.priorMonth}.
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
      <Card label="Who needs action" icon={<WorkspaceIcon name="field" />}>
        {!data.rows.length ? (
          <p>
            No assigned field people in this scope. Assign people in Setup to
            begin; this is not zero coverage.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Plan</th>
                  <th>Deadline</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.profileId} className="border-t border-border">
                    <td className="py-3">{row.name}</td>
                    <td>
                      {row.status === "not_started"
                        ? "Not started"
                        : coverageStatusLabel(row.status)}
                      {row.version ? ` · v${row.version}` : ""}
                    </td>
                    <td>
                      {deadlineStateLabel(row.state).label}
                      {row.submittedLate ? " · submitted late" : ""}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="h-10 rounded-[10px] border border-border px-3"
                        onClick={() => onOpen(row)}
                      >
                        {row.action.label}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
              <span>{point.month}</span>
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
        <p className="mt-2 text-xs text-muted">
          Historical approved people, compared against today’s team size.
          Current scope applies to every month.
        </p>
      </Card>
    </div>
  );
}
export function CoverageSummary({
  month,
  onOpen,
}: {
  month: string;
  onOpen: (person: Summary["rows"][number]) => void;
}) {
  const result = useCoverageQuery(api.coverage.summary, { month });
  return result ? (
    <CoverageSummaryView data={result} onOpen={onOpen} />
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
              {d.date}: {d.calls} calls /{" "}
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
