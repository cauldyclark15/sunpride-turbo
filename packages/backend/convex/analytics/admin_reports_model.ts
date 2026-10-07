import { v, type Infer } from "convex/values";

/**
 * SOP-012 admin report pack (memo §V "ADMIN- Reports"): validators and pure rules shared by
 * the read endpoint and its tests. Nothing here touches the database. Definitions and the
 * status of each report: docs/architecture/ADMIN_REPORT_PACK.md.
 *
 * Acronyms (Sir Francis's email of 30 Sep 2026, call of 2 Oct): UBA = Unique Buying
 * Account, OSA = On Shelf Availability, PC = Productive Call.
 */

/** People per report page. Each person's day reads visits, activities, collections, audits
 * and orders, so pages stay small; the web subscribes to every page of the scope. */
export const ADMIN_PACK_PAGE_SIZE = 10;

/** Collection lines listed per page for the AR reckoning view. */
export const MAX_COLLECTION_LINES = 200;

/** Orders read per person-day for UBA; more than this marks the page's UBA incomplete. */
export const MAX_DAY_ORDERS = 400;

const nullableNumber = v.union(v.number(), v.null());

export const adminPackPersonRow = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: v.union(v.string(), v.null()),
  positionLabel: v.union(v.string(), v.null()),
  channel: v.string(),
  orgUnitId: v.id("orgUnits"),
  sellingDay: v.boolean(),
  /** Manday: the person checked in at least once on the day. */
  manday: v.boolean(),
  calls: v.number(),
  productiveCalls: v.number(),
  callsTarget: nullableNumber,
  productiveTargetPct: nullableNumber,
  /** UBA: distinct customer codes with a positive counted sale written on the day. */
  buyingAccounts: v.array(v.string()),
  /** OSA from the day's merchandising audits: required SKUs found on shelf / checked. */
  osaAudits: v.number(),
  osaRequired: v.number(),
  osaAvailable: v.number(),
  /** Field collections recorded on the day's visits (rejected ones excluded), centavos. */
  collections: v.number(),
  collectedMinor: v.number(),
});
export type AdminPackPersonRow = Infer<typeof adminPackPersonRow>;

export const programTally = v.object({
  programRef: v.string(),
  executed: v.number(),
  notExecuted: v.number(),
  notApplicable: v.number(),
});
export type ProgramTally = Infer<typeof programTally>;

export const collectionLine = v.object({
  id: v.id("fieldCollections"),
  profileId: v.id("profiles"),
  personName: v.string(),
  customerCode: v.string(),
  customerName: v.string(),
  outletCode: v.string(),
  amountMinor: v.number(),
  currency: v.string(),
  method: v.string(),
  reference: v.string(),
  status: v.union(v.literal("recorded"), v.literal("pending_review")),
  at: v.number(),
});
export type CollectionLine = Infer<typeof collectionLine>;

/** Adds one promotion finding to a per-program tally map. */
export function tallyProgram(
  tallies: Map<string, ProgramTally>,
  programRef: string,
  finding: "executed" | "not_executed" | "not_applicable",
) {
  const ref = programRef.trim() || "(no program reference)";
  const tally = tallies.get(ref) ?? {
    programRef: ref,
    executed: 0,
    notExecuted: 0,
    notApplicable: 0,
  };
  if (finding === "executed") tally.executed++;
  else if (finding === "not_executed") tally.notExecuted++;
  else tally.notApplicable++;
  tallies.set(ref, tally);
}

export function sortedPrograms(tallies: Map<string, ProgramTally>) {
  return [...tallies.values()].sort((a, b) =>
    a.programRef.localeCompare(b.programRef),
  );
}
