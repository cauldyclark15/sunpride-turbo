// SP-0142 (AND-PERF-002): reads one carried work day's location trail and reports every gap
// longer than the field app's ping cadence (1 min moving, 5 min still), from Start day to End day.
//
// Usage:  bun scripts/location-trail-gaps.ts <trail.json> [--grace-seconds 60] [--json]
//   <trail.json>  the `location/queries:trail` result for the person and day (an object with
//                 `pings`), a bare array of pings, or JSON lines of `locationPings` rows
//                 (`convex data locationPings --format jsonLines`); add --profile <id> and
//                 --date <YYYY-MM-DD> to pick one person's day out of raw rows.
// Exit code: 0 = no gap over the cadence, 1 = at least one gap, 2 = unusable input.
//
// Cadence mirrors `apps/field-android/.../location/Pings.kt` (PingCadence). The grace covers one
// fused-location fix interval: the phone only decides "moving"/"still" when a fix arrives, and
// balanced-power fixes arrive about once a minute, so a still ping can land up to ~6 min after the
// previous one without anything being lost.
import { readFileSync } from "node:fs";

export const CADENCE = {
  movingIntervalMs: 60_000,
  movingDistanceM: 50,
  movingSpeedMps: 1,
  stillIntervalMs: 5 * 60_000,
} as const;

export const DEFAULT_GRACE_MS = 60_000;

export type TrailPing = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  speedMetersPerSecond?: number | null;
  batteryPercent?: number | null;
  mockLocation?: boolean;
  trigger: string;
  recordedAt: number;
  kind?: string;
};

export type Gap = {
  from: number;
  to: number;
  ms: number;
  mode: "moving" | "still";
  allowedMs: number;
  distanceM: number;
};

export type TrailReport = {
  pings: number;
  byTrigger: Record<string, number>;
  segments: {
    start: number;
    end: number;
    startedBy: string;
    endedBy: string;
  }[];
  coveredMs: number;
  largestGap: Gap | null;
  gaps: Gap[];
  mockPings: number;
  battery: { first: number | null; last: number | null };
  warnings: string[];
};

const R = 6_371_000;
export function distanceMeters(a: TrailPing, b: TrailPing): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A gap counts as "moving" when the phone was travelling across it: the closing ping says
 * moving, either end reports walking speed, or the straight-line displacement passes the
 * moving threshold (and the fixes' own accuracy). Otherwise the 5-minute still cadence applies. */
export function gapMode(a: TrailPing, b: TrailPing): "moving" | "still" {
  if (b.trigger === "moving") return "moving";
  if (
    (a.speedMetersPerSecond ?? 0) >= CADENCE.movingSpeedMps ||
    (b.speedMetersPerSecond ?? 0) >= CADENCE.movingSpeedMps
  )
    return "moving";
  const d = distanceMeters(a, b);
  const noise = Math.max(a.accuracyMeters ?? 0, b.accuracyMeters ?? 0);
  return d >= CADENCE.movingDistanceM && d > noise ? "moving" : "still";
}

/** Splits the day at End day (`stop`) / Start day (`start`): time between an End day and the next
 * Start day is off duty and never counts as a gap. */
export function analyzeTrail(
  input: TrailPing[],
  graceMs = DEFAULT_GRACE_MS,
): TrailReport {
  const warnings: string[] = [];
  const pings = input
    .filter(
      (p) =>
        Number.isFinite(p.recordedAt) &&
        Number.isFinite(p.latitude) &&
        Number.isFinite(p.longitude),
    )
    .sort((a, b) => a.recordedAt - b.recordedAt);
  if (pings.length !== input.length)
    warnings.push(`${input.length - pings.length} unreadable ping(s) skipped`);
  const byTrigger: Record<string, number> = {};
  for (const p of pings) byTrigger[p.trigger] = (byTrigger[p.trigger] ?? 0) + 1;
  if (!byTrigger.start)
    warnings.push(
      "no Start day ping: measured from the first ping of the trail",
    );
  if (!byTrigger.stop)
    warnings.push(
      "no End day ping: measured to the last ping (was End day pressed before reading?)",
    );
  const kinds = new Set(pings.map((p) => p.kind).filter(Boolean));
  if (kinds.size > 1)
    warnings.push(
      `mixed ping kinds (${[...kinds].join(", ")}): pass only the field trail`,
    );

  const segments: TrailReport["segments"] = [];
  const gaps: Gap[] = [];
  let current: TrailPing[] = [];
  const close = () => {
    if (!current.length) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    segments.push({
      start: first.recordedAt,
      end: last.recordedAt,
      startedBy: first.trigger,
      endedBy: last.trigger,
    });
    for (let i = 1; i < current.length; i++) {
      const a = current[i - 1]!;
      const b = current[i]!;
      const mode = gapMode(a, b);
      const allowedMs =
        (mode === "moving"
          ? CADENCE.movingIntervalMs
          : CADENCE.stillIntervalMs) + graceMs;
      const ms = b.recordedAt - a.recordedAt;
      if (ms > allowedMs)
        gaps.push({
          from: a.recordedAt,
          to: b.recordedAt,
          ms,
          mode,
          allowedMs,
          distanceM: Math.round(distanceMeters(a, b)),
        });
    }
    current = [];
  };
  let onDuty = !byTrigger.start; // no start ping at all: treat the whole trail as one shift
  for (const p of pings) {
    if (p.trigger === "start") {
      close();
      onDuty = true;
    }
    if (!onDuty) continue;
    current.push(p);
    if (p.trigger === "stop") {
      close();
      onDuty = false;
    }
  }
  close();

  const batteries = pings
    .map((p) => p.batteryPercent)
    .filter((b): b is number => typeof b === "number");
  return {
    pings: pings.length,
    byTrigger,
    segments,
    coveredMs: segments.reduce((sum, s) => sum + (s.end - s.start), 0),
    largestGap: gaps.reduce<Gap | null>(
      (best, g) => (!best || g.ms > best.ms ? g : best),
      null,
    ),
    gaps,
    mockPings: pings.filter((p) => p.mockLocation).length,
    battery: {
      first: batteries[0] ?? null,
      last: batteries[batteries.length - 1] ?? null,
    },
    warnings,
  };
}

/** Accepts the trail query result, a bare array, or JSON lines of raw `locationPings` rows. */
export function parseTrailInput(
  text: string,
  filter: { profileId?: string; serviceDate?: string } = {},
): { pings: TrailPing[]; truncated: boolean } {
  const trimmed = text.trim();
  let rows: unknown[];
  let truncated = false;
  let whole: unknown;
  try {
    whole = JSON.parse(trimmed);
  } catch {
    whole = undefined; // JSON lines
  }
  if (Array.isArray(whole)) {
    rows = whole;
  } else if (whole && typeof whole === "object") {
    const parsed = whole as { pings?: unknown[]; truncated?: boolean };
    rows = Array.isArray(parsed.pings) ? parsed.pings : [whole];
    truncated = parsed.truncated === true;
  } else {
    rows = trimmed
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
  }
  const pings = (rows as (TrailPing & Record<string, unknown>)[]).filter(
    (row) =>
      (!filter.profileId || row.profileId === filter.profileId) &&
      (!filter.serviceDate || row.serviceDate === filter.serviceDate) &&
      (row.kind === undefined || row.kind === "field"),
  );
  return { pings, truncated };
}

const manila = (ms: number) =>
  new Date(ms + 8 * 3_600_000).toISOString().slice(11, 19);
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

export function formatReport(report: TrailReport, truncated: boolean): string {
  const lines: string[] = [];
  const verdict = report.gaps.length
    ? `FAIL: ${report.gaps.length} gap(s) over the cadence`
    : "PASS: no gap over the cadence";
  lines.push(`Location trail — ${verdict}`);
  lines.push(
    `Pings: ${report.pings} (${Object.entries(report.byTrigger)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}); mock ${report.mockPings}`,
  );
  for (const s of report.segments)
    lines.push(
      `Shift ${manila(s.start)}–${manila(s.end)} Manila (${minutes(s.end - s.start)}, ${s.startedBy} → ${s.endedBy})`,
    );
  lines.push(
    `Battery reported by the pings: ${report.battery.first ?? "?"}% → ${report.battery.last ?? "?"}%`,
  );
  lines.push(
    report.largestGap
      ? `Largest gap: ${minutes(report.largestGap.ms)} at ${manila(report.largestGap.from)} (${report.largestGap.mode})`
      : "Largest gap: none over the cadence",
  );
  for (const g of report.gaps)
    lines.push(
      `  ${manila(g.from)}–${manila(g.to)}  ${minutes(g.ms)}  ${g.mode} (allowed ${minutes(g.allowedMs)}), moved ${g.distanceM} m`,
    );
  if (truncated)
    lines.push(
      "WARNING: the trail was cut at the server's ping cap; read the raw rows instead",
    );
  for (const w of report.warnings) lines.push(`WARNING: ${w}`);
  return lines.join("\n");
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find(
    (a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"),
  );
  if (!file) {
    console.error(
      "usage: bun scripts/location-trail-gaps.ts <trail.json> [--grace-seconds 60] [--profile id --date YYYY-MM-DD] [--json]",
    );
    process.exit(2);
  }
  try {
    const { pings, truncated } = parseTrailInput(readFileSync(file, "utf8"), {
      profileId: argValue(args, "--profile"),
      serviceDate: argValue(args, "--date"),
    });
    if (!pings.length) throw new Error("no field pings in the input");
    const grace = Number(argValue(args, "--grace-seconds") ?? 60) * 1000;
    const report = analyzeTrail(pings, grace);
    console.log(
      args.includes("--json")
        ? JSON.stringify({ ...report, truncated }, null, 2)
        : formatReport(report, truncated),
    );
    process.exit(report.gaps.length || truncated ? 1 : 0);
  } catch (error) {
    console.error(`unusable input: ${(error as Error).message}`);
    process.exit(2);
  }
}
