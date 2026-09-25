/** PROVISIONAL ADR-017 defaults; source/version travel with each evidence row.
 * Replace via effective-dated outlet policy only after a client-approved policy table exists. */
export const VISIT_LOCATION_POLICY = {
  version: "provisional-adr017-v1",
  source: "ADR-017; client confirmation pending",
  radiusMeters: 75,
  maxAccuracyMeters: 50,
  maxFixAgeMs: 60_000,
  checkInGraceMs: 0,
  maxDeviceSkewMs: 24 * 60 * 60_000,
} as const;
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
