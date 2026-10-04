import { v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * CVX-030 merchandising audit vocabulary. Sources: memo 2026-01-20 §2 (merchandising fixes,
 * display / price tagging, promo execution and validation, price compliance), the 2 Oct 2026
 * client call (merchandising, share-of-shelf checks and OSA count as productive work) and
 * blueprint §§16-17. Codes are ours and provisional until Sunpride confirms its audit form.
 */
export const MERCHANDISING_AUDIT_VERSION = "merchandising-audit/2026-10-04";

/** Blueprint §16: what a salesperson records per product on the shelf. */
export const availabilityStatus = v.union(
  v.literal("available"),
  v.literal("low_stock"),
  v.literal("out_of_stock"),
  v.literal("not_carried"),
);
export type AvailabilityStatus = Infer<typeof availabilityStatus>;

/** Blueprint §17 merchandising tasks; memo §2 display / price tagging / promo execution. */
export const complianceKind = v.union(
  v.literal("display"),
  v.literal("price_tag"),
  v.literal("promotion"),
  v.literal("freezer_placement"),
  v.literal("shelf_share"),
  v.literal("product_freshness"),
);
export type ComplianceKind = Infer<typeof complianceKind>;

/** A negative finding is recorded, never omitted; `not_applicable` never auto-passes (ADR-016). */
export const complianceFinding = v.union(
  v.literal("compliant"),
  v.literal("non_compliant"),
  v.literal("not_present"),
  v.literal("not_applicable"),
);

export const competitorObservationKind = v.union(
  v.literal("price"),
  v.literal("promotion"),
  v.literal("display"),
  v.literal("new_product"),
  v.literal("stock_level"),
  v.literal("other"),
);

export const availabilityLineInput = v.object({
  productId: v.id("products"),
  status: availabilityStatus,
  facings: v.optional(v.number()),
  note: v.optional(v.string()),
  evidenceIds: v.optional(v.array(v.id("fieldEvidenceFiles"))),
});
export const complianceCheckInput = v.object({
  kind: complianceKind,
  finding: complianceFinding,
  /** Program reference; required for `promotion`. */
  programRef: v.optional(v.string()),
  /** Whole percent 0-100; only for `shelf_share`. */
  shareOfShelfPercent: v.optional(v.number()),
  actionTaken: v.optional(v.string()),
  evidenceIds: v.optional(v.array(v.id("fieldEvidenceFiles"))),
});
export const competitorObservationInput = v.object({
  kind: competitorObservationKind,
  brand: v.string(),
  productCategory: v.optional(v.string()),
  observedPriceMinor: v.optional(v.int64()),
  currency: v.optional(v.string()),
  note: v.optional(v.string()),
  evidenceIds: v.optional(v.array(v.id("fieldEvidenceFiles"))),
});

export const MAX_AVAILABILITY_LINES = 200;
export const MAX_COMPLIANCE_CHECKS = 50;
export const MAX_COMPETITOR_OBSERVATIONS = 50;
export const MAX_AUDIT_PHOTOS = 20;
export const MAX_ASSORTMENT_PRODUCTS = 200;
