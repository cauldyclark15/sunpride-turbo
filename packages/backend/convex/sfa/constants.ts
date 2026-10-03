import { v } from "convex/values";
import type { ProductiveCallRule } from "./productive_call";
import { DEFAULT_SELLING_WEEKDAYS } from "./selling_days";

/**
 * SFA baseline data: Sunpride's positions and the standards attached to them.
 *
 * Values come from the client's 2026-01-20 Sales Operations Standards memo
 * (`docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md`) as corrected by Sir Francis's
 * email of 2026-09-30 and the call of 2026-10-02 (`CALL_STANDARDS_SOURCE`). Nothing in this
 * file is invented: where the client has not confirmed a value the row says so in `notes`.
 */

/** Category groups positions so a routine can target a tier instead of a title. */
export const positionCategoryValidator = v.union(
  v.literal("leadership"),
  v.literal("supervisory"),
  v.literal("specialist"),
  v.literal("field"),
  v.literal("support"),
);

export type PositionCategory =
  "leadership" | "supervisory" | "specialist" | "field" | "support";

/** Channel vocabulary the memo itself uses (Key Accounts Group vs Gen Trade vs PMOT). */
export const CHANNEL_SCOPE_CODES = ["KA", "GT", "PMOT"] as const;

export const MEMO_STANDARDS_SOURCE = "memo 2026-01-20 §I";
export const MEMO_WORK_WITH_SOURCE = "memo 2026-01-20 §III";
export const CALL_STANDARDS_SOURCE =
  "Sir Francis email 2026-09-30 / call 2026-10-02";

/**
 * Seeded rows from these sources may be closed and replaced by a newer seed. A row from any
 * other source was entered by hand and always wins over the seed.
 */
export const SUPERSEDABLE_SEED_SOURCES: readonly string[] = [
  MEMO_STANDARDS_SOURCE,
  MEMO_WORK_WITH_SOURCE,
];

export type PositionSeed = {
  code: string;
  label: string;
  category: PositionCategory;
};

/**
 * Labels are the memo's own wording; the email of 2026-09-30 expanded PMOT (Public Market and
 * Open Trade), RDS (Route Distribution Salesman) and DSP (Distributor Sales Personnel).
 * `ADP_PERSONNEL` stays provisional.
 */
export const POSITION_SEED: readonly PositionSeed[] = [
  { code: "SALES_HEAD", label: "Sales Head", category: "leadership" },
  { code: "SCDM", label: "SCDM", category: "leadership" },
  {
    code: "CDM_KA",
    label: "Channel Development Manager — Key Accounts Group",
    category: "supervisory",
  },
  {
    code: "CDM_GT",
    label: "Channel Development Manager — Gen Trade",
    category: "supervisory",
  },
  {
    code: "SR_CDS",
    label: "Sr Channel Development Specialist",
    category: "supervisory",
  },
  {
    code: "CDS",
    label: "Channel Development Specialist",
    category: "supervisory",
  },
  { code: "DS", label: "Distributor Specialist", category: "specialist" },
  { code: "KAS", label: "Key Account Specialist (KAS)", category: "field" },
  { code: "BOOKING", label: "Booking (GT-Booking)", category: "field" },
  { code: "RS", label: "Route Sales (RS)", category: "field" },
  {
    code: "PMOT",
    label: "PMOT (Public Market and Open Trade)",
    category: "field",
  },
  { code: "PMOT_EXTRUCK", label: "PMOT Extruck", category: "field" },
  {
    code: "PM_STALLS",
    label: "Public Market Stalls (pre-booking)",
    category: "field",
  },
  {
    code: "RDS",
    label: "Route Distribution Salesman (RDS)",
    category: "field",
  },
  {
    code: "DSP",
    label: "Distributor Sales Personnel (DSP)",
    category: "field",
  },
  { code: "ADP_PERSONNEL", label: "ADP Personnel", category: "field" },
  { code: "HR_ADMIN", label: "HR / Admin", category: "support" },
  { code: "FINANCE", label: "Finance / Treasury", category: "support" },
  { code: "MIS_IT", label: "MIS / IT", category: "support" },
];

export type PositionStandardSeed = {
  positionCode: string;
  dailyCallsTarget?: number;
  productiveCallTargetPct?: number;
  workWithWeeklyMin?: number;
  workWithMonthlyMin?: number;
  productiveCallRule?: ProductiveCallRule;
  sellingWeekdays?: readonly number[];
  notes?: string;
  sourceRef: string;
};

const ROUTE_SELLER_NOTE =
  "30 calls a day at 85% productive, per day and per route. Six-day selling week (Mon–Sat).";
const TRUCK_SELLER_NOTE = `${ROUTE_SELLER_NOTE} Truck seller: merchandising counts when the visit is marked “visited, no sales due to inventory”.`;
const KEY_ACCOUNT_NOTE =
  "5 calls a day, per day and per route. Productive % TO CONFIRM: email 2026-09-30 says 85%, memo says 90%; memo value kept until Sir Francis confirms. Saturday is a collection day and counts as productive.";

function dailyStandard(
  positionCode: string,
  dailyCallsTarget: number,
  productiveCallTargetPct: number,
  productiveCallRule: ProductiveCallRule,
  notes: string,
): PositionStandardSeed {
  return {
    positionCode,
    dailyCallsTarget,
    productiveCallTargetPct,
    productiveCallRule,
    sellingWeekdays: DEFAULT_SELLING_WEEKDAYS,
    notes,
    sourceRef: CALL_STANDARDS_SOURCE,
  };
}

/**
 * Daily call standards (email 2026-09-30, call 2026-10-02 at 10:50): PMOT, PMOT Extruck, RDS
 * and pre-booking — together "Route Sales" / the Route Salesman — 30 calls a day at 85%
 * productive; KAS and Booking 5 calls a day at 90% (memo; the email's 85% is to be confirmed).
 * Targets are per day, per route. PMOT, PMOT Extruck and RDS carry stock (truck sellers);
 * pre-booking and Route Sales take orders under the any-one-activity rule.
 *
 * §III Work With minimums (sessions the supervisor must run, confirmed per position on the
 * call at 31:43): Sr CDS 1/week (4/month), CDS 3/week (12/month), DS 4/week (16/month).
 */
export const POSITION_STANDARD_SEED: readonly PositionStandardSeed[] = [
  dailyStandard("KAS", 5, 90, "any_listed_activity", KEY_ACCOUNT_NOTE),
  dailyStandard("BOOKING", 5, 90, "any_listed_activity", KEY_ACCOUNT_NOTE),
  dailyStandard("RS", 30, 85, "any_listed_activity", ROUTE_SELLER_NOTE),
  dailyStandard("PM_STALLS", 30, 85, "any_listed_activity", ROUTE_SELLER_NOTE),
  dailyStandard("PMOT", 30, 85, "truck_seller", TRUCK_SELLER_NOTE),
  dailyStandard("PMOT_EXTRUCK", 30, 85, "truck_seller", TRUCK_SELLER_NOTE),
  dailyStandard("RDS", 30, 85, "truck_seller", TRUCK_SELLER_NOTE),
  {
    positionCode: "SR_CDS",
    workWithWeeklyMin: 1,
    workWithMonthlyMin: 4,
    sourceRef: MEMO_WORK_WITH_SOURCE,
  },
  {
    positionCode: "CDS",
    workWithWeeklyMin: 3,
    workWithMonthlyMin: 12,
    sourceRef: MEMO_WORK_WITH_SOURCE,
  },
  {
    positionCode: "DS",
    workWithWeeklyMin: 4,
    workWithMonthlyMin: 16,
    sourceRef: MEMO_WORK_WITH_SOURCE,
  },
];
