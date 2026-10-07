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
  /**
   * VAN-021 (Q10 plan: "Yes, with a reason, and a supervisor approves it"): a void needs a
   * supervisor's approval code when the sale total is at least this many centavos. 0 = every
   * void. Assumed default until Sunpride sets a threshold.
   */
  voidRequiresApproval: true,
  voidApprovalThresholdMinor: 0n,
  /**
   * VAN-022 (Q14 plan: "Salesman counts on the phone, cashier confirms; differences go to the
   * supervisor"): any difference between counted and expected cash needs a reason; a difference
   * of more than this many centavos (either way) also needs a supervisor's approval code.
   * Assumed default ₱50.00 until Sunpride sets its tolerance.
   */
  cashVarianceRequiresApproval: true,
  cashVarianceToleranceMinor: 5000n,
} as const;

/** VAN-022 reasons a seller may give when counted cash differs from the cash the phone expects. */
export const CASH_VARIANCE_REASONS = [
  "counting_error",
  "change_error",
  "customer_short_paid",
  "customer_overpaid",
  "lost_or_stolen",
  "counterfeit",
  "other",
] as const;
export type CashVarianceReason = (typeof CASH_VARIANCE_REASONS)[number];

/** VAN-021 reasons a seller may give for voiding a whole sale on the handheld. */
export const VOID_REASONS = [
  "wrong_items",
  "wrong_quantity",
  "wrong_customer",
  "wrong_payment",
  "customer_cancelled",
  "other",
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

export const vehicleStatusValidator = v.union(
  v.literal("active"),
  v.literal("inactive"),
);

/**
 * VAN-012: payment methods the van may take, sent to the handheld in the bootstrap policy.
 * `cash` gives change; `other` must equal the sale total and carries the reference the office
 * confirms later; `credit` charges the customer's account and needs `outletCreditTerms`.
 * Assumed defaults until Sunpride confirms its list (cash, check, GCash, bank transfer, credit).
 */
export const VAN_PAYMENT_METHODS = [
  {
    code: "cash",
    label: "Cash",
    kind: "cash",
    referenceRequired: false,
    referenceLabel: null,
  },
  {
    code: "check",
    label: "Check",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "Check number",
  },
  {
    code: "gcash",
    label: "GCash",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "GCash reference number",
  },
  {
    code: "bank_transfer",
    label: "Bank transfer",
    kind: "other",
    referenceRequired: true,
    referenceLabel: "Bank reference number",
  },
  {
    code: "credit",
    label: "Credit (charge to account)",
    kind: "credit",
    referenceRequired: false,
    referenceLabel: null,
  },
] as const;
/** Longest credit terms the office may set (days). */
export const VAN_MAX_CREDIT_TERMS_DAYS = 180;

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

/**
 * VAN-020: damage/spoilage evidence and approval. Assumed defaults until Sunpride sets its
 * own (documented in docs/runbooks/van-damage-spoilage.md): a photo for every visible-damage
 * reason, and a supervisor for any single record of 12 or more whole selling units (one
 * typical case). Records needing approval always need a photo. The stock moves
 * available → damaged at once in every case (it cannot be sold either way); a rejection
 * posts a separate reversal movement, so no movement is ever edited.
 */
export const VAN_DAMAGE_POLICY = {
  photoRequiredReasons: ["crushed", "leaking", "spoiled", "other"],
  approvalFromUnits: 12,
  /** JPEG bytes; the signed evidence body must stay under the 128 KiB gateway cap. */
  photoMaxBytes: 90_000,
} as const satisfies {
  photoRequiredReasons: readonly (typeof DAMAGE_REASONS)[number][];
  approvalFromUnits: number;
  photoMaxBytes: number;
};

export const damageStatusValidator = v.union(
  v.literal("recorded"),
  v.literal("pending_approval"),
  v.literal("approved"),
  v.literal("rejected"),
);
export type DamageStatus =
  "recorded" | "pending_approval" | "approved" | "rejected";

/** Whether a damage record of this size needs a supervisor, and whether it needs a photo. */
export function damageRules(
  reason: string,
  quantityBase: bigint,
  quantityScale: bigint,
): { needsApproval: boolean; photoRequired: boolean } {
  const scale = quantityScale > 0n ? quantityScale : 1n;
  const needsApproval =
    quantityBase >= BigInt(VAN_DAMAGE_POLICY.approvalFromUnits) * scale;
  const photoRequired =
    needsApproval ||
    (VAN_DAMAGE_POLICY.photoRequiredReasons as readonly string[]).includes(
      reason,
    );
  return { needsApproval, photoRequired };
}

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

/** A van device actor proven by mobile/device_auth.authorize (see van/http_handlers.ts). */
export const actorValidator = v.object({
  deviceId: v.id("registeredDevices"),
  profileId: v.id("profiles"),
  subject: v.string(),
  orgUnitId: v.id("orgUnits"),
  role: v.union(
    v.literal("super_admin"),
    v.literal("admin"),
    v.literal("operations"),
    v.literal("manager"),
    v.literal("approver"),
    v.literal("sales"),
    v.literal("analyst"),
    v.literal("viewer"),
  ),
  scopeFingerprint: v.string(),
});
