"use client";
import Link from "next/link";
import { apiFetch, useApi, useLive } from "../lib/api";
import { currentManilaDate } from "../lib/coverage-calendar";

type Fact = { planned: number; actual: number; adherencePct: number | null };
export type PjpAdherence = {
  window: { from: string; to: string };
  summary: Fact;
  prior: Fact;
  weeks: (Fact & { from: string; to: string; above85: boolean | null })[];
  fourWeekGate: string;
  rows: (Fact & {
    key: string;
    person: string;
    profileId: string;
    beat: string;
    territory: string;
    date: string;
  })[];
  frequency: {
    key: string;
    profileId: string;
    person: string;
    outletId: string;
    outlet: string;
    planned: number;
    actual: number;
    frequencyAchievedPct: number | null;
  }[];
};
const pct = (n: number | null) => (n == null ? "No plan" : `${n}%`);
export function PjpAdherenceView({ data }: { data: PjpAdherence }) {
  return (
    <section
      className="grid gap-3 rounded-xl border border-border bg-surface p-4"
      aria-label="Four-week journey plan review"
    >
      <header>
        <h2 className="font-semibold">PJP adherence: four complete weeks</h2>
        <p className="text-sm text-muted">
          {data.window.from} to {data.window.to}. Closed planned calls only;
          unplanned calls never improve this result. Frequency is achieved
          signed scheduled calls per outlet, not purchase frequency.
        </p>
      </header>
      <p className="text-lg">
        {pct(data.summary.adherencePct)} · {data.summary.actual} /{" "}
        {data.summary.planned} planned calls
      </p>
      <p className="text-sm">
        Prior four weeks: {pct(data.prior.adherencePct)}. Exit criterion: above
        85% in every week —{" "}
        {data.fourWeekGate === "passed"
          ? "met for this reading"
          : data.fourWeekGate === "not_met"
            ? "not met; review missed calls"
            : "not enough planned weeks"}
        .
      </p>
      <ol className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {data.weeks.map((w) => (
          <li
            key={w.from}
            className="rounded-lg border border-border p-2 text-sm"
          >
            Week of {w.from}
            <br />
            {pct(w.adherencePct)} · {w.actual}/{w.planned}
            <br />
            {w.above85 === true
              ? "Above 85%"
              : w.above85 === false
                ? "Needs action"
                : "No plan"}
          </li>
        ))}
      </ol>
      <details>
        <summary className="cursor-pointer text-sm">
          Drill into rep, beat, day and territory
        </summary>
        <div className="overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Rep",
                  "Territory",
                  "Beat",
                  "Day",
                  "Actual / planned",
                  "Adherence",
                ].map((s) => (
                  <th key={s} className="p-2">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="p-2">
                    <Link
                      className="underline"
                      href={`/coverage-people/agent?profileId=${encodeURIComponent(r.profileId)}&date=${r.date}`}
                    >
                      {r.person}
                    </Link>
                  </td>
                  <td>{r.territory}</td>
                  <td>{r.beat}</td>
                  <td>{r.date}</td>
                  <td>
                    {r.actual} / {r.planned}
                  </td>
                  <td>{pct(r.adherencePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary className="cursor-pointer text-sm">
          Outlet frequency achieved
        </summary>
        <ul className="grid gap-1 text-sm">
          {data.frequency.map((r) => (
            <li key={r.key}>
              <Link
                className="underline"
                href={`/customers/customer?storeId=${encodeURIComponent(r.outletId)}`}
              >
                {r.outlet}
              </Link>{" "}
              · {r.person} · {r.actual} of {r.planned} calls ·{" "}
              {pct(r.frequencyAchievedPct)}
            </li>
          ))}
        </ul>
      </details>
      <Link className="text-sm underline" href="/sales-force">
        Rebalance the next beat in Journey plans
      </Link>
    </section>
  );
}
export function PjpAdherencePanel({
  asOf,
  unitId,
  channel,
}: {
  asOf?: string;
  unitId?: string;
  channel?: string;
}) {
  const today = currentManilaDate();
  const query = {
    asOf: asOf && asOf < today ? asOf : today,
    ...(unitId ? { unitId } : {}),
    ...(channel ? { channel } : {}),
  };
  const result = useApi<PjpAdherence>(
    ["coverage", "adherence", query],
    ({ signal }) => apiFetch("/api/v1/coverage/adherence", { query, signal }),
  );
  useLive(["coverage", "analytics"], [["coverage", "adherence"]]);
  if (result.error) return <p role="alert">{result.error.message}</p>;
  if (!result.data) return <p>Loading journey plan adherence…</p>;
  return <PjpAdherenceView data={result.data} />;
}
