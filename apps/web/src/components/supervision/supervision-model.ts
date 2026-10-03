import type { Id } from "@sunpride/backend/data-model";
import type { StatusTone } from "@sunpride/ui";

/** Pure view rules for the supervision screens (WEB-022/023/024). */

/** Arguments every supervision query takes. */
export type SupervisionFilters = {
  serviceDate: string;
  orgUnitId?: Id<"orgUnits">;
  channel?: string;
  directOnly?: boolean;
};

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE = 60_000;
/** PROVISIONAL: a planned person with no check-in by 9 AM Manila is "Not started". */
export const EXPECTED_START_HOUR = 9;
/** PROVISIONAL: no update for this long during the day reads as "Idle". */
export const IDLE_AFTER_MS = 90 * MINUTE;

export function manilaToday(now = Date.now()) {
  return new Date(now + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

function manilaMidnight(serviceDate: string) {
  return Date.parse(`${serviceDate}T00:00:00.000Z`) - MANILA_OFFSET_MS;
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

export function percent(part: number, whole: number) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

export type TeamPerson = {
  planned: number;
  plannedDone: number;
  done: number;
  inProgress: boolean;
  firstCheckInAt: number | null;
  lastActivityAt: number | null;
};

export type PersonStatus = { label: string; tone: StatusTone };

/** Field-day status from the person's numbers, the service date, and the viewer's clock. */
export function personStatus(
  person: TeamPerson,
  serviceDate: string,
  dayCloseAt: number,
  now: number,
): PersonStatus {
  const closed = now >= dayCloseAt;
  if (person.inProgress && !closed)
    return { label: "In call", tone: "success" };
  if (person.planned === 0 && person.done === 0)
    return { label: "No plan", tone: "neutral" };
  if (person.planned > 0 && person.plannedDone >= person.planned)
    return { label: "Done", tone: "success" };
  if (person.firstCheckInAt === null) {
    if (closed) return { label: "No calls", tone: "danger" };
    if (now >= manilaMidnight(serviceDate) + EXPECTED_START_HOUR * 60 * MINUTE)
      return { label: "Not started", tone: "warning" };
    return { label: "Not yet", tone: "neutral" };
  }
  if (closed) return { label: "Incomplete", tone: "warning" };
  if (
    person.lastActivityAt !== null &&
    now - person.lastActivityAt >= IDLE_AFTER_MS
  )
    return {
      label: `Idle ${Math.floor((now - person.lastActivityAt) / (60 * MINUTE))}h`,
      tone: "warning",
    };
  return { label: "On route", tone: "neutral" };
}

export function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows)
    groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export const EXCEPTION_LABELS = {
  location: "Location",
  out_of_sequence: "Out of order",
  unplanned: "Unplanned",
  nonproductive: "Nonproductive",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  not_visited: "Not visited",
} as const;
export type ExceptionKind = keyof typeof EXCEPTION_LABELS;

export const LOCATION_RESULT_LABELS: Record<string, string> = {
  outside_radius: "Outside radius",
  unavailable: "No location",
  unreliable: "Weak fix",
};

/** Reason codes accepted by `decideLocationException` (letters, digits, `_.-`). */
export const DECISION_REASONS = {
  approve: [
    ["pin_outdated", "Pin outdated"],
    ["large_site", "Large site"],
    ["weak_signal", "Weak signal"],
    ["store_relocated", "Store moved"],
    ["confirmed_by_call", "Confirmed by call"],
  ],
  reject: [
    ["not_at_store", "Not at store"],
    ["no_valid_reason", "No valid reason"],
    ["suspected_mock", "Suspected fake location"],
  ],
} as const satisfies Record<
  "approve" | "reject",
  readonly (readonly [string, string])[]
>;

export function reasonLabel(code: string | null | undefined) {
  if (!code) return null;
  for (const list of Object.values(DECISION_REASONS))
    for (const [value, label] of list) if (value === code) return label;
  return code.replaceAll("_", " ");
}

const EVENT_LABELS: Record<string, string> = {
  "visit.checked_in": "Checked in",
  "visit.checked_out": "Checked out",
  "location.exception.decided": "Decided",
};
export function eventLabel(kind: string) {
  return (
    EVENT_LABELS[kind] ?? kind.replace(/^[a-z]+\./, "").replaceAll("_", " ")
  );
}

type ExceptionLike = {
  kind: ExceptionKind;
  open: boolean;
};

/**
 * Open geofence evidence needs a decision. Planned stops not visited only count once the
 * day has closed (10 PM); before that they are simply still ahead.
 */
export function splitQueue<T extends ExceptionLike>(
  items: readonly T[],
  dayCloseAt: number,
  now: number,
) {
  const visible = items.filter(
    (item) => item.kind !== "not_visited" || now >= dayCloseAt,
  );
  return {
    open: visible.filter((item) => item.open),
    other: visible.filter((item) => !item.open),
  };
}

export function exceptionMeta(item: {
  kind: ExceptionKind;
  event: "check_in" | "check_out" | null;
  result: string | null;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  sequence: number | null;
  after: number | null;
  reason: string | null;
  at: number | null;
}) {
  const parts: string[] = [];
  if (item.kind === "location") {
    parts.push(item.event === "check_out" ? "Check-out" : "Check-in");
    if (item.result)
      parts.push(LOCATION_RESULT_LABELS[item.result] ?? item.result);
    if (item.distanceMeters !== null)
      parts.push(`${Math.round(item.distanceMeters)} m away`);
    if (item.accuracyMeters !== null)
      parts.push(`±${Math.round(item.accuracyMeters)} m`);
  } else if (item.kind === "out_of_sequence" && item.sequence !== null)
    parts.push(`Stop ${item.sequence} after stop ${item.after ?? "—"}`);
  else if (item.sequence !== null) parts.push(`Stop ${item.sequence}`);
  if (item.reason) parts.push(reasonLabel(item.reason)!);
  if (item.at !== null) parts.push(formatTime(item.at));
  return parts.join(" · ");
}

type StopLike = {
  source: "planned" | "unplanned" | "not_visited";
  point: { latitude: number; longitude: number } | null;
  territoryCode: string | null;
};

/** Stops that can be drawn: anything with a verified outlet pin. */
export function plottedStops<T extends StopLike>(stops: readonly T[]) {
  return stops.filter(
    (stop) =>
      stop.point !== null &&
      Number.isFinite(stop.point.latitude) &&
      Number.isFinite(stop.point.longitude),
  );
}

export function territoriesOf(
  people: readonly { stops: readonly StopLike[] }[],
) {
  return [
    ...new Set(
      people.flatMap((person) =>
        person.stops.flatMap((stop) =>
          stop.territoryCode ? [stop.territoryCode] : [],
        ),
      ),
    ),
  ].sort();
}

/** Muted marker tones, one per person on the map, cycling. */
export const PERSON_TONES = [
  "#334155",
  "#0f766e",
  "#7c3aed",
  "#b45309",
  "#be185d",
  "#1d4ed8",
] as const;
