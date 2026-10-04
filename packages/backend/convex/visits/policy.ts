/** Location evidence defaults; source/version travel with each evidence row.
 * Client answer 13 (2 Oct 2026): there is NO check-in distance limit. The radius only
 * decides whether a fix is flagged for supervisor review; it never blocks a check-in.
 * Replace via effective-dated outlet policy only after a client-approved policy table exists. */
export const VISIT_LOCATION_POLICY = {
  version: "field-day-2026-10-v3",
  source:
    "Client call 2 Oct 2026 (answers 13, 14); ADR-017 thresholds kept as flags",
  /* The radius is the outlet's verified pin radius (default 75 m, up to 500 m for malls and
   * warehouses through the two-person pin verification), never clamped to the default. */
  maxAccuracyMeters: 50,
  maxFixAgeMs: 60_000,
  /** A fix stamped this far ahead of the server clock is still trusted (minor phone clock
   * drift); beyond it the device time does not match and the fix goes to review. */
  maxFixClockDriftMs: 120_000,
  checkInGraceMs: 0,
  /** A device clock may run this far ahead of the server. */
  maxDeviceSkewMs: 24 * 60 * 60_000,
} as const;

/** Client answer 14 (2 Oct 2026): the field day closes at 10 PM Manila instead of a
 * 24-hour offline limit. Work for a day that reaches the server after its close is
 * accepted but flagged late and held for supervisor review, never dropped. */
export const FIELD_DAY_POLICY = {
  closeHourManila: 22,
  /** How far back a phone may still deliver a day's queued work (flagged late). */
  lateWindowDays: 7,
} as const;

const HOUR_MS = 3_600_000;
const MANILA_OFFSET_MS = 8 * HOUR_MS;

/** The 10 PM Manila close instant of a YYYY-MM-DD Manila service date. */
export function dayCloseAt(serviceDate: string) {
  return (
    Date.parse(`${serviceDate}T00:00:00.000Z`) -
    MANILA_OFFSET_MS +
    FIELD_DAY_POLICY.closeHourManila * HOUR_MS
  );
}

/** The next 10 PM Manila close strictly after `now` (today's, or tomorrow's once past). */
export function nextDayCloseAt(now: number) {
  const today = new Date(now + MANILA_OFFSET_MS).toISOString().slice(0, 10);
  const close = dayCloseAt(today);
  return close > now ? close : close + 24 * HOUR_MS;
}

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * AND-016: the photo types a field phone offers for visit evidence, delivered in the bootstrap
 * (`photoTypes`) so the list changes with a backend deploy, not an app release. Provisional until
 * Sunpride confirms its list: memo 2026-01-20 merchandising execution (display / price tagging),
 * promotion compliance, and the 2 Oct 2026 call (a store photo verifies a new outlet).
 */
export const EVIDENCE_PHOTO_TYPES_VERSION = "visit-photo-types/2026-10-04";
export const EVIDENCE_PHOTO_TYPES = [
  { code: "storefront", label: "Store front" },
  { code: "shelf_display", label: "Shelf and display" },
  { code: "price_tag", label: "Price tags" },
  { code: "promotion", label: "Promotion material" },
  { code: "other", label: "Other" },
] as const;
export type EvidencePhotoType = (typeof EVIDENCE_PHOTO_TYPES)[number]["code"];
export function isEvidencePhotoType(code: string): code is EvidencePhotoType {
  return EVIDENCE_PHOTO_TYPES.some((type) => type.code === code);
}
