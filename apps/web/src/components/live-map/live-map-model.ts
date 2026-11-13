/** Bun API DTOs. IDs are opaque strings; no generated backend types. */
export type LiveStatus = "moving" | "idle" | "at-store" | "stale" | "offline";
export type LivePosition = {
  id: string;
  kind: "field" | "van";
  profileId: string;
  name: string;
  vehicleId: string | null;
  vehicleLabel: string | null;
  tripNumber: string | null;
  orgUnitId: string;
  unitName: string;
  teamId: string | null;
  teamName: string | null;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  batteryPercent: number | null;
  mockLocation: boolean;
  recordedAt: number;
  receivedAt: number;
  serviceDate: string;
  status: LiveStatus;
  visitOutletName: string | null;
  sample: boolean;
  planned: number;
  visited: number;
  productive: number;
  idleFlag: boolean;
  lastSeenAt: number;
  lastMovedAt: number | null;
  lastActivityAt: number | null;
  freshness: "fresh" | "stale" | "offline" | "ended";
  /** SP-0175: the day status Today and the agent day show (older servers omit it). */
  fieldStatus?:
    | "no_plan"
    | "not_started"
    | "in_call"
    | "working"
    | "idle"
    | "done";
  fieldLastSeenAt?: number | null;
};

/** SP-0175: the same words Today's "Field right now" uses. */
export const FIELD_STATUS_LABEL: Record<
  NonNullable<LivePosition["fieldStatus"]>,
  string
> = {
  no_plan: "No plan",
  not_started: "Not started",
  in_call: "In a call",
  working: "Working",
  idle: "Idle",
  done: "Done",
};
export type DayCount = {
  date: string;
  planned: number;
  visited: number;
  productive: number;
};
export type LiveData = {
  now: number;
  truncated: boolean;
  selfOnly: boolean;
  positions: LivePosition[];
  units: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  trend?: DayCount[];
  prior?: DayCount;
  idleThresholdMinutes?: number;
  provisional?: boolean;
};
export type Trail = {
  profileId: string;
  name: string;
  serviceDate: string;
  truncated: boolean;
  distanceKm: number | null;
  distanceBasis: string;
  pings: {
    kind: "field" | "van";
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    speedMetersPerSecond: number | null;
    batteryPercent: number | null;
    mockLocation: boolean;
    trigger: string;
    recordedAt: number;
  }[];
  stops: {
    visitId: string;
    outletCode: string;
    outletName: string;
    state: string;
    checkedInAt: number | null;
    checkedOutAt: number | null;
    latitude: number | null;
    longitude: number | null;
    pinned: boolean;
    onPlan: boolean;
    productive: boolean;
  }[];
  plannedStops?: {
    plannedVisitId: string;
    outletId: string;
    name: string;
    sequence: number;
    visited: boolean;
  }[];
};
export type StorePin = {
  outletId: string;
  code: string;
  name: string;
  latitude: number;
  longitude: number;
};

export type LiveFilters = {
  kind: "" | "field" | "van";
  status: "" | LiveStatus;
  search: string;
  idleOnly?: boolean;
};

const MANILA_OFFSET_MS = 8 * 3_600_000;

export function manilaToday(now = Date.now()) {
  return new Date(now + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Status colours: green moving, blue idle, amber stale, grey offline. */
export const STATUS_STYLE: Record<
  LiveStatus,
  { label: string; color: string; tone: "success" | "warning" | "neutral" }
> = {
  moving: { label: "Moving", color: "#15803d", tone: "success" },
  idle: { label: "Stationary", color: "#2563eb", tone: "neutral" },
  "at-store": { label: "At store", color: "#374151", tone: "success" },
  stale: { label: "Stale", color: "#d97706", tone: "warning" },
  offline: { label: "Offline", color: "#6b7280", tone: "neutral" },
};

export const STATUS_ORDER: LiveStatus[] = [
  "moving",
  "idle",
  "at-store",
  "stale",
  "offline",
];

export function filterPositions(
  positions: readonly LivePosition[],
  filters: LiveFilters,
) {
  const needle = filters.search.trim().toLowerCase();
  return positions.filter(
    (p) =>
      (!filters.idleOnly || p.idleFlag) &&
      (!filters.kind || p.kind === filters.kind) &&
      (!filters.status || p.status === filters.status) &&
      (!needle ||
        p.name.toLowerCase().includes(needle) ||
        (p.vehicleLabel ?? "").toLowerCase().includes(needle)),
  );
}

export function countByStatus(positions: readonly LivePosition[]) {
  const counts: Record<LiveStatus, number> = {
    moving: 0,
    idle: 0,
    "at-store": 0,
    stale: 0,
    offline: 0,
  };
  for (const p of positions) counts[p.status] += 1;
  return counts;
}

/** "just now", "4 min ago", "2 h ago", "yesterday 17:05". */
export function lastSeen(now: number, at: number) {
  const age = Math.max(0, now - at);
  if (age < 60_000) return "just now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} min ago`;
  if (manilaToday(now) === manilaToday(at))
    return `${Math.floor(age / 3_600_000)} h ago`;
  return `yesterday ${formatTime(at)}`;
}

export function formatTime(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

/** Short facts for the list and the marker popup. */
export function positionMeta(p: LivePosition, now = Date.now()) {
  return [
    p.kind === "van" ? (p.vehicleLabel ?? "Truck") : "Field",
    p.tripNumber,
    p.teamName ?? p.unitName,
    p.speedMetersPerSecond !== null && p.speedMetersPerSecond >= 1
      ? `${Math.round(p.speedMetersPerSecond * 3.6)} km/h`
      : null,
    p.batteryPercent !== null ? `${p.batteryPercent}% battery` : null,
    `±${Math.round(p.accuracyMeters)} m`,
    p.mockLocation ? "Mock location" : null,
    p.fieldStatus && p.kind === "field"
      ? `Day: ${FIELD_STATUS_LABEL[p.fieldStatus]}`
      : null,
    p.visitOutletName ? `In call: ${p.visitOutletName}` : null,
    `${p.visited ?? 0} of ${p.planned ?? 0} stops done · ${p.productive ?? 0} productive`,
    p.lastMovedAt
      ? `Last move ${lastSeen(now, p.lastMovedAt)}`
      : "Last move unknown",
    p.idleFlag ? "Check in: no movement or visit for 45+ min" : null,
    p.sample ? "Sample position (test data, not this phone)" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type LatLng = { latitude: number; longitude: number };

export function boundsOf(points: readonly LatLng[]) {
  if (!points.length) return null;
  let south = 90,
    north = -90,
    west = 180,
    east = -180;
  for (const p of points) {
    south = Math.min(south, p.latitude);
    north = Math.max(north, p.latitude);
    west = Math.min(west, p.longitude);
    east = Math.max(east, p.longitude);
  }
  return { south, north, west, east };
}

/** Metro Cebu: where the pilot runs, so an empty map still opens somewhere useful. */
export const DEFAULT_CENTER: LatLng = {
  latitude: 10.3157,
  longitude: 123.8854,
};

export type Cluster<T> = {
  key: string;
  latitude: number;
  longitude: number;
  items: T[];
};

/**
 * Grid clustering in screen space: markers closer than `cellPx` at this zoom (Web
 * Mercator, 256 px tiles) collapse into one cluster at their mean position.
 */
export function clusterPoints<T extends LatLng>(
  items: readonly T[],
  zoom: number,
  cellPx = 48,
): Cluster<T>[] {
  const scale = 256 * 2 ** zoom;
  const project = (p: LatLng) => {
    const x = ((p.longitude + 180) / 360) * scale;
    const sin = Math.sin((p.latitude * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
    return { x, y };
  };
  const cells = new Map<string, T[]>();
  for (const item of items) {
    const { x, y } = project(item);
    const key = `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
    const list = cells.get(key) ?? [];
    list.push(item);
    cells.set(key, list);
  }
  return [...cells].map(([key, list]) => ({
    key,
    latitude: list.reduce((n, p) => n + p.latitude, 0) / list.length,
    longitude: list.reduce((n, p) => n + p.longitude, 0) / list.length,
    items: list,
  }));
}

export function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?"
  );
}

/**
 * Marker HTML (both map engines): a round badge with initials for a field agent, a square
 * truck badge for a van, coloured by status; a ring marks the selected marker.
 */
export function markerHtml(p: LivePosition, selected: boolean) {
  const color = STATUS_STYLE[p.status].color;
  const ring = selected ? "box-shadow:0 0 0 3px #111827;" : "";
  const shape = p.kind === "van" ? "border-radius:6px" : "border-radius:999px";
  const label =
    p.kind === "van"
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" aria-hidden="true"><path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>`
      : escapeHtml(initials(p.name));
  return `<span data-live-marker="${escapeHtml(p.id)}" title="${escapeHtml(p.name)}" style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;${shape};background:${color};color:white;border:2px solid white;font:600 11px/1 Mulish,sans-serif;${ring}">${label}</span>`;
}

export function clusterHtml(count: number) {
  return `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:32px;padding:0 6px;border-radius:999px;background:#111827;color:white;border:2px solid white;font:600 12px/1 Mulish,sans-serif">${count}</span>`;
}

export function storeHtml(name: string) {
  return `<span title="${escapeHtml(name)}" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:white;border:2px solid #374151"></span>`;
}

export function stopHtml(order: number) {
  return `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 4px;border-radius:999px;background:white;color:#111827;border:2px solid #111827;font:600 11px/1 Mulish,sans-serif">${order}</span>`;
}

/** Popup text for a stop on the selected trail. */
export function stopLabel(stop: Trail["stops"][number], order: number) {
  return `${order}. ${stop.outletName}${stop.onPlan === false ? " · Off plan" : ""} · ${formatTime(stop.checkedInAt)}–${formatTime(stop.checkedOutAt)}${stop.pinned ? "" : " · near GPS position"}`;
}

/** Which map to draw: Google Maps when a browser key is configured, else OpenStreetMap. */
export function mapProvider(key: string | undefined): "google" | "osm" {
  return key && key.trim() ? "google" : "osm";
}
