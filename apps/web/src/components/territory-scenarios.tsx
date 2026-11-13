"use client";
import { formatDate } from "../lib/format";
import { useMemo, useRef, useState } from "react";
import { useApi, useLive, useMutate } from "../lib/api";

type Geometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] }
  | { type: "Feature"; geometry: Geometry };
type Plan = {
  routeMoves?: { routeId: string; toTerritoryId: string }[];
  boundaries?: { territoryId: string; geoJson: Geometry }[];
  routingMode?: string;
  boundaryStatus?: string;
};
type Work = {
  outlets: number;
  potential: number;
  potentialMissing: number;
  visits: number;
  serviceMinutes: number;
  travelMinutes: number;
  travelSource?: string;
  provisionalTravel?: boolean;
  unpinned: number;
  people: number;
  capacityMinutes: number;
  loadPct: number | null;
};
type TerritorySim = {
  territoryId: string;
  name: string;
  before: Work;
  after: Work;
  movedIn: number;
  movedOut: number;
  pins: { code: string; lat: number; lon: number; moved: boolean }[];
  boundary?: Geometry | null;
  previousBoundary?: Geometry | null;
};
type Scenario = {
  id: string;
  name: string;
  effectiveOn: string;
  status: "draft" | "published" | "discarded";
  moves: number;
  preparedBy: string;
  preparedById: string;
  publishedBy: string | null;
  contentHash: string;
  territories: TerritorySim[];
  plan?: Plan;
  boundaryJobStatus?: string | null;
};
type Book = {
  canPlan: boolean;
  canBoundary?: boolean;
  me: string | null;
  territories: { id: string; name: string; boundaryGeoJson?: string | null }[];
  routes?: { id: string; name: string; territoryId: string }[];
  routingConfigured?: boolean;
  stores: { id: string; code: string; name: string; territoryId: string }[];
  scenarios: Scenario[];
};

const button =
  "min-h-10 rounded-[10px] border border-border px-3 py-2 text-sm disabled:opacity-40";
const hours = (m: number) => `${(m / 60).toFixed(1)}\u00a0h`;
/** F-224: potential is unknown, not zero, when no store in the set carries it. */
export function potential(w: Work) {
  return w.potentialMissing === w.outlets
    ? "Not recorded"
    : Math.round(w.potential).toLocaleString("en-PH");
}

/** F-224: the one-line reading of a territory's load change. */
export function loadReading(t: TerritorySim) {
  const b = t.before.loadPct,
    a = t.after.loadPct;
  if (a == null) return "No salesperson assigned: capacity unknown.";
  const over = a > 100 ? " Over capacity." : a < 60 ? " Under-used." : "";
  return `${b ?? "—"}% → ${a}% of capacity.${over}`;
}

export function boundaryRings(g?: Geometry | null): [number, number][][] {
  if (!g) return [];
  if (g.type === "Feature") return boundaryRings(g.geometry);
  return g.type === "Polygon" ? g.coordinates : g.coordinates.flat();
}
export function boundaryMessage(plan?: Plan, status?: string | null) {
  if (!plan?.boundaries?.length) return null;
  if (plan.boundaryStatus === "applied")
    return "Boundary shapes applied on the effective day.";
  if (status === "failed")
    return "Boundary update needs reconciliation. Existing shapes remain; save a corrected scenario.";
  return plan.boundaryStatus === "scheduled"
    ? "Boundary shapes are scheduled for the effective day. People assignments do not move automatically."
    : `${plan.boundaries.length} boundary shapes await independent review.`;
}
/** F-224: small pin sketch for one territory after the moves; moved stores are drawn hollow. */
function PinSketch({ t }: { t: TerritorySim }) {
  const proposed = boundaryRings(t.boundary),
    previous = boundaryRings(t.previousBoundary);
  if (t.pins.length === 0 && !proposed.length && !previous.length)
    return <p className="text-xs text-muted">No verified pins.</p>;
  const pts = [
    ...t.pins.map((p) => [p.lon, p.lat] as [number, number]),
    ...proposed.flat(),
    ...previous.flat(),
  ];
  const lats = pts.map((p) => p[1]),
    lons = pts.map((p) => p[0]);
  const [y0, y1, x0, x1] = [
    Math.min(...lats),
    Math.max(...lats),
    Math.min(...lons),
    Math.max(...lons),
  ];
  const sx = (v: number) => 8 + ((v - x0) / (x1 - x0 || 1)) * 144,
    sy = (v: number) => 8 + (1 - (v - y0) / (y1 - y0 || 1)) * 84;
  return (
    <svg
      role="img"
      aria-label={`Store pins in ${t.name} after the change`}
      width={160}
      height={100}
      className="rounded border border-border"
    >
      {[
        ...previous.map((r) => ({ r, old: true })),
        ...proposed.map((r) => ({ r, old: false })),
      ].map(({ r, old }, i) => (
        <path
          key={i}
          d={
            r
              .map((p, j) => `${j ? "L" : "M"}${sx(p[0])},${sy(p[1])}`)
              .join(" ") + " Z"
          }
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray={old ? "3 3" : undefined}
          opacity={old ? 0.4 : 0.8}
        />
      ))}
      {t.pins.map((p) => (
        <circle
          key={p.code}
          cx={sx(p.lon)}
          cy={sy(p.lat)}
          r={p.moved ? 5 : 3}
          fill={p.moved ? "none" : "currentColor"}
          stroke="currentColor"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

export function CompareTable({ territories }: { territories: TerritorySim[] }) {
  return (
    <div className="grid gap-1 overflow-x-auto">
      <p className="text-xs text-muted">
        Before → after. Load = (visit time + estimated travel) ÷ capacity over
        four weeks. Hollow circles are moved stores; old boundaries are dashed
        and proposed boundaries solid. Road estimates exclude live traffic.
      </p>
      <table
        aria-label="Before and after"
        className="w-full text-sm [&_td]:whitespace-nowrap [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1"
      >
        <thead>
          <tr>
            <th className="text-left">Territory</th>
            <th className="text-right">Stores</th>
            <th className="text-right">Potential</th>
            <th className="text-right">Service / 4 wk</th>
            <th className="text-right">Travel / 4 wk (est.)</th>
            <th className="text-right">Capacity</th>
            <th className="text-left">Load</th>
            <th>Map after</th>
          </tr>
        </thead>
        <tbody>
          {territories.map((t) => (
            <tr key={t.territoryId}>
              <td>
                {t.name}
                <span className="block text-xs text-muted">
                  {t.movedIn ? `+${t.movedIn} in ` : ""}
                  {t.movedOut ? `−${t.movedOut} out` : ""}
                </span>
              </td>
              <td className="text-right tabular-nums">
                {t.before.outlets} → {t.after.outlets}
              </td>
              <td className="text-right tabular-nums">
                {potential(t.before)} → {potential(t.after)}
                {t.after.potentialMissing &&
                t.after.potentialMissing < t.after.outlets ? (
                  <span className="block text-xs text-muted">
                    {t.after.potentialMissing} without potential
                  </span>
                ) : null}
              </td>
              <td className="text-right tabular-nums">
                {hours(t.before.serviceMinutes)} →{" "}
                {hours(t.after.serviceMinutes)}
              </td>
              <td className="text-right tabular-nums">
                {hours(t.before.travelMinutes)} → {hours(t.after.travelMinutes)}
                <span className="block max-w-56 whitespace-normal text-xs text-muted">
                  Before:{" "}
                  {t.before.travelSource ??
                    "SAMPLE geometric estimate · historical scenario"}
                </span>
                <span className="block max-w-56 whitespace-normal text-xs text-muted">
                  After:{" "}
                  {t.after.travelSource ??
                    "SAMPLE geometric estimate · historical scenario"}
                </span>
                {t.after.unpinned ? (
                  <span className="block text-xs text-muted">
                    {t.after.unpinned} unpinned, not counted
                  </span>
                ) : null}
              </td>
              <td className="text-right tabular-nums">
                {t.after.people} {t.after.people === 1 ? "person" : "people"},{" "}
                {hours(t.after.capacityMinutes)}
              </td>
              <td>{loadReading(t)}</td>
              <td>
                <PinSketch t={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** F-224: draft store moves between territories, compare, then a second person publishes. */
export function TerritoryScenarios() {
  const data = useApi<Book>(
    ["coverage", "territory-scenarios"],
    "/api/v1/coverage/territory-scenarios",
  );
  useLive(["coverage"], [["coverage"]]);
  const { mutate } = useMutate();
  const keys = useRef(new Map<string, string>());
  const [moves, setMoves] = useState<
      { outletId: string; toTerritoryId: string }[]
    >([]),
    [from, setFrom] = useState(""),
    [store, setStore] = useState(""),
    [to, setTo] = useState(""),
    [name, setName] = useState("SAMPLE rebalance — not client-agreed"),
    [effectiveOn, setEffectiveOn] = useState(""),
    [sim, setSim] = useState<TerritorySim[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [routeMoves, setRouteMoves] = useState<
    { routeId: string; toTerritoryId: string }[]
  >([]);
  const [route, setRoute] = useState("");
  const [boundaries, setBoundaries] = useState<
    { territoryId: string; geoJson: Geometry }[]
  >([]);
  const [boundaryText, setBoundaryText] = useState("");
  const [routingMode, setRoutingMode] = useState("estimate");
  const plan = { routeMoves, boundaries, routingMode };
  const hasChanges = moves.length + routeMoves.length + boundaries.length > 0;
  const stores = useMemo(
    () => (data.data?.stores ?? []).filter((s) => s.territoryId === from),
    [data.data, from],
  );
  async function post<T>(
    path: string,
    body: object,
    message: string,
    keyed = false,
  ) {
    let payload: object = body;
    if (keyed) {
      const intent = JSON.stringify({ path, body });
      let key = keys.current.get(intent);
      if (!key) {
        key = crypto.randomUUID();
        keys.current.set(intent, key);
      }
      payload = { ...body, idempotencyKey: key };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await mutate<T>(
        `/api/v1/coverage/territory-scenarios/${path}`,
        payload,
        { invalidate: [["coverage"]] },
      );
      if (message) setNotice(message);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      return null;
    } finally {
      setBusy(false);
    }
  }
  if (data.error)
    return <p role="alert">Territory scenarios could not be loaded.</p>;
  if (!data.data) return <p>Loading territory scenarios…</p>;
  const d = data.data;
  const label = (id: string) =>
    d.territories.find((t) => t.id === id)?.name ?? "Territory";
  const storeLabel = (id: string) => {
    const s = d.stores.find((x) => x.id === id);
    return s ? `${s.name} (${s.code})` : "Store";
  };
  const drafts = d.scenarios.filter((s) => s.status === "draft");
  const done = d.scenarios.filter((s) => s.status === "published");
  return (
    <section aria-label="Territory rebalancing" className="grid gap-4">
      <header>
        <h2 className="text-lg font-medium">
          Would moving these stores even out the workload?
        </h2>
        <p className="text-sm text-muted">
          Draft store moves between territories and compare stores, potential,
          visit and travel time against each team&apos;s capacity. Travel is a
          labelled SAMPLE geometric estimate or an operator-configured
          road-graph estimate, never live traffic. Whole route moves preserve
          stop order. A second person publishes; the move starts on the chosen
          day and the stores join the destination&apos;s next journey plan.
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {drafts.length > 0 && (
        <section aria-label="Waiting to publish" className="grid gap-3">
          <h3 className="font-medium">Waiting to publish ({drafts.length})</h3>
          {drafts.map((s) => (
            <article
              key={s.id}
              className="grid gap-2 rounded-xl border border-border p-3"
            >
              <p className="text-sm font-medium">
                {s.name} · {s.moves} {s.moves === 1 ? "store" : "stores"} · from{" "}
                {formatDate(s.effectiveOn)} · prepared by {s.preparedBy}
              </p>
              <p className="text-xs text-muted">
                {boundaryMessage(s.plan, s.boundaryJobStatus)}
              </p>
              <CompareTable territories={s.territories} />
              {d.canPlan &&
              s.preparedById !== d.me &&
              (!s.plan?.boundaries?.length || d.canBoundary) ? (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    post(
                      "publish",
                      { scenarioId: s.id, contentHash: s.contentHash },
                      `Published. The moves start on ${formatDate(s.effectiveOn)}.`,
                    )
                  }
                >
                  Publish territory change
                </button>
              ) : (
                <p className="text-xs text-muted">
                  {s.preparedById === d.me
                    ? "A different person must publish your scenario."
                    : s.plan?.boundaries?.length
                      ? "A different administrator must publish boundary changes."
                      : "Waiting for an operations or admin user."}
                </p>
              )}
              {s.preparedById === d.me && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    post("discard", { scenarioId: s.id }, "Draft discarded.")
                  }
                >
                  Discard draft
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {d.canPlan && (
        <section
          aria-label="New scenario"
          className="grid gap-3 rounded-xl border border-border p-3"
        >
          <h3 className="font-medium">New scenario</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 [&_input]:w-full [&_select]:w-full">
            <label className="grid gap-1 text-sm">
              From territory
              <select
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setStore("");
                }}
              >
                <option value="">Choose</option>
                {d.territories.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Store
              <select value={store} onChange={(e) => setStore(e.target.value)}>
                <option value="">Choose</option>
                {stores
                  .filter((s) => !moves.some((m) => m.outletId === s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              To territory
              <select value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose</option>
                {d.territories
                  .filter((t) => t.id !== from)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className={button + " self-end"}
              disabled={!store || !to}
              onClick={() => {
                setMoves([...moves, { outletId: store, toTerritoryId: to }]);
                setStore("");
                setSim(null);
              }}
            >
              Add move
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              Travel model
              <select
                value={routingMode}
                onChange={(e) => {
                  setRoutingMode(e.target.value);
                  setSim(null);
                }}
                disabled={busy}
              >
                <option value="estimate">SAMPLE geometric estimate</option>
                <option value="road">Configured OSRM road graph</option>
              </select>
            </label>
            <p className="text-xs text-muted">
              {d.routingConfigured
                ? "A trusted operator routing origin is configured. Failed or oversized road requests remain visibly SAMPLE fallback."
                : "No road origin configured. The free geometric fallback remains clearly SAMPLE; an operator can configure a local OSRM service."}
            </p>
            <label className="grid gap-1 text-sm">
              Whole route in the source territory
              <select
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                disabled={busy}
              >
                <option value="">Choose route</option>
                {(d.routes ?? [])
                  .filter(
                    (r) =>
                      r.territoryId === from &&
                      !routeMoves.some((m) => m.routeId === r.id),
                  )
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className={button}
              disabled={busy || !route || !to || from === to}
              onClick={() => {
                setRouteMoves([
                  ...routeMoves,
                  { routeId: route, toTerritoryId: to },
                ]);
                setRoute("");
                setSim(null);
              }}
            >
              Move entire route to selected destination
            </button>
          </div>
          <p className="text-xs text-muted">
            Whole-route publication transfers its canonical territory and every
            active stop in one transaction. It does not move people; review
            destination capacity and assign its salesperson separately. Existing
            approved-plan locks remain.
          </p>
          {routeMoves.map((m) => (
            <p key={m.routeId} className="text-sm">
              {d.routes?.find((r) => r.id === m.routeId)?.name ?? "Whole route"}{" "}
              → {label(m.toTerritoryId)}{" "}
              <button
                className={button}
                onClick={() => {
                  setRouteMoves(routeMoves.filter((r) => r !== m));
                  setSim(null);
                }}
              >
                Remove route move
              </button>
            </p>
          ))}
          <details className="grid gap-2" hidden={!d.canBoundary}>
            <summary className="text-sm">
              Propose geographic boundary changes
            </summary>
            <p className="text-xs text-muted">
              Select a destination territory above. Paste its proposed
              Polygon/MultiPolygon GeoJSON, in longitude/latitude. Include each
              affected territory's replacement shape. Verified pins determine
              store moves; ambiguous or unpinned stores need explicit
              destinations. A second person approves; shapes are applied on the
              effective day, never early.
            </p>
            <label className="grid gap-1 text-sm">
              Proposed boundary
              <textarea
                rows={5}
                className="w-full rounded border border-border p-2 font-mono text-xs"
                value={boundaryText}
                onChange={(e) => setBoundaryText(e.target.value)}
                disabled={busy}
              />
            </label>
            <button
              className={button}
              disabled={busy || !to}
              onClick={() =>
                setBoundaryText(
                  d.territories.find((t) => t.id === to)?.boundaryGeoJson ?? "",
                )
              }
            >
              Load current destination shape
            </button>
            <button
              className={button}
              disabled={busy || !to || !boundaryText.trim()}
              onClick={() => {
                try {
                  const geoJson = JSON.parse(boundaryText) as Geometry;
                  setBoundaries([
                    ...boundaries.filter((b) => b.territoryId !== to),
                    { territoryId: to, geoJson },
                  ]);
                  setBoundaryText("");
                  setSim(null);
                  setError("");
                } catch {
                  setError(
                    "Paste valid GeoJSON. The server also validates closed rings and coordinate bounds.",
                  );
                }
              }}
            >
              Add destination boundary
            </button>
            {boundaries.map((b) => (
              <p key={b.territoryId} className="text-sm">
                New boundary · {label(b.territoryId)}{" "}
                <button
                  className={button}
                  onClick={() => {
                    setBoundaries(boundaries.filter((x) => x !== b));
                    setSim(null);
                  }}
                >
                  Remove boundary
                </button>
              </p>
            ))}
          </details>
          {moves.length > 0 && (
            <ul aria-label="Planned moves" className="grid gap-1 text-sm">
              {moves.map((m) => (
                <li key={m.outletId} className="flex items-center gap-2">
                  {storeLabel(m.outletId)} → {label(m.toTerritoryId)}
                  <button
                    className={button}
                    onClick={() => {
                      setMoves(moves.filter((x) => x !== m));
                      setSim(null);
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            className={button}
            disabled={busy || !hasChanges}
            onClick={async () => {
              const r = await post<{ territories: TerritorySim[] }>(
                "simulate",
                { moves, plan },
                "",
              );
              if (r) setSim(r.territories);
            }}
          >
            Simulate
          </button>
          {sim && (
            <div className="grid gap-2">
              <CompareTable territories={sim} />
              <div className="grid gap-2 sm:grid-cols-3 [&_input]:w-full">
                <label className="grid gap-1 text-sm">
                  Scenario name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Moves start on
                  <input
                    type="date"
                    value={effectiveOn}
                    onChange={(e) => setEffectiveOn(e.target.value)}
                  />
                </label>
                <button
                  className={button + " self-end"}
                  disabled={busy || !effectiveOn || !name.trim()}
                  onClick={async () => {
                    const r = await post(
                      "save",
                      { name, effectiveOn, moves, plan },
                      "Saved for a second person to publish.",
                      true,
                    );
                    if (r) {
                      setMoves([]);
                      setRouteMoves([]);
                      setBoundaries([]);
                      setSim(null);
                    }
                  }}
                >
                  Save for publishing
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {done.length > 0 && (
        <details>
          <summary className="text-sm">Published ({done.length})</summary>
          <ul className="text-sm">
            {done.map((s) => (
              <li key={s.id}>
                {s.name} · {s.moves} {s.moves === 1 ? "store" : "stores"} from{" "}
                {formatDate(s.effectiveOn)} · prepared by {s.preparedBy},
                published by {s.publishedBy}
                <p className="text-xs text-muted">
                  {boundaryMessage(s.plan, s.boundaryJobStatus)}
                </p>
                <CompareTable territories={s.territories} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
