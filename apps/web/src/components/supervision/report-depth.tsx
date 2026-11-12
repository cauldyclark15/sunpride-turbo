"use client";
import { formatDate } from "../../lib/format";

import Link from "next/link";

import { useState } from "react";
import {
  pesoText,
  teamDailySalesCsv,
  teamPrioritiesCsv,
} from "../../lib/daily-sales";
import { useReport } from "./report-api";
import type { TeamCockpit, TeamDsr } from "./depth-model";
import type { SupervisionFilters } from "./supervision-model";

export function Sparkline({
  values,
  label,
}: {
  values: number[];
  label: string;
}) {
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const points = values
    .map(
      (v, i) =>
        `${values.length > 1 ? (i * 110) / (values.length - 1) : 0},${28 - ((v - min) * 24) / (max - min)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox="0 0 112 32"
      role="img"
      aria-label={label}
      className="h-8 w-28"
    >
      <title>{label}</title>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
export function MyTeam({ filters }: { filters: SupervisionFilters }) {
  const report = useReport("supervision.team.cockpit", filters);
  const permissions = useReport("lib.capabilities.currentPermissions", {});
  return report ? (
    <MyTeamView
      report={report}
      canPrepare={
        permissions?.capabilities.includes("deliverable.submit") ?? false
      }
    />
  ) : (
    <p role="status">Loading team priorities…</p>
  );
}
export function MyTeamView({
  report,
  canPrepare = false,
}: {
  report: TeamCockpit;
  canPrepare?: boolean;
}) {
  return (
    <section
      className="grid gap-4 rounded-xl border border-border p-5"
      aria-label="My team today and this week"
    >
      <Toolbar
        filename={`team-priorities-${report.serviceDate}`}
        csv={teamPrioritiesCsv(report)}
      />
      <div>
        <h2 className="text-lg font-semibold">My team today and this week</h2>
        <p className="text-sm text-muted">
          {formatDate(report.serviceDate)} · Week of{" "}
          {formatDate(report.week.start)}. Exceptions first.
        </p>
      </div>
      {report.rows.length === 0 ? (
        <p>No active people in this scope. Assign a team in Setup.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Person",
                  "Today: planned / visited / productive",
                  "Week / prior week",
                  "Work-With",
                  "Actions",
                  "Per diem",
                  "DAR",
                  "Trend",
                ].map((s) => (
                  <th key={s} className="p-3 font-medium">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr
                  key={r.profileId}
                  className="border-t border-border align-top"
                >
                  <td className="p-3">
                    <Link href={r.actions.day} className="underline">
                      {r.name}
                    </Link>
                    <p className="text-xs text-muted">
                      {r.position ?? "Position needs setup"} · {r.channel}
                    </p>
                  </td>
                  <td className="p-3 tabular-nums">
                    {r.today.planned} / {r.today.visited} / {r.today.productive}
                    <p className="text-xs text-muted">
                      {r.today.standard === null
                        ? "Call standard needs setup"
                        : `${r.today.standard} calls required`}
                    </p>
                  </td>
                  <td className="p-3 tabular-nums">
                    {r.week.visited} / {r.week.priorVisited}
                    <p className="text-xs text-muted">
                      {r.week.planned} planned · {r.week.productive} productive
                    </p>
                  </td>
                  <td className="p-3">
                    <Link href={r.actions.workWith} className="underline">
                      {r.workWith.done} / {r.workWith.required ?? "Needs setup"}
                    </Link>
                  </td>
                  <td className={`p-3 ${r.overdue ? "text-danger" : ""}`}>
                    <Link href={r.actions.talk} className="underline">
                      {r.talkActions} open · {r.overdue} overdue
                    </Link>
                  </td>
                  <td className="p-3">
                    <Link href={r.actions.perDiem} className="underline">
                      {r.perDiemWaiting} waiting
                    </Link>
                  </td>
                  <td className={`p-3 ${r.darMissing ? "text-danger" : ""}`}>
                    <Link href={r.actions.report} className="underline">
                      {r.darMissing
                        ? canPrepare
                          ? "Prepare missing DAR"
                          : "View missing DAR"
                        : "View report"}
                    </Link>
                  </td>
                  <td className="p-3">
                    <Sparkline
                      values={r.trend}
                      label={`${r.name}: calls this week`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">{report.definition}</p>
    </section>
  );
}
export function TeamSales({
  serviceDate,
  onPerson,
}: {
  serviceDate: string;
  onPerson: (id: string) => void;
}) {
  const report = useReport("dsr.report.team", { serviceDate });
  return report ? (
    <TeamSalesView report={report} onPerson={onPerson} />
  ) : (
    <p role="status">Loading whole-team sales…</p>
  );
}
export function TeamSalesView({
  report,
  onPerson,
}: {
  report: TeamDsr;
  onPerson: (id: string) => void;
}) {
  const [sort, setSort] = useState<"mtdSales" | "todaySales" | "prior">(
    "mtdSales",
  );
  return (
    <section className="grid gap-4" aria-label="Whole team daily sales">
      <Toolbar
        filename={`dsr-team-${report.serviceDate}`}
        csv={teamDailySalesCsv(report)}
      />
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Whole team · daily sales</h2>
          <p className="text-sm">
            Today {pesoText(report.totals.todaySales)} · MTD{" "}
            {pesoText(report.totals.mtdSales)} · Target{" "}
            {report.totals.target === null
              ? "Needs setup"
              : pesoText(report.totals.target)}{" "}
            · Prior MTD {pesoText(report.totals.prior)}
          </p>
        </div>
        <label>
          Sort by{" "}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="mtdSales">Month to date</option>
            <option value="todaySales">Today</option>
            <option value="prior">Prior period</option>
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {[
                "Salesman",
                "Today / target",
                "MTD / target",
                "Balance to sell",
                "Prior MTD",
                "Calls / productive",
                "MTD trend",
                "Next action",
              ].map((s) => (
                <th className="p-3" key={s}>
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...report.rows]
              .sort((a, b) => b[sort] - a[sort])
              .map((r) => (
                <tr key={r.profileId} className="border-t border-border">
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => onPerson(r.profileId)}
                      className="underline"
                    >
                      {r.name}
                    </button>
                  </td>
                  <td className="p-3">
                    {pesoText(r.todaySales)} /{" "}
                    {r.dailyTarget === null
                      ? "Not set"
                      : pesoText(r.dailyTarget)}
                  </td>
                  <td className="p-3">
                    {pesoText(r.mtdSales)} /{" "}
                    {r.target === null ? "Not set" : pesoText(r.target)}
                  </td>
                  <td className="p-3">{pesoText(r.balanceToSell)}</td>
                  <td className="p-3">{pesoText(r.prior)}</td>
                  <td className="p-3">
                    {r.calls} / {r.productive}
                  </td>
                  <td className="p-3">
                    <Sparkline
                      values={r.trend.map((t) => t.cumulative)}
                      label={`${r.name}: cumulative sales this month`}
                    />
                  </td>
                  <td className="p-3">
                    <Link
                      className="underline"
                      href={
                        r.target === null
                          ? "/analytics?view=sales"
                          : `/activity-reports?profileId=${r.profileId}&date=${report.serviceDate}`
                      }
                    >
                      {r.target === null ? "Set target" : "Review calls"}
                    </Link>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{report.definition}</p>
    </section>
  );
}

function Toolbar({ filename, csv }: { filename: string; csv: string }) {
  return (
    <div className="flex gap-3 print:hidden">
      <button
        type="button"
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([csv], { type: "text/csv;charset=utf-8" }),
          );
          const a = document.createElement("a");
          a.href = url;
          a.download = filename + ".csv";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Export CSV
      </button>
      <button type="button" onClick={() => window.print()}>
        Print / Save PDF
      </button>
    </div>
  );
}
