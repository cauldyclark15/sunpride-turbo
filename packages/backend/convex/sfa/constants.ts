import { v } from "convex/values";

/**
 * SFA baseline data: Sunpride's positions and the standards attached to them.
 *
 * Every value here comes from the client's 2026-01-20 Sales Operations Standards memo
 * (`docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md`). Nothing in this file is
 * invented: where the memo is ambiguous the code says so instead of guessing.
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

export type PositionSeed = {
  code: string;
  label: string;
  category: PositionCategory;
};

/**
 * Labels are the memo's own wording. `RDS`, `DSP` and `ADP_PERSONNEL` are provisional:
 * the memo names them but never expands the acronyms (open questions in the persona plan).
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
  { code: "PMOT_EXTRUCK", label: "PMOT Extruck", category: "field" },
  {
    code: "PM_STALLS",
    label: "Public Market Stalls (pre-booking)",
    category: "field",
  },
  { code: "RDS", label: "RDS", category: "field" },
  { code: "DSP", label: "DSP", category: "field" },
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
  sourceRef: string;
};

/**
 * §I Daily Productive Sales Standards: KAS and Booking 5 calls at 90% productive; Route
 * Sales, PMOT Extruck and Public Market Stalls 30 calls at 85%. The memo's third and fourth
 * rows overlap (row 3 already names "Public Market Stalls (Pre-booking)") — see open
 * question 1 in the persona plan; no separate ADP-stalls position is seeded until Sunpride
 * answers.
 *
 * §III Work With minimums (sessions the supervisor must run): Sr CDS 1/week (4/month),
 * CDS 3/week (12/month), DS 4/week (16/month).
 */
export const POSITION_STANDARD_SEED: readonly PositionStandardSeed[] = [
  {
    positionCode: "KAS",
    dailyCallsTarget: 5,
    productiveCallTargetPct: 90,
    sourceRef: MEMO_STANDARDS_SOURCE,
  },
  {
    positionCode: "BOOKING",
    dailyCallsTarget: 5,
    productiveCallTargetPct: 90,
    sourceRef: MEMO_STANDARDS_SOURCE,
  },
  {
    positionCode: "RS",
    dailyCallsTarget: 30,
    productiveCallTargetPct: 85,
    sourceRef: MEMO_STANDARDS_SOURCE,
  },
  {
    positionCode: "PMOT_EXTRUCK",
    dailyCallsTarget: 30,
    productiveCallTargetPct: 85,
    sourceRef: MEMO_STANDARDS_SOURCE,
  },
  {
    positionCode: "PM_STALLS",
    dailyCallsTarget: 30,
    productiveCallTargetPct: 85,
    sourceRef: MEMO_STANDARDS_SOURCE,
  },
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
