"use client";

import { apiFetch, useApi, useApiPages, useLive } from "../../lib/api";
import {
  Card,
  FormField,
  IconTile,
  ListRow,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  countByStatus,
  filterPositions,
  formatTime,
  lastSeen,
  manilaToday,
  mapProvider,
  positionMeta,
  STATUS_ORDER,
  STATUS_STYLE,
  type LatLng,
  type LiveData,
  type LiveFilters,
  type LivePosition,
  type StorePin,
  type Trail,
} from "./live-map-model";

const LiveMapCanvas = dynamic(
  () => import("./live-map-canvas").then((m) => m.LiveMapCanvas),
  { ssr: false },
);

/** Read with literal names so Next inlines them into the client bundle. */
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
const GOOGLE_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "";
const MAX_STORE_PINS = 2_000;

/** The viewer's clock, refreshed every 30 s so statuses age without a new ping. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Distance along a trail in km (great-circle between consecutive pings). */
export function trailKm(trail: Trail) {
  let meters = 0;
  const rad = Math.PI / 180;
  for (let i = 1; i < trail.pings.length; i++) {
    const a = trail.pings[i - 1]!,
      b = trail.pings[i]!;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLng = (b.longitude - a.longitude) * rad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.latitude * rad) *
        Math.cos(b.latitude * rad) *
        Math.sin(dLng / 2) ** 2;
    meters += 2 * 6_371_000 * Math.asin(Math.sqrt(h));
  }
  return Math.round(meters / 100) / 10;
}

function Select({
  label,
  value,
  onChange,
  children,
  width = "w-[180px]",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  width?: string;
}) {
  return (
    <div className={`${width} max-w-full`}>
      <FormField label={label}>
        <select
          aria-label={label}
          className="h-10 w-full"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {children}
        </select>
      </FormField>
    </div>
  );
}

export type LiveMapViewProps = {
  data: LiveData;
  now: number;
  filters: LiveFilters;
  onFilters: (filters: LiveFilters) => void;
  orgUnitId: string;
  onUnit: (id: string) => void;
  teamId: string;
  onTeam: (id: string) => void;
  selectedProfileId: string | null;
  onSelect: (profileId: string | null) => void;
  trail: Trail | null | undefined;
  trailDate: string;
  onTrailDate: (date: string) => void;
  /** The map itself (client-only), injected so the view renders in SSR tests. */
  map: ReactNode;
};

/** Everything around the map: filters, status counts, the side list and the trail. */
export function LiveMapView(props: LiveMapViewProps) {
  const { data, now, filters, onFilters } = props;
  const shown = filterPositions(data.positions, filters);
  const counts = countByStatus(data.positions);
  const selected = props.selectedProfileId
    ? (data.positions.find((p) => p.profileId === props.selectedProfileId) ??
      null)
    : null;
  const sample = data.positions.some((p) => p.sample);
  return (
    <div className="grid gap-4">
      <DaySummary data={data} now={now} onSelect={props.onSelect} />
      <Card
        label="Live map"
        count={shown.length}
        icon={<WorkspaceIcon name="field" />}
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap items-end gap-3">
            {data.units.length > 1 ? (
              <Select
                label="Area"
                value={props.orgUnitId}
                onChange={props.onUnit}
                width="w-[200px]"
              >
                <option value="">Everyone in scope</option>
                {data.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </Select>
            ) : null}
            {data.teams.length ? (
              <Select label="Team" value={props.teamId} onChange={props.onTeam}>
                <option value="">All teams</option>
                {data.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            ) : null}
            <Select
              label="Show"
              value={filters.kind}
              onChange={(kind) =>
                onFilters({ ...filters, kind: kind as LiveFilters["kind"] })
              }
              width="w-[190px]"
            >
              <option value="">Agents and trucks</option>
              <option value="field">Agents</option>
              <option value="van">Trucks</option>
            </Select>
            <Select
              label="Status"
              value={filters.status}
              onChange={(status) =>
                onFilters({
                  ...filters,
                  status: status as LiveFilters["status"],
                })
              }
              width="w-[150px]"
            >
              <option value="">Any status</option>
              {STATUS_ORDER.map((status) => (
                <option key={status} value={status}>
                  {STATUS_STYLE[status].label} ({counts[status]})
                </option>
              ))}
            </Select>
            <label className="flex h-10 items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={filters.idleOnly ?? false}
                onChange={(e) =>
                  onFilters({ ...filters, idleOnly: e.target.checked })
                }
              />
              Needs a check-in
            </label>
            <div className="w-[200px] max-w-full">
              <FormField label="Search">
                <input
                  aria-label="Search"
                  className="h-10 w-full"
                  placeholder="Name or plate"
                  value={filters.search}
                  onChange={(event) =>
                    onFilters({ ...filters, search: event.target.value })
                  }
                />
              </FormField>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 text-[12px] text-muted">
            {STATUS_ORDER.map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-full"
                  style={{ background: STATUS_STYLE[status].color }}
                />
                {STATUS_STYLE[status].label} {counts[status]}
              </span>
            ))}
            <span>● agent · ■ truck · □ store</span>
          </div>
          {props.map}
          {sample ? (
            <p className="text-[13px] text-muted">
              Includes sample positions (beta test data, not real phones).
            </p>
          ) : null}
          {data.truncated ? (
            <p className="text-[13px] text-muted">
              Showing the latest {data.positions.length}. Pick an area to see
              the rest.
            </p>
          ) : null}
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card
          label="People and trucks"
          count={shown.length}
          icon={<WorkspaceIcon name="list" />}
        >
          {shown.length === 0 ? (
            <p className="text-[13px] text-muted">
              {data.positions.length
                ? "Nobody matches these filters."
                : "No one is sharing their location. Tracking runs only during work: from the first check-in or Start day until End day (10 PM at the latest), and while a truck's trip is active."}
            </p>
          ) : (
            <div className="divide-y divide-separator rounded-xl border border-border">
              {shown.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={p.profileId === props.selectedProfileId}
                  className={`block w-full text-left ${p.profileId === props.selectedProfileId ? "bg-default-soft" : ""}`}
                  onClick={() =>
                    props.onSelect(
                      p.profileId === props.selectedProfileId
                        ? null
                        : p.profileId,
                    )
                  }
                >
                  <ListRow
                    icon={
                      <WorkspaceIcon
                        name={p.kind === "van" ? "inventory" : "field"}
                      />
                    }
                    tone={STATUS_STYLE[p.status].tone}
                    title={p.kind === "van" ? `${p.name} · truck` : p.name}
                    meta={positionMeta(p, now)}
                    value={lastSeen(now, p.recordedAt)}
                    action={
                      <StatusPill tone={STATUS_STYLE[p.status].tone}>
                        {STATUS_STYLE[p.status].label}
                      </StatusPill>
                    }
                  />
                </button>
              ))}
            </div>
          )}
        </Card>
        <TrailPanel
          person={selected}
          trail={props.trail}
          date={props.trailDate}
          onDate={props.onTrailDate}
          selectedProfileId={props.selectedProfileId}
        />
      </div>
    </div>
  );
}

function DaySummary({
  data,
  now,
  onSelect,
}: {
  data: LiveData;
  now: number;
  onSelect: (id: string | null) => void;
}) {
  const today = data.trend?.at(-1);
  const flagged = data.positions.filter((p) => p.idleFlag);
  const prior = data.prior;
  const trend = data.trend ?? [];
  const max = Math.max(1, ...trend.map((p) => Math.max(p.visited, p.planned)));
  return (
    <Card label="Who needs a check-in?" icon={<WorkspaceIcon name="field" />}>
      <div className="grid gap-3">
        <p className="text-[13px] text-muted">
          {today
            ? `People in scope: ${today.visited} visits against ${today.planned} planned stops · ${today.productive} productive`
            : "Day totals unavailable"}
          {prior
            ? ` · ${prior.visited} visits on the prior day`
            : " · Prior day unavailable"}
        </p>
        {flagged.length ? (
          <div className="flex flex-wrap gap-2">
            {flagged.map((p) => (
              <button
                key={p.id}
                type="button"
                className="rounded-lg border border-border px-3 py-2 text-left text-[13px]"
                onClick={() => onSelect(p.profileId)}
              >
                {p.name} · no movement or visit for 45+ min · Open day
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted">
            No idle flags among the visible positions. Phones that have not
            synced may still have work waiting.
          </p>
        )}
        <p className="text-[12px] text-muted">
          Idle is a provisional 45-minute prompt to check in, not a finding
          about performance. Updated {lastSeen(now, data.now)}.
        </p>
        {trend.length ? (
          <div>
            <p className="text-[12px] text-muted">
              Last seven days · visited (solid) against planned (outline)
            </p>
            <svg
              role="img"
              aria-label="Seven-day planned and visited trend"
              viewBox="0 0 280 64"
              className="h-16 w-full max-w-[420px]"
            >
              {trend.map((p, index) => (
                <g key={p.date}>
                  <title>
                    {p.date}: {p.visited} visited, {p.planned} planned
                  </title>
                  <rect
                    x={index * 40 + 4}
                    y={60 - (p.planned / max) * 52}
                    width="24"
                    height={(p.planned / max) * 52}
                    fill="none"
                    stroke="currentColor"
                    opacity="0.35"
                  />
                  <rect
                    x={index * 40 + 7}
                    y={60 - (p.visited / max) * 52}
                    width="18"
                    height={(p.visited / max) * 52}
                    fill="currentColor"
                  />
                </g>
              ))}
            </svg>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function TrailPanel({
  person,
  trail,
  date,
  onDate,
  selectedProfileId,
}: {
  person: LivePosition | null;
  trail: Trail | null | undefined;
  date: string;
  onDate: (date: string) => void;
  selectedProfileId: string | null;
}) {
  return (
    <Card label="Day trail" icon={<WorkspaceIcon name="queue" />}>
      {!selectedProfileId ? (
        <p className="text-[13px] text-muted">
          Pick a person or truck to see their day: the route travelled, store
          visits and times.
        </p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-[170px]">
              <FormField label="Day">
                <input
                  aria-label="Day"
                  type="date"
                  className="h-10 w-full"
                  value={date}
                  max={manilaToday()}
                  onChange={(event) => onDate(event.target.value)}
                />
              </FormField>
            </div>
            <span className="pb-2 text-[13px] text-muted">
              {trail?.name ?? person?.name ?? ""}
            </span>
          </div>
          {trail === undefined ? (
            <span className="text-[13px] text-muted">Loading trail…</span>
          ) : trail === null ? null : trail.pings.length === 0 &&
            trail.stops.length === 0 &&
            !trail.plannedStops?.length ? (
            <p className="text-[13px] text-muted">
              No location shared on this day.
            </p>
          ) : (
            <>
              <p className="text-[13px] text-muted">
                {trail.pings.length} positions ·{" "}
                {trail.pings.length < 2
                  ? "distance unavailable"
                  : `${trail.distanceKm ?? trailKm(trail)} km recorded`}{" "}
                · {formatTime(trail.pings[0]?.recordedAt)}–
                {formatTime(trail.pings.at(-1)?.recordedAt)}
                {trail.pings.some((p) => p.mockLocation)
                  ? " · mock location seen"
                  : ""}
                {trail.truncated ? " · partial day data" : ""}
              </p>
              {trail.plannedStops?.length ? (
                <div className="grid gap-1 text-[13px]">
                  <p className="font-medium">Signed route order</p>
                  {trail.plannedStops.map((stop) => (
                    <p key={stop.plannedVisitId}>
                      {stop.sequence}. {stop.name} ·{" "}
                      {stop.visited ? "Visited" : "Not yet visited"}
                    </p>
                  ))}
                </div>
              ) : null}
              {trail.stops.length ? (
                <div className="divide-y divide-separator rounded-xl border border-border">
                  {trail.stops.map((stop, index) => (
                    <ListRow
                      key={stop.visitId}
                      icon={<IconTile icon={<span>{index + 1}</span>} />}
                      title={stop.outletName}
                      meta={[
                        stop.outletCode,
                        stop.onPlan === false ? "Off plan" : "Planned stop",
                        stop.productive ? "Productive" : null,
                        stop.pinned ? null : "No store pin",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      value={
                        <span className="font-mono text-[13px] tabular-nums">
                          {formatTime(stop.checkedInAt)}–
                          {formatTime(stop.checkedOutAt)}
                        </span>
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-muted">No store visits.</p>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/** Field → Live map. Server-scoped Bun reads plus coalesced invalidation. */
export function LiveMapWorkspace() {
  const now = useNow();
  const [filters, setFilters] = useState<LiveFilters>({
    kind: "",
    status: "",
    search: "",
  });
  const [orgUnitId, setOrgUnitId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [selectedProfileId, setSelected] = useState<string | null>(null);
  const [trailDate, setTrailDate] = useState(() => manilaToday());
  const liveQuery = useApi<LiveData>(
    ["location", "live", orgUnitId, teamId, manilaToday(now)],
    ({ signal }) =>
      apiFetch("/api/v1/location/live", {
        query: {
          orgUnitId: orgUnitId || undefined,
          teamId: teamId || undefined,
        },
        signal,
      }),
  );
  const data = liveQuery.error ? undefined : liveQuery.data;
  const pins = useApiPages<StorePin>(
    ["location", "store-pins"],
    (cursor, { signal }) =>
      apiFetch("/api/v1/location/store-pins", {
        query: { cursor: cursor || undefined },
        signal,
      }),
    { all: true, maxPages: MAX_STORE_PINS / 100 },
  );
  const trailQuery = useApi<Trail>(
    selectedProfileId
      ? ["location", "trail", selectedProfileId, trailDate]
      : null,
    ({ signal }) =>
      apiFetch("/api/v1/location/trail", {
        query: { profileId: selectedProfileId, date: trailDate },
        signal,
      }),
  );
  const trail = trailQuery.error ? null : trailQuery.data;
  useLive(["location"], [["location"]]);
  // Age/freshness and idle flags must advance even with silent phones.
  const refresh = liveQuery.refetch;
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const positions = useMemo(
    () => (data ? filterPositions(data.positions, filters) : []),
    [data, filters],
  );
  const selectedId =
    positions.find((p) => p.profileId === selectedProfileId)?.id ?? null;
  const layers = useMemo(
    () => ({
      positions,
      stores: pins.error ? [] : (pins.items ?? []),
      trail: selectedProfileId ? (trail ?? null) : null,
      selectedId,
    }),
    [positions, pins.items, pins.error, trail, selectedProfileId, selectedId],
  );
  // Auto-fit: on the first positions, on a filter change, and on a newly loaded trail.
  const trailPoints: LatLng[] = trail?.pings.length ? trail.pings : [];
  const fitPoints: LatLng[] = trailPoints.length ? trailPoints : positions;
  const fitKey = trailPoints.length
    ? `trail:${selectedProfileId}:${trailDate}:${trail ? "1" : "0"}`
    : `live:${orgUnitId}:${teamId}:${filters.kind}:${filters.status}:${positions.length > 0}`;
  if (liveQuery.error)
    return (
      <p role="alert" className="text-[13px] text-muted">
        Live locations could not be loaded. {liveQuery.error.message}
      </p>
    );
  if (data === undefined)
    return <span className="text-[13px] text-muted">Loading live map…</span>;
  const provider = mapProvider(GOOGLE_KEY);
  return (
    <div className="grid gap-3">
      {trailQuery.error ? (
        <p role="alert">
          This day could not be loaded. {trailQuery.error.message}
        </p>
      ) : null}
      {pins.error ? (
        <p role="status">
          Store pins unavailable. People and day trails remain available.
        </p>
      ) : null}
      {pins.truncated ? (
        <p role="status">First 2,000 store pins only.</p>
      ) : null}
      <LiveMapView
        data={data}
        now={now}
        filters={filters}
        onFilters={setFilters}
        orgUnitId={orgUnitId}
        onUnit={setOrgUnitId}
        teamId={teamId}
        onTeam={setTeamId}
        selectedProfileId={selectedProfileId}
        onSelect={(id) => {
          setSelected(id);
          setTrailDate(manilaToday());
        }}
        trail={selectedProfileId ? trail : null}
        trailDate={trailDate}
        onTrailDate={setTrailDate}
        map={
          <LiveMapCanvas
            provider={provider}
            googleKey={GOOGLE_KEY}
            googleMapId={GOOGLE_MAP_ID}
            layers={layers}
            fitPoints={fitPoints}
            fitKey={fitKey}
            onSelect={(p) => {
              setSelected(p.profileId);
              setTrailDate(manilaToday());
            }}
          />
        }
      />
    </div>
  );
}
