import { ConvexError, v } from "convex/values";

/**
 * Van sales / truck POS domain (CVX-027..029, ADR-010). The truck is an inventory location
 * (`inventoryLocations.type === "truck"`); every stock change on it goes through
 * `inventory/posting.ts#postMovement` (ADR-003/007). These tables only hold the van
 * workflow: vehicle master, the daily trip and its load sheet.
 *
 * Defaults that wait on Sunpride's answers (`_handoffs/sunpride-van-sales-questions.md`)
 * live in `VAN_POLICY` so they are one edit away.
 */
export const VAN_POLICY = {
  /** Q3: one trip a day per truck, no top-ups. */
  maxOpenTripsPerVehicleDay: 1,
  /** Q2: the salesman confirms each item; a mismatch waits for a supervisor. */
  loadDiscrepancyRequiresApproval: true,
  /** A trip may start only after its load is posted to the truck. */
  startRequiresPostedLoad: true,
  /** Q4: one salesman, one device. Crew names are optional free text until answered. */
  maxCrewNameLength: 80,
  /** Load sheets are bounded by the posting engine's per-command line cap. */
  maxLoadLines: 100,
  /** Bootstrap returns at most this many route customers / other scoped customers. */
  maxRouteCustomers: 300,
  maxUnplannedCustomers: 300,
} as const;

export const vehicleStatusValidator = v.union(
  v.literal("active"),
  v.literal("inactive"),
);

/**
 * Trip lifecycle: planned → loading (load sheet issued) → loaded (load posted) → active
 * (started on the device) → closing → reconciling → closed. `cancelled` before departure,
 * `review_required` when reconciliation needs a supervisor.
 */
export const tripStatusValidator = v.union(
  v.literal("planned"),
  v.literal("loading"),
  v.literal("loaded"),
  v.literal("active"),
  v.literal("closing"),
  v.literal("reconciling"),
  v.literal("closed"),
  v.literal("cancelled"),
  v.literal("review_required"),
);
export type TripStatus =
  | "planned"
  | "loading"
  | "loaded"
  | "active"
  | "closing"
  | "reconciling"
  | "closed"
  | "cancelled"
  | "review_required";

/** A trip in one of these states still owns its truck for the day. */
export const OPEN_TRIP_STATUSES: readonly TripStatus[] = [
  "planned",
  "loading",
  "loaded",
  "active",
  "closing",
  "reconciling",
  "review_required",
];

/**
 * Load sheet: planned (office issued expected quantities) → confirmed (salesman entered
 * actuals that differ; waits for approval) → posted (movement written) | cancelled.
 */
export const loadStatusValidator = v.union(
  v.literal("planned"),
  v.literal("discrepancy"),
  v.literal("posted"),
  v.literal("cancelled"),
);

/** Reasons a salesman may give for an actual load that differs from the sheet. */
export const LOAD_DISCREPANCY_REASONS = [
  "short_loaded",
  "over_loaded",
  "damaged_at_loading",
  "wrong_item",
  "other",
] as const;
export const loadDiscrepancyReasonValidator = v.union(
  v.literal("short_loaded"),
  v.literal("over_loaded"),
  v.literal("damaged_at_loading"),
  v.literal("wrong_item"),
  v.literal("other"),
);

export const DAMAGE_REASONS = [
  "crushed",
  "leaking",
  "expired",
  "spoiled",
  "other",
] as const;
export const damageReasonValidator = v.union(
  v.literal("crushed"),
  v.literal("leaking"),
  v.literal("expired"),
  v.literal("spoiled"),
  v.literal("other"),
);

export const vanOperationKindValidator = v.union(
  v.literal("trip.start"),
  v.literal("load.confirm"),
  v.literal("truck.damage"),
);
export type VanOperationKind = "trip.start" | "load.confirm" | "truck.damage";

export const SERVICE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Trimmed, bounded, printable free text; empty becomes undefined, invalid throws. */
export function boundedText(
  value: string | undefined,
  max: number,
  label = "Text",
): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (
    text.length > max ||
    Array.from(text).some((character) => character.charCodeAt(0) < 32)
  )
    throw new ConvexError(
      `${label} is too long or contains control characters`,
    );
  return text;
}
