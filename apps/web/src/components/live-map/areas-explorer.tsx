"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { geoContains, geoMercator, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { motion, useReducedMotion } from "motion/react";
import { Card } from "@sunpride/ui";
import { apiFetch, useApi, useApiPages, useLive } from "../../lib/api";
import { manilaToday, type LiveData, type StorePin } from "./live-map-model";
import {
  bin,
  COLORS,
  compactMetric,
  fitCamera,
  legendRanges,
  placeLabels,
  shortAreaName,
  escapeAction,
  formatMetric,
  listIndex,
  METRICS,
  metricValue,
  NO_DATA,
  ordinal,
  periodDates,
  rankAreas,
  steps,
  type AreaData,
  type Metric,
} from "./areas-model";
import "./areas-explorer.css";

type Shape = Feature<Geometry, { name: string }>;
type Shapes = FeatureCollection<Geometry, { name: string }>;
type Level = { shape: Shape; file: string };
const collection = (shapes: Shape[]): Shapes => ({
  type: "FeatureCollection",
  features: shapes,
});
async function loadShapes(file: string, signal: AbortSignal): Promise<Shapes> {
  const response = await fetch(`/maps/ph/${file}.json`, { signal });
  if (!response.ok)
    throw new Error("Area boundaries could not be loaded. Try again.");
  const topology = (await response.json()) as Topology<{
    areas: GeometryCollection<{ name: string }>;
  }>;
  return feature(topology, topology.objects.areas) as Shapes;
}

function CountingTotal({
  value,
  metric,
}: {
  value: number | null;
  metric: Metric;
}) {
  const reduced = useReducedMotion();
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef(0);
  const previousMetric = useRef(metric);
  useEffect(() => {
    const target = value ?? 0,
      start = previousMetric.current === metric ? previous.current : 0,
      began = performance.now();
    previousMetric.current = metric;
    let frame = 0;
    function tick(now: number) {
      const t = reduced ? 1 : Math.min(1, (now - began) / 550);
      const v = Math.round(start + (target - start) * (1 - (1 - t) ** 3));
      if (element.current)
        element.current.textContent =
          value === null ? "No data" : formatMetric(v, metric);
      previous.current = v;
      if (t < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, metric, reduced]);
  return (
    <span ref={element} aria-label={formatMetric(value, metric)}>
      {formatMetric(value, metric)}
    </span>
  );
}

function CityPins({
  city,
  project,
  kind,
  unit,
  scale,
  onStatus,
}: {
  city: Shape;
  project: ReturnType<typeof geoMercator>;
  kind: string;
  unit: string;
  scale: number;
  onStatus: (message: string) => void;
}) {
  const people = useApi<LiveData>(
    kind === "people" ? ["location", "live", unit] : null,
    ({ signal }) =>
      apiFetch("/api/v1/location/live", {
        query: { orgUnitId: unit || undefined },
        signal,
      }),
  );
  const stores = useApiPages<StorePin>(
    kind === "stores" ? ["location", "store-pins", unit] : null,
    (cursor, { signal }) =>
      apiFetch("/api/v1/location/store-pins", {
        query: { cursor: cursor || undefined, orgUnitId: unit || undefined },
        signal,
      }),
    { all: true, maxPages: 20 },
  );
  const points =
    (kind === "people"
      ? people.data?.positions
          .filter((p) => p.freshness === "fresh" && !p.mockLocation)
          .map((p) => ({ ...p, label: p.name }))
      : (stores.items ?? []).map((p) => ({ ...p, label: p.name }))) ?? [];
  const visible = points.filter((p) =>
    geoContains(city, [p.longitude, p.latitude]),
  );
  const error = kind === "people" ? people.error : stores.error;
  const loading =
    kind === "people" ? people.data === undefined : stores.status === "loading";
  const truncated =
    kind === "people" ? people.data?.truncated : stores.truncated;
  const message = error
    ? "Pins could not be loaded. Return to Pins view to retry."
    : loading
      ? "Loading pins…"
      : `${visible.length} ${kind === "people" ? "fresh salesman locations" : "verified store pins"} in this city.${truncated ? " Only the first available pins are shown; this is not a complete count." : ""}`;
  useEffect(() => {
    onStatus(message);
  }, [message, onStatus]);
  return (
    <>
      {visible.map((p) => {
        const xy = project([p.longitude, p.latitude]);
        if (!xy || error) return null;
        return (
          <circle
            data-pin="true"
            key={`${p.longitude}:${p.latitude}:${p.label}`}
            cx={xy[0]}
            cy={xy[1]}
            r={5 / scale}
            vectorEffect="non-scaling-stroke"
            stroke="white"
            strokeWidth={1}
            fill={kind === "people" ? "#c26b26" : "#226da8"}
          >
            <title>{p.label}</title>
          </circle>
        );
      })}
    </>
  );
}

function subscribeWidth(notify: () => void) {
  const query = window.matchMedia("(max-width: 600px)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

export function AreasExplorer() {
  const reduced = useReducedMotion();
  const narrow = useSyncExternalStore(
    subscribeWidth,
    () => window.matchMedia("(max-width: 600px)").matches,
    () => false,
  );
  const [metric, setMetric] = useState<Metric>("sales");
  const [period, setPeriod] = useState("month");
  const [unit, setUnit] = useState("");
  const [history, setHistory] = useState<Level[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [hoverBin, setHoverBin] = useState<number | null>(null);
  const [pinKind, setPinKind] = useState("none");
  const [pinStatus, setPinStatus] = useState("");
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const tooltip = useRef<HTMLDivElement>(null);
  const mapElement = useRef<HTMLDivElement>(null);
  const hatchId = `area-empty-${useId().replaceAll(":", "")}`;
  const [viewport, setViewport] = useState({ width: 650, height: 740 });
  const pendingFocus = useRef<string | null>(null);
  const today = manilaToday();
  const dates = periodDates(period, today);
  const query = useApi<AreaData>(
    ["location", "areas", dates.from, dates.to, unit],
    ({ signal }) =>
      apiFetch("/api/v1/location/areas", {
        query: { ...dates, orgUnitId: unit || undefined },
        signal,
      }),
  );
  const live = useApi<LiveData>(["location", "live"], ({ signal }) =>
    apiFetch("/api/v1/location/live", { signal }),
  );
  const file = history.at(-1)?.file ?? "regions";
  const national = useApi<Shapes>(["map-boundaries", "regions"], ({ signal }) =>
    loadShapes("regions", signal),
  );
  const shapesQuery = useApi<Shapes>(["map-boundaries", file], ({ signal }) =>
    loadShapes(file, signal),
  );
  useLive(["location", "orders", "outlets"], [["location", "areas"]]);
  const data = query.error ? undefined : query.data;
  const shapes = shapesQuery.data;
  const mapReady = Boolean(
    data && national.data && !shapesQuery.error && !national.error,
  );
  useEffect(() => {
    if (!mapElement.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width),
        height = Math.round(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      setViewport((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(mapElement.current);
    return () => observer.disconnect();
  }, [mapReady]);
  const visibleFeatures = useMemo(
    () =>
      history.length === 3
        ? [history[2]!.shape]
        : (shapes?.features ??
          (history.at(-1)
            ? [history.at(-1)!.shape]
            : (national.data?.features ?? []))),
    [shapes, history, national.data],
  );
  const project = useMemo(
    () =>
      geoMercator().fitExtent(
        [
          [12, 12],
          [viewport.width - 12, viewport.height - 12],
        ],
        national.data ?? collection([]),
      ),
    [national.data, viewport],
  );
  const path = useMemo(() => geoPath(project), [project]);
  const rows = useMemo(
    () =>
      rankAreas(
        visibleFeatures.map((shape) => ({
          id: String(shape.id),
          name: shape.properties.name,
          shape,
          value: metricValue(data?.areas[String(shape.id)], metric),
        })),
      ),
    [visibleFeatures, data, metric],
  );
  useEffect(() => {
    if (
      !pendingFocus.current ||
      !rows.length ||
      (!shapes && history.length < 3)
    )
      return;
    const id = pendingFocus.current;
    pendingFocus.current = null;
    (rowRefs.current.get(id) ?? rowRefs.current.get(rows[0]!.id))?.focus();
  }, [rows, shapes, history.length]);
  const breaks = steps(rows.map((r) => r.value));
  const activeBin = hoverBin ?? pinned;
  const areaName = history.at(-1)?.shape.properties.name ?? "Philippines";
  const currentFacts = data?.areas[String(history.at(-1)?.shape.id ?? "all")];
  const total = metricValue(currentFacts, metric);
  const active = rows.find((r) => r.id === (hovered ?? focusId));
  const noun =
    history.length === 0
      ? "regions"
      : history.length === 1
        ? "provinces / districts"
        : history.length === 2
          ? "cities / municipalities"
          : "city";
  const camera = useMemo(
    () =>
      fitCamera(
        path.bounds(collection(visibleFeatures)),
        viewport.width,
        viewport.height,
      ),
    [visibleFeatures, path, viewport],
  );
  const labelKeepouts =
    history.length === 2
      ? rows
          .filter((r) => r.value !== null)
          .slice(0, 3)
          .map((r) => {
            const [[x0, y0], [x1, y1]] = path.bounds(r.shape);
            return {
              left: x0 * camera.scale + camera.x,
              top: y0 * camera.scale + camera.y,
              width: (x1 - x0) * camera.scale,
              height: (y1 - y0) * camera.scale,
            };
          })
      : [];
  const labels = history.length
    ? placeLabels(
        rows
          .filter((r) => r.value !== null)
          .slice(0, 3)
          .map((r) => {
            const [x, y] = path.centroid(r.shape);
            return {
              id: r.id,
              name: shortAreaName(r.name),
              value: r.value!,
              x: x * camera.scale + camera.x,
              y: y * camera.scale + camera.y,
            };
          })
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
        viewport.width,
        viewport.height,
        labelKeepouts,
      )
    : [];
  const ranges = legendRanges(
    rows.map((r) => r.value),
    metric,
  );
  function goToDepth(depth: number) {
    pendingFocus.current = String(history[depth]?.shape.id ?? "first");
    setHistory((h) => h.slice(0, depth));
    setHovered(null);
    setFocusId(null);
    setPinned(null);
    setHoverBin(null);
    setPinKind("none");
  }
  function open(shape: Shape, keyboard = false) {
    if (history.length >= 3) return;
    if (keyboard) pendingFocus.current = "first";
    const id = String(shape.id);
    setHistory([
      ...history,
      {
        shape,
        file:
          history.length === 0
            ? `r-${id}`
            : history.length === 1
              ? `p-${id}`
              : file,
      },
    ]);
    setHovered(null);
    setFocusId(null);
    setPinned(null);
    setPinKind("none");
  }
  function back() {
    setHistory((h) => h.slice(0, -1));
    setHovered(null);
    setFocusId(null);
    setPinned(null);
    setPinKind("none");
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const action = escapeAction(pinned, history.length);
      if (action === "unpin") {
        setPinned(null);
        setHoverBin(null);
      } else if (action === "back") {
        pendingFocus.current = String(history.at(-1)?.shape.id ?? "first");
        setHistory((h) => h.slice(0, -1));
        setHovered(null);
        setFocusId(null);
        setPinKind("none");
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [pinned, history]);
  function highlight(id: string) {
    setHovered(id);
    const row = rowRefs.current.get(id),
      list = row?.closest(".area-ranking");
    if (row && list) {
      const y = rows.findIndex((r) => r.id === id) * 48;
      if (y < list.scrollTop || y + 48 > list.scrollTop + list.clientHeight)
        list.scrollTop = y;
    }
  }
  const issue = query.error ?? shapesQuery.error ?? national.error;
  return (
    <Card label="Philippine areas" flush className="area-card">
      <section
        className="areas-explorer"
        aria-label="Philippine areas explorer"
      >
        <header className="area-header">
          <div>
            <h2>Explore your areas</h2>
            <p>
              {dates.from} – {dates.to} · Manila time
            </p>
          </div>
          <div className="area-filters">
            <label>
              Period
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              >
                <option value="month">Month to date</option>
                <option value="week">Last 7 days</option>
                <option value="today">Today</option>
              </select>
            </label>
            <label>
              Branch / unit
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="">All my areas</option>
                {live.data?.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        <div className="area-overview">
          <div className="area-summary" data-area-name={areaName}>
            <nav className="area-breadcrumb" aria-label="Area path">
              <ol>
                <li>
                  {history.length ? (
                    <button onClick={() => goToDepth(0)}>Philippines</button>
                  ) : (
                    <span aria-current="location">Philippines</span>
                  )}
                </li>
                {history.map((level, index) => (
                  <li key={String(level.shape.id)}>
                    {index === history.length - 1 ? (
                      <span
                        aria-current="location"
                        title={level.shape.properties.name}
                      >
                        {shortAreaName(level.shape.properties.name)}
                      </span>
                    ) : (
                      <button
                        title={level.shape.properties.name}
                        onClick={() => goToDepth(index + 1)}
                      >
                        {shortAreaName(level.shape.properties.name)}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
            <div className="area-headline">
              <CountingTotal value={total} metric={metric} />
              <span>
                {metric === "sales"
                  ? "Booked sales"
                  : metric === "visits"
                    ? `done / ${currentFacts?.planned ?? 0} planned`
                    : METRICS.find((m) => m.id === metric)?.label}
              </span>
            </div>
          </div>
          <div
            className="area-metrics"
            role="group"
            aria-label="Shade areas by"
          >
            {METRICS.map((m) => (
              <button
                key={m.id}
                aria-pressed={metric === m.id}
                onClick={() => {
                  setMetric(m.id);
                  setPinned(null);
                  setHoverBin(null);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          {history.length > 0 && (
            <button className="area-back" onClick={back}>
              ← Back <span>Esc</span>
            </button>
          )}
        </div>
        {issue ? (
          <p role="alert">
            {issue.message}{" "}
            <button
              onClick={() => {
                void query.refetch();
                void shapesQuery.refetch();
                void national.refetch();
              }}
            >
              Try again
            </button>
          </p>
        ) : !data || !national.data ? (
          <p role="status">Loading areas…</p>
        ) : (
          <>
            <div className="area-grid">
              <div className="area-map-column">
                <div
                  ref={mapElement}
                  className="area-map"
                  onPointerMove={(e) => {
                    if (tooltip.current) {
                      const rect = e.currentTarget.getBoundingClientRect();
                      tooltip.current.style.left = `${Math.max(8, Math.min(rect.width - tooltip.current.offsetWidth - 8, e.clientX - rect.left + 14))}px`;
                      tooltip.current.style.top = `${Math.max(8, Math.min(rect.height - tooltip.current.offsetHeight - 8, e.clientY - rect.top + 12))}px`;
                    }
                  }}
                  onPointerLeave={() => setHovered(null)}
                >
                  <svg
                    viewBox={`0 0 ${viewport.width} ${viewport.height}`}
                    role="img"
                    aria-label={`${areaName}, shaded by ${METRICS.find((m) => m.id === metric)?.label}. Use the ranked list to explore.`}
                  >
                    <defs>
                      <pattern
                        id={hatchId}
                        width="7"
                        height="7"
                        patternUnits="userSpaceOnUse"
                        patternTransform={`scale(${1 / camera.scale})`}
                      >
                        <rect width="7" height="7" fill={NO_DATA} />
                        <path
                          d="M-1 1L1-1M0 7L7 0M6 8L8 6"
                          stroke="var(--area-empty-line)"
                          strokeWidth="0.8"
                        />
                      </pattern>
                    </defs>
                    <motion.g
                      style={{
                        originX: 0,
                        originY: 0,
                        transformBox: "view-box",
                      }}
                      animate={camera}
                      transition={
                        reduced
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 150, damping: 28 }
                      }
                    >
                      {national.data?.features.map((s) => (
                        <path
                          key={String(s.id)}
                          d={path(s) ?? ""}
                          fill="var(--area-context)"
                          stroke="white"
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                      {rows.map((r) => {
                        const b = bin(r.value, breaks);
                        const selected = r.id === (hovered ?? focusId);
                        const centroid = path.centroid(r.shape);
                        return (
                          <path
                            key={r.id}
                            data-area={r.id}
                            d={path(r.shape) ?? ""}
                            fill={
                              b < 0
                                ? `url(#${hatchId})`
                                : COLORS[breaks.length ? b : 4]
                            }
                            fillOpacity={
                              activeBin === null || activeBin === b ? 1 : 0.18
                            }
                            stroke={selected ? "#172b3a" : "white"}
                            strokeWidth={selected ? 2 : 1}
                            vectorEffect="non-scaling-stroke"
                            style={{
                              transitionDelay: reduced
                                ? "0ms"
                                : `${Math.max(0, Math.min(420, (centroid[0] / viewport.width) * 420))}ms`,
                            }}
                            onPointerEnter={(event) => {
                              if (event.pointerType === "mouse")
                                highlight(r.id);
                            }}
                            onClick={(event) =>
                              open(r.shape, event.detail === 0)
                            }
                          >
                            <title>
                              {r.name}: {formatMetric(r.value, metric)}
                            </title>
                          </path>
                        );
                      })}
                      {active && (
                        <path
                          d={path(active.shape) ?? ""}
                          fill="none"
                          stroke="#172b3a"
                          strokeWidth={2}
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="none"
                        />
                      )}
                      {history.length === 3 && pinKind !== "none" && (
                        <CityPins
                          city={history[2]!.shape}
                          kind={pinKind}
                          project={project}
                          unit={unit}
                          scale={camera.scale}
                          onStatus={setPinStatus}
                        />
                      )}
                    </motion.g>
                    <g
                      className="area-map-labels"
                      pointerEvents="none"
                      aria-hidden="true"
                    >
                      {labels.map((label) => (
                        <motion.g
                          key={`${file}:${label.id}`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{
                            duration: reduced ? 0 : 0.18,
                            delay: reduced ? 0 : 0.25,
                          }}
                        >
                          <line
                            x1={label.x}
                            y1={label.y}
                            x2={Math.max(
                              label.left + 8,
                              Math.min(label.left + label.width - 8, label.x),
                            )}
                            y2={label.top + 21}
                          />
                          <circle cx={label.x} cy={label.y} r="3" />
                          <rect
                            x={label.left}
                            y={label.top}
                            width={label.width}
                            height={label.height}
                            rx="6"
                          />
                          <text x={label.left + 10} y={label.top + 17}>
                            <tspan className="area-label-name">
                              {label.name.length > 24
                                ? `${label.name.slice(0, 23)}…`
                                : label.name}
                            </tspan>
                            <tspan
                              className="area-label-value"
                              x={label.left + 10}
                              dy="16"
                            >
                              {compactMetric(label.value, metric)}
                            </tspan>
                          </text>
                        </motion.g>
                      ))}
                    </g>
                  </svg>
                  {active && (
                    <div
                      ref={tooltip}
                      className={`area-tooltip ${hovered ? "" : "area-tooltip-keyboard"}`}
                      role="tooltip"
                    >
                      <div className="area-tooltip-title">
                        <strong>{active.name}</strong>
                        <span>
                          {active.rank
                            ? `${ordinal(active.rank)} of ${rows.filter((r) => r.value !== null).length}`
                            : "No data"}
                        </span>
                      </div>
                      {METRICS.map((m) => (
                        <div
                          key={m.id}
                          className={m.id === metric ? "chosen" : ""}
                        >
                          <span>{m.label}</span>
                          <span>
                            {m.id === "visits" &&
                            metricValue(data.areas[active.id], "visits") !==
                              null
                              ? `${data.areas[active.id]?.done ?? 0} / ${data.areas[active.id]?.planned ?? 0}`
                              : formatMetric(
                                  metricValue(data.areas[active.id], m.id),
                                  m.id,
                                )}
                          </span>
                        </div>
                      ))}
                      <p>
                        {history.length < 3
                          ? "Select to zoom in"
                          : "Use the pin controls to see stores or salesmen"}
                      </p>
                    </div>
                  )}
                </div>
                <div
                  className="area-legend"
                  role="group"
                  aria-label="Colour steps"
                  data-single={ranges.length === 1}
                >
                  {ranges.map((range, i) => {
                    const count = rows.filter(
                      (r) => bin(r.value, breaks) === i,
                    ).length;
                    return (
                      <button
                        key={i}
                        data-count={count}
                        title={`${count} areas · ${range.description}`}
                        aria-label={`${range.description}: ${count} areas`}
                        aria-pressed={pinned === i}
                        onPointerEnter={() => setHoverBin(i)}
                        onPointerLeave={() => setHoverBin(null)}
                        onFocus={() => setHoverBin(i)}
                        onBlur={() => setHoverBin(null)}
                        onClick={() => setPinned(pinned === i ? null : i)}
                      >
                        <span style={{ background: range.color }} />
                        {range.label}
                      </button>
                    );
                  })}
                  <button
                    className="area-no-data"
                    aria-pressed={pinned === -1}
                    onPointerEnter={() => setHoverBin(-1)}
                    onPointerLeave={() => setHoverBin(null)}
                    onClick={() => setPinned(pinned === -1 ? null : -1)}
                  >
                    <span className="area-empty-swatch" />
                    No data
                  </button>
                </div>
                <p className="area-caption">
                  Shaded by{" "}
                  {METRICS.find((m) => m.id === metric)?.label.toLowerCase()}.{" "}
                  {pinned !== null
                    ? "Range pinned · select again or press Escape to clear."
                    : narrow
                      ? "Tap a range to keep its areas lit."
                      : "Hover a range to compare; select to keep it lit."}
                </p>
                {history.length === 3 && (
                  <div
                    className="area-pin-controls"
                    role="group"
                    aria-label="City pins"
                  >
                    {[
                      ["none", "Hide pins"],
                      ["people", "Show salesmen"],
                      ["stores", "Show stores"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        aria-pressed={pinKind === value}
                        onClick={() => setPinKind(value!)}
                      >
                        {label}
                      </button>
                    ))}
                    {pinKind !== "none" && <p role="status">{pinStatus}</p>}
                    <p>
                      Only verified store pins and fresh, shared salesman
                      locations are shown. Missing pins do not mean no
                      customers.
                    </p>
                  </div>
                )}
              </div>
              <aside className="area-list-column">
                <div className="area-list-title">
                  <strong>
                    {rows.length} {noun}
                  </strong>
                  <span>
                    Ranked by{" "}
                    {METRICS.find((m) => m.id === metric)?.label.toLowerCase()}
                  </span>
                </div>
                <div className="area-ranking" aria-label="Ranked areas">
                  <div
                    style={{ height: rows.length * 48, position: "relative" }}
                  >
                    {rows.map((r, i) => (
                      <motion.button
                        key={r.id}
                        ref={(el) => {
                          if (el) rowRefs.current.set(r.id, el);
                          else rowRefs.current.delete(r.id);
                        }}
                        className={`area-rank-row ${r.id === (hovered ?? focusId) ? "is-active" : ""}`}
                        style={
                          {
                            "--rank-bar": `${Math.max(0, ((r.value ?? 0) / Math.max(1, ...rows.map((r) => r.value ?? 0))) * 100)}%`,
                          } as CSSProperties
                        }
                        animate={{ y: i * 48 }}
                        transition={
                          reduced
                            ? { duration: 0 }
                            : { type: "spring", stiffness: 190, damping: 28 }
                        }
                        tabIndex={(focusId ?? rows[0]?.id) === r.id ? 0 : -1}
                        title={r.name}
                        aria-label={`${r.rank ? ordinal(r.rank) : "Unranked"}, ${r.name}, ${formatMetric(r.value, metric)}. ${history.length < 3 ? "Select to zoom in" : "City selected"}`}
                        onFocus={() => setFocusId(r.id)}
                        onBlur={() => setFocusId(null)}
                        onPointerEnter={(event) => {
                          if (event.pointerType === "mouse") setHovered(r.id);
                        }}
                        onPointerLeave={() => setHovered(null)}
                        onClick={(event) => open(r.shape, event.detail === 0)}
                        onKeyDown={(e) => {
                          if (
                            ["ArrowDown", "ArrowUp", "Home", "End"].includes(
                              e.key,
                            )
                          ) {
                            e.preventDefault();
                            const next = rows[listIndex(e.key, i, rows.length)];
                            if (next) rowRefs.current.get(next.id)?.focus();
                          }
                        }}
                      >
                        <span className="area-rank">{r.rank ?? "—"}</span>
                        <span className="area-rank-name">
                          <span className="area-rank-text">{r.name}</span>
                          <span className="area-rank-track" aria-hidden="true">
                            <span />
                          </span>
                        </span>
                        <span className="area-rank-value">
                          {formatMetric(r.value, metric)}
                        </span>
                      </motion.button>
                    ))}
                  </div>
                </div>
              </aside>
            </div>
            <p className="area-help">
              {narrow
                ? "Tap an area on the map or in the list to explore its parts. Use Back to return."
                : "Select an area to explore its parts. In the list: ↑ ↓ to move, Enter to zoom, Escape to go back."}
            </p>
            {data.unlocated && (
              <p className="area-notice">
                {history.length > 0 && <strong>Nationwide: </strong>}
                Customers without a recognized region:{" "}
                {data.unlocated.customers}. Completed visits:{" "}
                {data.unlocated.done}. Booked sales:{" "}
                {formatMetric(data.unlocated.sales, "sales")}. Included in the
                national total, not assigned to a guessed area.
              </p>
            )}
            {currentFacts?.unknownSales ? (
              <p className="area-notice">
                {currentFacts.unknownSales} orders have an unknown amount. Sales
                are not presented as a complete total.
              </p>
            ) : null}
            <details className="area-definitions">
              <summary>About these numbers and boundaries</summary>
              <p>{data.definition}</p>
              <p>
                Some older customer codes or new administrative areas may lack
                matching shapes. Parent totals include them; a blank area means
                no authorized source facts, not a surveyed absence.
              </p>
              <p>
                Boundaries: NAMRIA / PSA through OCHA COD-AB, CC BY-IGO 3.0 ·
                PSGC 3Q 2026 · faeldon/philippines-json-maps (MIT). Simplified
                for exploration, not legal boundaries.
              </p>
              <a href="/maps/ph/LICENSE.txt">Map attribution and license</a>
            </details>
            <p role="status" aria-live="polite" className="sr-only">
              {areaName}. {rows.length} {noun}, ranked by{" "}
              {METRICS.find((m) => m.id === metric)?.label}.{" "}
              {rows[0]?.value !== null
                ? `${rows[0]?.name ?? ""} ranks first.`
                : ""}{" "}
              {history.length ? "Press Escape to go back." : ""}
            </p>
          </>
        )}
      </section>
    </Card>
  );
}
