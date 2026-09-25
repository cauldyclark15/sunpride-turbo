"use client";
import type {
  ScheduleFilters,
  ScheduleHeader,
  ScheduleRow,
} from "../lib/coverage-export";
import "./coverage-print.css";

export function CoveragePrint({
  header,
  rows,
  filters,
}: {
  header: ScheduleHeader;
  rows: ScheduleRow[];
  filters: ScheduleFilters;
}) {
  const time = (value?: number) =>
    value === undefined
      ? "—"
      : new Intl.DateTimeFormat("en-PH", {
          timeZone: "Asia/Manila",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(value);
  return (
    <section
      className="coverage-print-view"
      aria-label="Printable coverage schedule"
    >
      <div className="coverage-print-controls">
        <button type="button" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>
      <h2>Master Coverage Plan · {header.localMonth}</h2>
      <p>
        {header.status} · Version {header.version} · {header.assigneeName}
      </p>
      <p>
        Prepared: {header.preparedByName} · {time(header.preparedAt)}
        <br />
        Submitted: {header.submittedByName ?? "—"} · {time(header.submittedAt)}
        <br />
        Approved: {header.approvedByName ?? "—"} · {time(header.approvedAt)}
        <br />
        {header.signedHashPrefix
          ? `Signed hash: ${header.signedHashPrefix}`
          : "UNAPPROVED — provisional schedule"}
      </p>
      <p>
        Territory: {filters.territoryId ?? "All"} · Route:{" "}
        {filters.routeId ?? "All"} · Visit status:{" "}
        {filters.visitStatus ?? "All"}
      </p>
      <table>
        <thead>
          <tr>
            <th>Date (Manila)</th>
            <th>Stop</th>
            <th>Kind</th>
            <th>Outlet</th>
            <th>Activity</th>
            <th>Territory</th>
            <th>Route</th>
            <th>Visit</th>
            <th>Minutes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.slotKey}>
              <td>{row.serviceDate}</td>
              <td>{row.sequence}</td>
              <td>{row.kind}</td>
              <td>{row.outletCode ?? "—"}</td>
              <td>{row.name ?? "—"}</td>
              <td>{row.territoryCode ?? "—"}</td>
              <td>{row.routeCode ?? "—"}</td>
              <td>{row.visitStatus ?? "—"}</td>
              <td>{row.durationMinutes}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p>No entries match these filters.</p>}
    </section>
  );
}
