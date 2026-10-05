import { v, type Infer } from "convex/values";

/**
 * SOP-009 field reports (memo 2026-01-20, "Reports" table): the DAR (Daily Activity Report)
 * filed by the supervisory positions and the ROAR (Route Activity Report) filed by route
 * sellers. Both are generated from the day's visits and activities; the person only adds
 * remarks and submits, which replaces the Viber message and the hard copy in a folder.
 *
 * Pure rules only (no database access), so they are unit-tested and shared by the readers,
 * the submit mutation and the web mirror.
 */

export const fieldReportKind = v.union(v.literal("dar"), v.literal("roar"));
export type FieldReportKind = Infer<typeof fieldReportKind>;

/**
 * Memo: "DAR — Daily Activity Report (SCDM, CDM, DS)". Sr CDS and CDS are added because
 * they are supervisory positions that run Work-With sessions (memo §III) and have no other
 * daily field report. OUR DECISION, to confirm with Sir Francis.
 */
export const DAR_POSITION_CODES: readonly string[] = [
  "SCDM",
  "CDM_KA",
  "CDM_GT",
  "SR_CDS",
  "CDS",
  "DS",
];

/**
 * Memo: "ROAR — Route Activity Report (RDS)". The acceptance criterion says route sellers,
 * and the standards (email 2026-09-30) group PMOT, PMOT Extruck, RDS and pre-booking as
 * Route Sales with the same 30-call standard, so they all file a ROAR. OUR DECISION for
 * every code except RDS, to confirm with Sir Francis.
 */
export const ROAR_POSITION_CODES: readonly string[] = [
  "RDS",
  "RS",
  "PMOT",
  "PMOT_EXTRUCK",
  "PM_STALLS",
];

export const FIELD_REPORT_SOURCE = "memo 2026-01-20 Reports (DAR, ROAR)";

export function reportKindFor(
  positionCode: string | null | undefined,
): FieldReportKind | null {
  if (!positionCode) return null;
  if (DAR_POSITION_CODES.includes(positionCode)) return "dar";
  if (ROAR_POSITION_CODES.includes(positionCode)) return "roar";
  return null;
}

export const FIELD_REPORT_LABELS: Record<FieldReportKind, string> = {
  dar: "Daily Activity Report (DAR)",
  roar: "Route Activity Report (ROAR)",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MANILA_OFFSET = 8 * HOUR;
/** Client answer 14 (2 Oct 2026): the day's updates must be in by 10 PM Manila. */
export const REPORT_DUE_HOUR = 22;
/** PROVISIONAL: how many days back a report may still be filed or corrected. */
export const SUBMIT_WINDOW_DAYS = 7;
/** Corrections allowed per person and day; each one is a new, kept revision. */
export const MAX_REVISIONS = 20;
export const MAX_REMARKS = 2000;
/** Days one completeness read covers. */
export const MAX_COMPLETENESS_DAYS = 14;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isServiceDate(date: string) {
  if (!DATE.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date
  );
}

/** Manila midnight (as a UTC instant) of a YYYY-MM-DD service date. */
export function manilaMidnight(serviceDate: string) {
  return Date.parse(`${serviceDate}T00:00:00.000Z`) - MANILA_OFFSET;
}

export function reportDueAt(serviceDate: string) {
  return manilaMidnight(serviceDate) + REPORT_DUE_HOUR * HOUR;
}

export function manilaToday(now: number) {
  return new Date(now + MANILA_OFFSET).toISOString().slice(0, 10);
}

export function addDays(serviceDate: string, days: number) {
  return new Date(Date.parse(`${serviceDate}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

/** `count` consecutive dates ending at `endDate`, oldest first. */
export function datesEndingAt(endDate: string, count: number) {
  return Array.from({ length: count }, (_, i) =>
    addDays(endDate, i - count + 1),
  );
}

/** Why a submission for this date is refused, or null when it may be filed now. */
export function submitWindowError(serviceDate: string, now: number) {
  if (!isServiceDate(serviceDate))
    return "Service date must be a YYYY-MM-DD date";
  const today = manilaToday(now);
  if (serviceDate > today) return "A report cannot be filed for a future day";
  if (serviceDate < addDays(today, -SUBMIT_WINDOW_DAYS))
    return `Reports can be filed up to ${SUBMIT_WINDOW_DAYS} days back`;
  return null;
}

export const completenessStatus = v.union(
  v.literal("submitted"),
  v.literal("late"),
  v.literal("due"),
  v.literal("missing"),
  v.literal("off_day"),
  v.literal("upcoming"),
);
export type CompletenessStatus = Infer<typeof completenessStatus>;

/**
 * One person-day: on time when the first submission reached the server by 10 PM, late
 * after it; due until 10 PM; missing once a selling day closed without one. A non-selling
 * day without a report is an off day (a report filed anyway still counts).
 */
export function completenessOf(input: {
  serviceDate: string;
  sellingDay: boolean;
  firstSubmittedAt: number | null;
  now: number;
}): CompletenessStatus {
  const dueAt = reportDueAt(input.serviceDate);
  if (input.firstSubmittedAt !== null)
    return input.firstSubmittedAt <= dueAt ? "submitted" : "late";
  if (!input.sellingDay) return "off_day";
  if (input.now < manilaMidnight(input.serviceDate)) return "upcoming";
  if (input.now <= dueAt) return "due";
  return "missing";
}

/** Figures frozen with each submission, so a later sync never rewrites what was filed. */
export const fieldReportSummary = v.object({
  planned: v.number(),
  plannedDone: v.number(),
  notVisited: v.number(),
  unplanned: v.number(),
  calls: v.number(),
  productiveCalls: v.number(),
  productivePct: v.union(v.number(), v.null()),
  workWithSessions: v.number(),
  workWithCompleted: v.number(),
  firstCheckInAt: v.union(v.number(), v.null()),
  lastCheckOutAt: v.union(v.number(), v.null()),
  fieldMinutes: v.union(v.number(), v.null()),
});
export type FieldReportSummary = Infer<typeof fieldReportSummary>;

/** Planned stops in route order first, then unplanned calls in check-in order. */
export function orderStops<
  T extends {
    sequence: number | null;
    checkedInAt: number | null;
    source: string;
  },
>(stops: readonly T[]) {
  const rank = (stop: T) => (stop.source === "unplanned" ? 1 : 0);
  return [...stops].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.sequence ?? Number.MAX_SAFE_INTEGER) -
        (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
      (a.checkedInAt ?? Number.MAX_SAFE_INTEGER) -
        (b.checkedInAt ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Minutes from first check-in to last check-out; null until both exist. */
export function fieldMinutes(
  firstCheckInAt: number | null,
  lastCheckOutAt: number | null,
) {
  if (firstCheckInAt === null || lastCheckOutAt === null) return null;
  if (lastCheckOutAt < firstCheckInAt) return null;
  return Math.round((lastCheckOutAt - firstCheckInAt) / 60_000);
}
