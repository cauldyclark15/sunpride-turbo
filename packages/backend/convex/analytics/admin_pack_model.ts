import { v, type Infer } from "convex/values";

/**
 * SOP-012 monthly admin report pack (memo §V "ADMIN- Reports"): Programs allocation (Promo
 * Advice), the Priorities pack, the ADP Claims Summary and the KAS Account Receivables
 * reckoning. Their inputs are office records, not field records, so they live in one table,
 * `adminPackRecords`, one row per allocation / document / claim / balance and Manila month.
 *
 * `source: "sample"` rows are made-up beta data (analytics/admin_pack_sample.ts, codes
 * `SAMPLE-*`). The switch to real data is per kind and month: as soon as one `office` row of
 * a kind exists for a month, every sample row of that kind and month is ignored. Definitions:
 * docs/architecture/ADMIN_REPORT_PACK.md.
 */

/** Rows of one kind read for one month (organization-wide, before scope filtering). */
export const MAX_PACK_RECORDS = 300;
/** Visits read for a month's programme utilization across the selected units. */
export const MAX_MONTH_VISITS = 1500;
/** Field collections read per receivable account for the reckoning. */
export const MAX_ACCOUNT_COLLECTIONS = 200;

export const PACK_KINDS = [
  "program_allocation",
  "priority_document",
  "adp_claim",
  "ar_balance",
] as const;
export type PackKind = (typeof PACK_KINDS)[number];

const common = {
  organizationId: v.string(),
  /** The unit the record belongs to; readers see it when the unit is in their scope. */
  orgUnitId: v.id("orgUnits"),
  /** Manila month, YYYY-MM. */
  period: v.string(),
  source: v.union(v.literal("sample"), v.literal("office")),
  /** Unique per organization; sample rows start with `SAMPLE-`. */
  code: v.string(),
  createdAt: v.number(),
};

export const priorityDocType = v.union(
  v.literal("da_contract"),
  v.literal("promo_advice"),
  v.literal("coa"),
  v.literal("sasr"),
  v.literal("br_template"),
);
export const priorityStatus = v.union(
  v.literal("pending"),
  v.literal("submitted"),
  v.literal("approved"),
  v.literal("returned"),
);
export const claimType = v.union(
  v.literal("display_allowance"),
  v.literal("promo_discount"),
  v.literal("bad_order"),
  v.literal("rebate"),
);
export const claimStatus = v.union(
  v.literal("filed"),
  v.literal("validated"),
  v.literal("approved"),
  v.literal("paid"),
  v.literal("rejected"),
);

export const adminPackRecord = v.union(
  v.object({
    ...common,
    kind: v.literal("program_allocation"),
    /** Same reference the field records on a visit's promotion check. */
    programRef: v.string(),
    programName: v.string(),
    /** Stores the programme is allocated to run in this month. */
    allocatedStores: v.number(),
    /** Allocated budget, centavos. */
    budgetMinor: v.number(),
  }),
  v.object({
    ...common,
    kind: v.literal("priority_document"),
    docType: priorityDocType,
    title: v.string(),
    accountName: v.string(),
    ownerName: v.string(),
    /** Manila date, YYYY-MM-DD. */
    dueDate: v.string(),
    status: priorityStatus,
    submittedDate: v.union(v.string(), v.null()),
  }),
  v.object({
    ...common,
    kind: v.literal("adp_claim"),
    partnerCode: v.string(),
    partnerName: v.string(),
    claimType,
    claimRef: v.string(),
    filedDate: v.string(),
    claimedMinor: v.number(),
    approvedMinor: v.union(v.number(), v.null()),
    status: claimStatus,
  }),
  v.object({
    ...common,
    kind: v.literal("ar_balance"),
    customerCode: v.string(),
    customerName: v.string(),
    /** Balance date (Manila); field collections from that day on reduce it. */
    asOfDate: v.string(),
    termsDays: v.number(),
    currentMinor: v.number(),
    days1to30Minor: v.number(),
    days31to60Minor: v.number(),
    days61to90Minor: v.number(),
    over90Minor: v.number(),
  }),
);
export type AdminPackRecord = Infer<typeof adminPackRecord>;

export const recordSource = v.union(
  v.literal("sample"),
  v.literal("office"),
  v.null(),
);
export type RecordSource = Infer<typeof recordSource>;

/**
 * Keeps one source per kind and month: office rows when any exist, otherwise sample rows.
 * Returns the kept rows and which source they came from (null when there are none).
 */
export function pickSource<R extends { source: "sample" | "office" }>(
  rows: readonly R[],
): { rows: R[]; source: RecordSource } {
  if (rows.some((row) => row.source === "office"))
    return {
      rows: rows.filter((row) => row.source === "office"),
      source: "office",
    };
  return rows.length
    ? { rows: [...rows], source: "sample" }
    : { rows: [], source: null };
}

/** Total receivable of a balance row, all aging buckets. */
export function balanceTotal(row: {
  currentMinor: number;
  days1to30Minor: number;
  days31to60Minor: number;
  days61to90Minor: number;
  over90Minor: number;
}) {
  return (
    row.currentMinor +
    row.days1to30Minor +
    row.days31to60Minor +
    row.days61to90Minor +
    row.over90Minor
  );
}

export const allocationRow = v.object({
  code: v.string(),
  source: v.union(v.literal("sample"), v.literal("office")),
  orgUnitId: v.id("orgUnits"),
  programRef: v.string(),
  programName: v.string(),
  allocatedStores: v.number(),
  budgetMinor: v.number(),
  /** Distinct stores where the programme was recorded as executed in the month. */
  executedStores: v.number(),
  executedChecks: v.number(),
  notExecutedChecks: v.number(),
});
export type AllocationRow = Infer<typeof allocationRow>;

export const receivableRow = v.object({
  code: v.string(),
  source: v.union(v.literal("sample"), v.literal("office")),
  orgUnitId: v.id("orgUnits"),
  customerCode: v.string(),
  customerName: v.string(),
  asOfDate: v.string(),
  termsDays: v.number(),
  currentMinor: v.number(),
  days1to30Minor: v.number(),
  days31to60Minor: v.number(),
  days61to90Minor: v.number(),
  over90Minor: v.number(),
  /** Recorded field collections in scope from the balance date to the month's end. */
  collectedMinor: v.number(),
  /** Field collections still pending office review (not deducted). */
  pendingReviewMinor: v.number(),
  /** False when the customer code is unknown to the system (no collections can match). */
  customerFound: v.boolean(),
});
export type ReceivableRow = Infer<typeof receivableRow>;
