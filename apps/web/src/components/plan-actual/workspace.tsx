"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch, useApi, useLive } from "../../lib/api";
import { currentManilaDate } from "../../lib/coverage-calendar";
import { formatDate, formatPeriod, formatTime } from "../../lib/format";
import {
  actualLabel,
  codeLabel,
  reasonLabel,
  visitActivitiesLabel,
  downloadPlanActual,
  percent,
  type Day,
  type Option,
  type PlanActual,
  type Totals,
} from "./model";

const table =
  "w-full text-left text-sm [&_th]:p-3 [&_td]:p-3 [&_tr]:border-b [&_tr]:border-border";
function Counts({ totals: t }: { totals: Totals }) {
  return (
    <>
      {t.visited}/{t.planned} stops · {t.doneActivities}/{t.plannedActivities}{" "}
      activities · {percent(t.followedPct)} followed
    </>
  );
}
export function DayDetail({ day }: { day: Day }) {
  return (
    <section
      aria-label={`Stops for ${day.person} ${day.date}`}
      className="grid gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <h3 className="font-semibold">
        {day.person} · {formatDate(day.date)}
      </h3>
      <p className="text-sm">
        <Counts totals={day.totals} />
      </p>
      <div className="overflow-x-auto">
        <table className={table}>
          <thead>
            <tr>
              {[
                "Store / route",
                "Branch / territory",
                "Result",
                "Planned activities",
                "Visits actually recorded",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {day.stops.map((s) => (
              <tr key={s.key}>
                <td>
                  <Link
                    className="underline"
                    href={`/customers/customer?storeId=${encodeURIComponent(s.outletId)}`}
                  >
                    {s.outlet}
                  </Link>
                  <p className="text-xs text-muted">
                    {s.outletCode} · {s.route}
                    {s.planVersion !== null ? ` · plan v${s.planVersion}` : ""}
                  </p>
                </td>
                <td>
                  {s.branch}
                  <p className="text-xs text-muted">
                    {s.territory} · {s.group}
                  </p>
                </td>
                <td>{codeLabel(s.status)}</td>
                <td>
                  {s.activities.length ? (
                    <ul>
                      {s.activities.map((a) => (
                        <li key={a.activityId}>
                          {a.done ? "Done" : "Not done"} — {a.name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "No store activities planned"
                  )}
                </td>
                <td>
                  {s.visits.length ? (
                    <ul>
                      {s.visits.map((v) => (
                        <li key={v.id} className="mb-2">
                          {actualLabel(v)}
                          {v.checkedInAt && (
                            <p className="text-xs text-muted">
                              In {formatTime(v.checkedInAt)}
                              {v.checkedOutAt
                                ? ` · Out ${formatTime(v.checkedOutAt)}`
                                : ""}
                            </p>
                          )}
                          {v.activities.length > 0 && (
                            <p>
                              {visitActivitiesLabel(v.activities)}
                            </p>
                          )}
                          {v.reason && <p>{reasonLabel(v.reason)}</p>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "No visit recorded"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
type Query = Record<string, string>;
/** The range view carries day totals only; one day's stores are fetched when opened (SP-0226). */
function RemoteDay({ query, dayKey }: { query: Query; dayKey: string }) {
  const r = useApi<PlanActual>(
    ["coverage", "plan-actual", { ...query, day: dayKey }],
    ({ signal }) =>
      apiFetch("/api/v1/coverage/plan-actual", {
        query: { ...query, day: dayKey },
        signal,
      }),
  );
  const day = r.data?.days.find((d) => d.key === dayKey);
  if (r.error) return <p role="alert">{r.error.message}</p>;
  return day ? <DayDetail day={day} /> : <p role="status">Loading the day…</p>;
}
export function PlanActualView({
  data,
  query,
}: {
  data: PlanActual;
  query?: Query;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const inline = data.days.find((d) => d.key === selected);
  const remote =
    !!selected && !!query && data.detail !== "all" && data.detail !== selected;
  const exportCsv = async () => {
    if (data.detail === "all" || !query) return downloadPlanActual(data);
    setExporting(true);
    try {
      downloadPlanActual(
        await apiFetch<PlanActual>("/api/v1/coverage/plan-actual", {
          query: { ...query, detail: "all" },
        }),
      );
    } finally {
      setExporting(false);
    }
  };
  const s = data.summary;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {formatPeriod(data.from, data.to)} · {data.days.length} salesman-days
          with planned or recorded work
        </p>
        <button
          className="rounded-lg border border-border px-3 py-2 text-sm"
          onClick={() => void exportCsv()}
          disabled={!data.days.length || exporting}
        >
          {exporting ? "Preparing CSV…" : "Export CSV"}
        </button>
      </div>
      <div className="grid gap-2 border-y border-border py-4 sm:grid-cols-4">
        <div>
          <p className="text-sm text-muted">Plan followed</p>
          <p className="text-2xl">{percent(s.followedPct)}</p>
          <p className="text-xs">
            {s.followed}/{s.planned} stops including all planned activities
          </p>
        </div>
        <div>
          <p className="text-sm text-muted">Visits completed</p>
          <p className="text-2xl">
            {s.visited}/{s.planned}
          </p>
          <p className="text-xs">
            {percent(s.visitPct)} of planned stops · {s.actualVisits} closed
            visits in total
          </p>
        </div>
        <div>
          <p className="text-sm text-muted">Needs follow-up</p>
          <p className="text-2xl">{s.missed} missed</p>
          <p className="text-xs">
            {s.outstanding} not yet completed today ·{" "}
            {s.plannedActivities - s.doneActivities} activities unfinished
          </p>
        </div>
        <div>
          <p className="text-sm text-muted">Outside the plan</p>
          <p className="text-2xl">{s.unplanned} visits</p>
          <p className="text-xs">Never added to plan-following credit</p>
        </div>
      </div>
      <p className="text-sm text-muted">
        Stores: {s.visitedStores} visited / {s.plannedStores} planned.
        Salesman-days: {s.visitedDays} with completed visits / {s.plannedDays}{" "}
        planned. Activities: {s.doneActivities}/{s.plannedActivities} done.
      </p>
      <p className="text-sm">
        Prior equal period ({formatPeriod(data.priorFrom, data.priorTo)}):{" "}
        <Counts totals={data.prior} />.
      </p>
      {!data.days.length ? (
        <p>
          No approved stops or recorded visits match these filters. No
          plan-following percentage can be calculated.
        </p>
      ) : (
        <>
          <h3 className="font-semibold">By salesman</h3>
          <div className="overflow-x-auto">
            <table className={table}>
              <thead>
                <tr>
                  {[
                    "Salesman",
                    "Completed / planned",
                    "Activities done / planned",
                    "Missed",
                    "Unplanned",
                    "% followed",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.salesmen.map((p) => (
                  <tr key={p.profileId}>
                    <td>{p.person}</td>
                    <td>
                      {p.totals.visited}/{p.totals.planned}
                    </td>
                    <td>
                      {p.totals.doneActivities}/{p.totals.plannedActivities}
                    </td>
                    <td>{p.totals.missed}</td>
                    <td>{p.totals.unplanned}</td>
                    <td>{percent(p.totals.followedPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="font-semibold">Daily trend and exceptions</h3>
          <p className="text-sm text-muted">
            Missed stops first. Open a day to see each store and its activities.
          </p>
          <div className="overflow-x-auto">
            <table className={table}>
              <thead>
                <tr>
                  {[
                    "Date",
                    "Salesman",
                    "Completed / planned",
                    "Activities",
                    "Missed",
                    "Unplanned",
                    "% followed",
                    "",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.key}>
                    <td>{formatDate(d.date)}</td>
                    <td>{d.person}</td>
                    <td>
                      {d.totals.visited}/{d.totals.planned}
                    </td>
                    <td>
                      {d.totals.doneActivities}/{d.totals.plannedActivities}
                    </td>
                    <td>{d.totals.missed}</td>
                    <td>{d.totals.unplanned}</td>
                    <td>{percent(d.totals.followedPct)}</td>
                    <td>
                      <button
                        className="underline"
                        onClick={() => setSelected(d.key)}
                        aria-label={`Open ${d.person} ${d.date}`}
                      >
                        Open day
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {remote && query && selected ? (
            <RemoteDay query={query} dayKey={selected} />
          ) : (
            inline && <DayDetail day={inline} />
          )}
          <Link className="text-sm underline" href="/sales-force">
            Review the next coverage plan
          </Link>
        </>
      )}
    </div>
  );
}
export function PlanActualWorkspace() {
  const today = currentManilaDate();
  const [query, setQuery] = useState({
    from: today.slice(0, 8) + "01",
    to: today,
    profileId: "",
    unitId: "",
    territoryId: "",
    territoryType: "",
    groupId: "",
  });
  const [filters, setFilters] = useState(query);
  const result = useApi<PlanActual>(
    ["coverage", "plan-actual", query],
    ({ signal }) => apiFetch("/api/v1/coverage/plan-actual", { query, signal }),
  );
  useLive(["coverage", "visits", "analytics"], [["coverage", "plan-actual"]]);
  const options = result.data?.options;
  const select = (
    key: "profileId" | "unitId" | "territoryId" | "territoryType" | "groupId",
    label: string,
    choices: Option[] = [],
  ) => (
    <label className="grid gap-1 text-sm">
      {label}
      <select
        className="h-10 min-w-40 rounded-lg border border-border pl-2 pr-8"
        aria-label={label}
        value={filters[key]}
        onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
      >
        <option value="">All</option>
        {choices.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section aria-label="Plan vs actual" className="grid gap-4">
      <header>
        <h2 className="text-xl font-semibold">
          Did the salesman follow his plan?
        </h2>
        <p className="text-sm text-muted">
          Approved store stops compared with synced field visits and
          self-reported store activities. A stop is followed only when its visit
          is closed and every planned activity is done. Rejected or
          pending-review visits do not earn credit; today's unfinished stops are
          not labelled missed. This is not productive-call or cash verification.
          Non-store work is outside this store-visit report.
        </p>
      </header>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(filters);
        }}
      >
        <label className="grid gap-1 text-sm">
          From
          <input
            aria-label="From"
            type="date"
            className="h-10"
            required
            max={today}
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </label>
        <label className="grid gap-1 text-sm">
          To
          <input
            aria-label="To"
            type="date"
            className="h-10"
            required
            min={filters.from}
            max={today}
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </label>
        {select("profileId", "Salesman", options?.people)}
        {select("unitId", "Branch", options?.branches)}
        {select("territoryId", "Territory", options?.territories)}
        {select("territoryType", "Territory type", [
          { id: "location", name: "Location" },
          { id: "customer_group", name: "Customer group" },
        ])}
        {select("groupId", "Customer group", options?.groups)}
        <button
          className="h-10 rounded-lg border border-border px-4"
          type="submit"
        >
          Show report
        </button>
        <button
          className="h-10 px-3 underline"
          type="button"
          onClick={() => void result.refetch()}
        >
          Refresh
        </button>
      </form>
      <p className="text-xs text-muted">
        Up to 93 days. Territory type and customer group use current master
        data; store names, routes and activities come from the approved plan.
        Only your currently permitted people, source branches and stores are
        included. Unsynced phone work is not yet visible.
      </p>
      {result.error ? (
        <p role="alert">{result.error.message}</p>
      ) : result.isFetching ? (
        <p role="status">Loading plan vs actual…</p>
      ) : result.data ? (
        <PlanActualView data={result.data} query={query} />
      ) : (
        <p role="status">Loading plan vs actual…</p>
      )}
    </section>
  );
}
