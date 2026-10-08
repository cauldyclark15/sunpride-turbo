import { v } from "convex/values";

/**
 * SP-0135 live map: location pings from the field apps (kind `field`) and the van POS
 * (kind `van`). Tracking happens ONLY during work — the phone starts at the day's first
 * check-in / Start day (field) or trip start (van) and stops at End day, sign-out, trip
 * close or the 10 PM Manila daily close. The server enforces the parts it can see: field
 * pings outside working hours and van pings outside an active trip are refused.
 * Visibility follows the existing org scope (ADR-005); retention is 90 days.
 * Wire contract: `packages/domain-contracts/schemas/{mobile,van}-v1.schema.json`.
 */
export const LOCATION_POLICY = {
  /** Pings in one upload. */
  maxBatch: 100,
  /** Server rate limit: one ping per person and kind per 10 s (start/stop exempt). */
  minSpacingMs: 10_000,
  /** Buffered offline pings older than this are refused (`too_old`). */
  maxAgeMs: 7 * 24 * 3_600_000,
  /** Device clocks ahead of the server by more than this are refused. */
  maxFutureSkewMs: 5 * 60_000,
  /** Scheduled cleanup removes pings older than this. */
  retentionMs: 90 * 24 * 3_600_000,
  /** Field working hours, Asia/Manila: 05:00 until the 10 PM daily close. */
  workStartHour: 5,
  dailyCloseHour: 22,
  /** Phone cadence (documented for the apps; the server does not require it). */
  movingIntervalMs: 60_000,
  movingDistanceMeters: 50,
  stillIntervalMs: 5 * 60_000,
  /** Live status from the age of the latest ping. */
  idleAfterMs: 3 * 60_000,
  staleAfterMs: 10 * 60_000,
  offlineAfterMs: 30 * 60_000,
  /** Positions older than this are not on the live map at all. */
  liveWindowMs: 24 * 3_600_000,
  /** Moving when the phone reports at least this speed (m/s, ~3.6 km/h). */
  movingSpeed: 1,
  /** Bounded reads. */
  maxLiveRows: 500,
  maxTrailPings: 3_000,
  maxTrailStops: 100,
  purgeBatch: 500,
} as const;

export const MANILA_OFFSET_MS = 8 * 3_600_000;

export const pingKindValidator = v.union(v.literal("field"), v.literal("van"));
export type PingKind = "field" | "van";
export const providerValidator = v.union(
  v.literal("gps"),
  v.literal("network"),
  v.literal("fused"),
  v.literal("unknown"),
);
export const triggerValidator = v.union(
  v.literal("start"),
  v.literal("moving"),
  v.literal("still"),
  v.literal("stop"),
);

const fix = {
  latitude: v.number(),
  longitude: v.number(),
  accuracyMeters: v.number(),
  speedMetersPerSecond: v.union(v.number(), v.null()),
  headingDegrees: v.union(v.number(), v.null()),
  batteryPercent: v.union(v.number(), v.null()),
  mockLocation: v.boolean(),
  provider: providerValidator,
  trigger: triggerValidator,
  /** Device clock (epoch ms). */
  recordedAt: v.number(),
  /** Server clock at ingestion. */
  receivedAt: v.number(),
};

/** One stored ping (append-only; removed only by the 90-day cleanup). */
export const locationPing = v.object({
  organizationId: v.string(),
  kind: pingKindValidator,
  profileId: v.id("profiles"),
  /** Absent only for synthetic beta sample pings. */
  deviceId: v.optional(v.id("registeredDevices")),
  clientPingId: v.string(),
  /** The tracked person's unit (field) or the trip's unit (van) when received. */
  orgUnitId: v.id("orgUnits"),
  vehicleId: v.optional(v.id("vehicles")),
  tripId: v.optional(v.id("vanTrips")),
  visitId: v.optional(v.id("visitExecutions")),
  /** Asia/Manila day of `recordedAt`. */
  serviceDate: v.string(),
  ...fix,
  /** Synthetic beta sample data (SP-0129), never a real phone. */
  sample: v.optional(v.boolean()),
});

/** Latest position per person (field) or per truck (van). */
export const liveLocation = v.object({
  organizationId: v.string(),
  kind: pingKindValidator,
  /** `field:<profileId>` or `van:<vehicleId>`. */
  subjectKey: v.string(),
  profileId: v.id("profiles"),
  deviceId: v.optional(v.id("registeredDevices")),
  orgUnitId: v.id("orgUnits"),
  vehicleId: v.optional(v.id("vehicles")),
  tripId: v.optional(v.id("vanTrips")),
  visitId: v.optional(v.id("visitExecutions")),
  serviceDate: v.string(),
  ...fix,
  /** The phone said End day / trip end (trigger `stop`): offline until the next start. */
  trackingEnded: v.boolean(),
  sample: v.optional(v.boolean()),
});

export type LiveStatus = "moving" | "idle" | "stale" | "offline";
export const liveStatusValidator = v.union(
  v.literal("moving"),
  v.literal("idle"),
  v.literal("stale"),
  v.literal("offline"),
);

/** Status from the age of the latest ping, the reported speed and End day. */
export function liveStatus(
  row: {
    recordedAt: number;
    receivedAt: number;
    speedMetersPerSecond: number | null;
    trigger: string;
    trackingEnded: boolean;
  },
  now: number,
): LiveStatus {
  if (row.trackingEnded) return "offline";
  const age = now - Math.min(row.recordedAt, row.receivedAt);
  if (age >= LOCATION_POLICY.offlineAfterMs) return "offline";
  if (age >= LOCATION_POLICY.staleAfterMs) return "stale";
  if (
    age < LOCATION_POLICY.idleAfterMs &&
    (row.trigger === "moving" ||
      (row.speedMetersPerSecond ?? 0) >= LOCATION_POLICY.movingSpeed)
  )
    return "moving";
  return "idle";
}

export function manilaDateOf(ms: number): string {
  return new Date(ms + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export function manilaHourOf(ms: number): number {
  return new Date(ms + MANILA_OFFSET_MS).getUTCHours();
}

/** UTC instant of Manila midnight for a YYYY-MM-DD day. */
export function manilaMidnight(serviceDate: string): number {
  return Date.parse(`${serviceDate}T00:00:00.000Z`) - MANILA_OFFSET_MS;
}

export function withinWorkHours(ms: number): boolean {
  const hour = manilaHourOf(ms);
  return (
    hour >= LOCATION_POLICY.workStartHour &&
    hour < LOCATION_POLICY.dailyCloseHour
  );
}

export const PING_CODES = [
  "invalid_request",
  "out_of_scope",
  "conflict",
  "outside_work_hours",
  "too_frequent",
  "too_old",
  "trip_not_active",
] as const;
export type PingCode = (typeof PING_CODES)[number];

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Wire ping shape (both gateways); `visitId` field only, `tripId` van only. */
export const wirePing = v.object({
  clientPingId: v.string(),
  recordedAt: v.number(),
  latitude: v.number(),
  longitude: v.number(),
  accuracyMeters: v.number(),
  speedMetersPerSecond: v.union(v.number(), v.null()),
  headingDegrees: v.union(v.number(), v.null()),
  batteryPercent: v.union(v.number(), v.null()),
  mockLocation: v.boolean(),
  provider: providerValidator,
  trigger: triggerValidator,
  visitId: v.optional(v.string()),
  tripId: v.optional(v.string()),
});
export type WirePing = typeof wirePing.type;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const nullableIn = (value: unknown, min: number, max: number) =>
  value === null || (finite(value) && value >= min && value <= max);

/** Shape check shared by the HTTP gateways (exact keys) and the mutation (values). */
export function validWirePing(value: unknown, kind: PingKind): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const p = value as Record<string, unknown>;
  const allowed = [
    "clientPingId",
    "recordedAt",
    "latitude",
    "longitude",
    "accuracyMeters",
    "speedMetersPerSecond",
    "headingDegrees",
    "batteryPercent",
    "mockLocation",
    "provider",
    "trigger",
    kind === "field" ? "visitId" : "tripId",
  ];
  if (!Object.keys(p).every((key) => allowed.includes(key))) return false;
  return (
    typeof p.clientPingId === "string" &&
    UUID.test(p.clientPingId) &&
    Number.isSafeInteger(p.recordedAt) &&
    (p.recordedAt as number) >= 0 &&
    finite(p.latitude) &&
    Math.abs(p.latitude) <= 90 &&
    finite(p.longitude) &&
    Math.abs(p.longitude) <= 180 &&
    finite(p.accuracyMeters) &&
    p.accuracyMeters >= 0 &&
    p.accuracyMeters <= 100_000 &&
    nullableIn(p.speedMetersPerSecond, 0, 100) &&
    nullableIn(p.headingDegrees, 0, 360) &&
    (p.batteryPercent === null ||
      (Number.isSafeInteger(p.batteryPercent) &&
        (p.batteryPercent as number) >= 0 &&
        (p.batteryPercent as number) <= 100)) &&
    typeof p.mockLocation === "boolean" &&
    ["gps", "network", "fused", "unknown"].includes(String(p.provider)) &&
    ["start", "moving", "still", "stop"].includes(String(p.trigger)) &&
    (kind === "field"
      ? p.visitId === undefined ||
        (typeof p.visitId === "string" &&
          p.visitId.length >= 1 &&
          p.visitId.length <= 64)
      : typeof p.tripId === "string" &&
        p.tripId.length >= 1 &&
        p.tripId.length <= 64)
  );
}
