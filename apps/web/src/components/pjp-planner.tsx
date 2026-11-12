"use client";
import { formatDate, formatMonth, formatPeriod, formatStatus } from "../lib/format";

import { useRef, useState } from "react";
import { apiFetch, useApi, useLive, useMutate } from "../lib/api";
import {
  currentManilaDate,
  currentManilaMonth,
} from "../lib/coverage-calendar";
import { formatManilaDate } from "../lib/manila-date";
import type { PjpRegistry, PjpSimulation } from "./pjp-model";

const field = "grid gap-1 text-sm";
const action =
  "h-10 rounded-[10px] border border-border px-3 text-sm disabled:opacity-40";
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const day = (ms: number) => new Date(ms + 28800000).toISOString().slice(0, 10);

export function PjpSimulationView({
  simulation,
}: {
  simulation: PjpSimulation;
}) {
  const r = simulation.result;
  const points = r.assignments.filter(
    (a) => a.latitude != null && a.longitude != null,
  );
  const lats = points.map((p) => p.latitude!),
    lngs = points.map((p) => p.longitude!);
  const minLat = Math.min(...lats),
    minLng = Math.min(...lngs);
  const span = Math.max(
    Math.max(...lats) - minLat,
    Math.max(...lngs) - minLng,
    0.001,
  );
  return (
    <section className="grid gap-4" aria-label="Journey plan simulation">
      <p role="status">
        {r.overloadedDays.length
          ? `${r.overloadedDays.length} overloaded days — rebalance before publishing.`
          : "Within daily capacity. Ready for independent approval."}
      </p>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          [
            "Visits vs existing signed plan",
            `${r.totalVisits} / ${r.previous.visits}`,
          ],
          [
            "Service minutes vs existing",
            `${r.serviceMinutes} / ${r.previous.serviceMinutes}`,
          ],
          ["Outlets", r.outletCount],
          ["Travel minutes (estimate)", r.travelMinutes],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="text-lg tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted">
        {r.travelSource}. Potential:{" "}
        {r.potentialIncomplete
          ? "incomplete — some stores have no estimate"
          : new Intl.NumberFormat("en-PH", {
              style: "currency",
              currency: "PHP",
            }).format(r.potential)}
        . Existing means the signed plan in this same month, not prior-month
        actuals.
      </p>
      {points.length ? (
        <figure>
          <svg
            viewBox="0 0 400 180"
            className="max-h-52 w-full border border-border"
            aria-label="Outlet pin comparison"
          >
            {points.map((p) => (
              <circle
                key={p.outletId}
                cx={12 + ((p.longitude! - minLng) / span) * 360}
                cy={168 - ((p.latitude! - minLat) / span) * 150}
                r="4"
                fill="currentColor"
              >
                <title>
                  {p.outletName}: {weekdays[p.weekday]}, cycle week{" "}
                  {p.phaseWeek + 1}
                </title>
              </circle>
            ))}
          </svg>
          <figcaption className="text-xs text-muted">
            Verified pins; spatial sketch, not a road route.{" "}
            {r.outletCount - points.length} stores without a verified pin.
          </figcaption>
        </figure>
      ) : (
        <p className="text-sm text-muted">
          No verified pins for a map comparison. The table remains complete.
        </p>
      )}
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <caption className="text-left font-medium">
            Beat-cycle allocation
          </caption>
          <thead>
            <tr>
              {["Outlet", "Class", "Beat day", "Cycle week", "Visits"].map(
                (s) => (
                  <th key={s} className="p-2">
                    {s}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {r.assignments.map((a) => (
              <tr key={a.outletId} className="border-t border-border">
                <td className="p-2">{a.outletName}</td>
                <td>{a.classKey}</td>
                <td>{weekdays[a.weekday]}</td>
                <td>{a.phaseWeek + 1}</td>
                <td>{a.visits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <caption className="text-left font-medium">
            Daily workload against capacity
          </caption>
          <thead>
            <tr>
              {[
                "Day",
                "Calls",
                "Service min",
                "Travel min",
                "Total / capacity",
              ].map((s) => (
                <th key={s} className="p-2">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.days.map((d) => (
              <tr key={d.date} className="border-t border-border">
                <td className="p-2">
                  {formatManilaDate(Date.parse(d.date + "T00:00:00+08:00"))}
                </td>
                <td>{d.visits}</td>
                <td>{d.serviceMinutes}</td>
                <td>{d.travelMinutes}</td>
                <td>
                  {d.totalMinutes} / {d.capacityMinutes}
                  {d.totalMinutes > d.capacityMinutes ? " — Over capacity" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** F-201/F-202: extends the existing Coverage workspace, no second planning engine. */
export function PjpPlanner({ capabilities }: { capabilities: string[] }) {
  const registry = useApi<PjpRegistry>(
    ["coverage", "pjp"],
    "/api/v1/coverage/pjp",
  );
  const { mutate } = useMutate();
  useLive(["coverage"], [["coverage"]]);
  const [offset, setOffset] = useState(0);
  const outlets = useApi<{
    page: { _id: string; name: string; classification?: string }[];
    isDone: boolean;
  }>(["coverage", "pjp-outlets", offset], ({ signal }) =>
    apiFetch("/api/v1/coverage/lookup/outlets", {
      query: {
        input: JSON.stringify({
          paginationOpts: { numItems: 50, cursor: String(offset) },
        }),
      },
      signal,
    }),
  );
  const [person, setPerson] = useState("");
  const [name, setName] = useState("");
  const [from, setFrom] = useState(currentManilaDate);
  const [to, setTo] = useState("");
  const [anchor, setAnchor] = useState("");
  const [capacity, setCapacity] = useState("480");
  const [travel, setTravel] = useState("15");
  const [selling, setSelling] = useState([1, 2, 3, 4, 5, 6]);
  const [stops, setStops] = useState<
    Record<string, { name: string; weekday?: number; phaseWeek?: number }>
  >({});
  const [selected, setSelected] = useState("");
  const [month, setMonth] = useState(currentManilaMonth);
  const [predecessor, setPredecessor] = useState("");
  const [simulation, setSimulation] = useState<PjpSimulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [classKey, setClassKey] = useState("");
  const [policyLabel, setPolicyLabel] = useState("");
  const [interval, setInterval] = useState("1");
  const [minutes, setMinutes] = useState("30");
  const [objectives, setObjectives] = useState("");
  const [source, setSource] = useState("SAMPLE — awaiting Sunpride approval");
  const [replace, setReplace] = useState("");
  const keys = useRef(new Map<string, string>());
  const canPlan = capabilities.includes("mcp.plan"),
    canApprove = capabilities.includes("mcp.approve");
  async function send<T>(
    command: string,
    body: object,
  ): Promise<T | undefined> {
    const intent = JSON.stringify({ command, body });
    let key = keys.current.get(intent);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(intent, key);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await mutate<T>(
        `/api/v1/coverage/pjp/${command}`,
        { ...body, idempotencyKey: key },
        { invalidate: [["coverage"]] },
      );
      keys.current.delete(intent);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save journey plan");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  if (registry.error) return <p role="alert">{registry.error.message}</p>;
  if (!registry.data) return <p>Loading journey plans…</p>;
  const data = registry.data;
  const unit = data.people.find((p) => p._id === person)?.currentUnitId;
  return (
    <div className="grid gap-6">
      <header>
        <h2 className="text-xl font-semibold">Permanent journey plans</h2>
        <p className="text-sm text-muted">
          Can this beat serve its stores at the required frequency without
          overloading the rep? Simulate, generate a monthly plan, then have a
          different approver publish it.
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <section className="grid gap-3 rounded-xl border border-border p-4">
        <h3 className="font-medium">Beat-cycle templates</h3>
        <label className={field}>
          Saved version
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setSimulation(null);
            }}
          >
            <option value="">Choose a template</option>
            {data.templates.map((t) => (
              <option key={t._id} value={t._id}>
                {t.name} · {t.assigneeName} · version {t.version}
              </option>
            ))}
          </select>
        </label>
        <label className={field}>
          Simulation month
          <input
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setSimulation(null);
            }}
          />
        </label>
        <label className={field}>
          Replace an existing signed plan (optional)
          <select
            value={predecessor}
            onChange={(e) => setPredecessor(e.target.value)}
          >
            <option value="">No predecessor</option>
            {data.existingPlans
              .filter(
                (p) =>
                  p.localMonth === month &&
                  p.assigneeProfileId ===
                    data.templates.find((t) => t._id === selected)
                      ?.assigneeProfileId,
              )
              .map((p) => (
                <option key={p._id} value={p._id}>
                  {formatMonth(p.localMonth)} · version {p.version} · from{" "}
                  {formatDate(p.effectiveFrom)}
                </option>
              ))}
          </select>
        </label>
        {canPlan && (
          <button
            className={action}
            disabled={busy || !selected}
            onClick={async () => {
              const s = await send<PjpSimulation>("simulate", {
                templateId: selected,
                month,
              });
              if (s) setSimulation(s);
            }}
          >
            Simulate workload
          </button>
        )}
        {simulation && (
          <>
            <PjpSimulationView simulation={simulation} />
            {canPlan && (
              <button
                className={action}
                disabled={busy || simulation.result.overloadedDays.length > 0}
                onClick={async () => {
                  const p = await send<{ _id: string }>("generate", {
                    templateId: selected,
                    simulationId: simulation.simulationId,
                    ...(predecessor ? { basedOnPlanId: predecessor } : {}),
                  });
                  if (p) {
                    setNotice(
                      "Monthly plan submitted. A different approver must publish it below.",
                    );
                    setSimulation(null);
                  }
                }}
              >
                Generate monthly plan for approval
              </button>
            )}
          </>
        )}
        {canPlan && (
          <button
            type="button"
            className={action}
            disabled={!selected || busy}
            onClick={() => {
              const t = data.templates.find((t) => t._id === selected);
              if (!t) return;
              setName(t.name);
              setPerson(t.assigneeProfileId);
              setFrom(day(t.effectiveFrom));
              setTo(day(t.effectiveTo));
              setAnchor(t.anchorDate);
              setCapacity(String(t.capacityMinutes));
              setTravel(String(t.travelMinutes));
              setSelling(t.sellingWeekdays);
              setStops(
                Object.fromEntries(
                  t.stops.map((s) => [
                    s.outletId,
                    {
                      ...s,
                      name:
                        simulation?.result.assignments.find(
                          (a) => a.outletId === s.outletId,
                        )?.outletName ??
                        outlets.data?.page.find((o) => o._id === s.outletId)
                          ?.name ??
                        "Store from saved template",
                    },
                  ]),
                ),
              );
              setNotice(
                "Template copied to the editable form below. Choose a prospective start date and save a new version.",
              );
            }}
          >
            Copy selected template to a new version
          </button>
        )}
        <h3 className="font-medium">Publication queue</h3>
        {data.publications.length ? (
          data.publications.map((p) => (
            <div
              key={p._id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2"
            >
              <span>
                {data.templates.find((t) => t._id === p.templateId)?.name ??
                  "Journey plan"}{" "}
                · {formatMonth(p.localMonth)} · version {p.version} ·{" "}
                {formatStatus(p.status)}
              </span>
              {p.status === "submitted" && canApprove && (
                <button
                  className={action}
                  disabled={busy}
                  onClick={async () => {
                    const r = await send("publish", { planId: p.planId });
                    if (r)
                      setNotice(
                        "Journey plan published with its signed schedule and effective dates. Due plans activate automatically.",
                      );
                  }}
                >
                  Approve and publish
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-muted">No generated plans yet.</p>
        )}
      </section>
      {canPlan && (
        <form
          className="grid gap-3 rounded-xl border border-border p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = await send<{ _id: string }>("template", {
              name,
              assigneeProfileId: person,
              fromDate: from,
              toDate: to,
              anchorDate: anchor,
              capacityMinutes: Number(capacity),
              travelMinutes: Number(travel),
              sellingWeekdays: selling,
              stops: Object.entries(stops).map(([outletId, s]) => ({
                outletId,
                weekday: s.weekday,
                phaseWeek: s.phaseWeek,
              })),
            });
            if (t) {
              setSelected(t._id);
              setSimulation(null);
              setNotice(
                "New template version saved. Simulate it before generating.",
              );
            }
          }}
        >
          <h3 className="font-medium">New template or revised scenario</h3>
          <p className="text-sm text-muted">
            Versions are immutable. Save a new version to change a beat. Empty
            day and cycle week let workload balancing choose.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={field}>
              Template name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className={field}>
              Rep
              <select
                required
                value={person}
                aria-label="Rep"
                onChange={(e) => setPerson(e.target.value)}
              >
                <option value="">Choose a rep</option>
                {data.people.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              Effective from
              <input
                required
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className={field}>
              Effective until (exclusive)
              <input
                required
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <label className={field}>
              Cycle anchor (Monday)
              <input
                required
                type="date"
                value={anchor}
                onChange={(e) => setAnchor(e.target.value)}
              />
            </label>
            <label className={field}>
              Daily capacity (minutes)
              <input
                required
                type="number"
                min="1"
                max="1440"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </label>
            <label className={field}>
              Provisional travel per stop (minutes)
              <input
                required
                type="number"
                min="0"
                max="240"
                value={travel}
                onChange={(e) => setTravel(e.target.value)}
              />
            </label>
          </div>
          <fieldset>
            <legend>Selling weekdays</legend>
            <div className="flex flex-wrap gap-3">
              {weekdays.map((d, i) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={selling.includes(i)}
                    onChange={(e) =>
                      setSelling(
                        e.target.checked
                          ? [...selling, i]
                          : selling.filter((n) => n !== i),
                      )
                    }
                  />{" "}
                  {d}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend>
              Choose outlets ({Object.keys(stops).length} selected)
            </legend>
            {outlets.error && <p role="alert">{outlets.error.message}</p>}
            {outlets.data?.page.map((o) => (
              <label key={o._id} className="text-sm">
                <input
                  type="checkbox"
                  checked={!!stops[o._id]}
                  onChange={(e) =>
                    setStops((prev) => {
                      const next = { ...prev };
                      if (e.target.checked) next[o._id] = { name: o.name };
                      else delete next[o._id];
                      return next;
                    })
                  }
                />{" "}
                {o.name} · class {o.classification ?? "not set"}
              </label>
            ))}
            <div className="flex gap-2">
              <button
                type="button"
                className={action}
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous outlets
              </button>
              <button
                type="button"
                className={action}
                disabled={!outlets.data || outlets.data.isDone}
                onClick={() => setOffset(offset + 50)}
              >
                More outlets
              </button>
            </div>
          </fieldset>
          {Object.entries(stops).map(([id, s]) => (
            <div key={id} className="grid gap-2 sm:grid-cols-3">
              <span>{s.name}</span>
              <label className={field}>
                Day for {s.name}
                <select
                  value={s.weekday ?? ""}
                  onChange={(e) =>
                    setStops({
                      ...stops,
                      [id]: {
                        ...s,
                        weekday:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      },
                    })
                  }
                >
                  <option value="">Balance automatically</option>
                  {selling.map((i) => (
                    <option key={i} value={i}>
                      {weekdays[i]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={field}>
                Cycle week for {s.name}
                <select
                  value={s.phaseWeek ?? ""}
                  onChange={(e) =>
                    setStops({
                      ...stops,
                      [id]: {
                        ...s,
                        phaseWeek:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      },
                    })
                  }
                >
                  <option value="">Balance automatically</option>
                  {[0, 1, 2, 3].map((i) => (
                    <option key={i} value={i}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
          <button className={action} disabled={busy}>
            Save new template version
          </button>
        </form>
      )}
      <section className="grid gap-3 rounded-xl border border-border p-4">
        <h3 className="font-medium">
          Effective outlet-class frequency policies
        </h3>
        {data.policies.map((p) => (
          <p key={p._id} className="text-sm">
            {p.label} · class {p.classKey} · every {p.intervalWeeks} week(s) ·{" "}
            {p.serviceMinutes} minutes · {formatPeriod(p.effectiveFrom, p.effectiveTo ?? null)} · {p.sourceRef}
          </p>
        ))}
        {capabilities.includes("masterdata.manage") && (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!unit) {
                setError("Choose the rep above to set the policy scope.");
                return;
              }
              const p = await send("policy", {
                orgUnitId: unit,
                classKey,
                label: policyLabel,
                intervalWeeks: Number(interval),
                serviceMinutes: Number(minutes),
                objectives: objectives
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                fromDate: from,
                sourceRef: source,
                ...(replace ? { replacesPolicyId: replace } : {}),
              });
              if (p) setNotice("Effective class frequency policy saved.");
            }}
          >
            <label className={field}>
              Class key
              <input
                required
                value={classKey}
                onChange={(e) => setClassKey(e.target.value)}
              />
            </label>
            <label className={field}>
              Policy name
              <input
                required
                value={policyLabel}
                onChange={(e) => setPolicyLabel(e.target.value)}
              />
            </label>
            <label className={field}>
              Frequency
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="1">Weekly</option>
                <option value="2">Every two weeks</option>
                <option value="4">Every four weeks</option>
              </select>
            </label>
            <label className={field}>
              Service minutes
              <input
                type="number"
                min="1"
                max="480"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </label>
            <label className={field}>
              Objectives (one per line)
              <textarea
                value={objectives}
                onChange={(e) => setObjectives(e.target.value)}
              />
            </label>
            <label className={field}>
              Source or sample marker
              <input
                required
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
            <label className={field}>
              Policy being replaced
              <select
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
              >
                <option value="">New class / non-overlapping interval</option>
                {data.policies
                  .filter((p) => p.orgUnitId === unit)
                  .map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.label} · {formatDate(p.effectiveFrom)}
                    </option>
                  ))}
              </select>
            </label>
            <p className="text-sm text-muted">
              Starts on the Effective from date above. A replacement closes the
              old policy on that date, never rewrites past frequency.
            </p>
            <button className={action} disabled={busy || !unit}>
              Save class policy
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
