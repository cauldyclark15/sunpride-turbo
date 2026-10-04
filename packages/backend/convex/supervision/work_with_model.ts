import { v, type Infer } from "convex/values";

/**
 * SOP-005 Work-With (memo 2026-01-20 §III). Pure rules only, so every requirement is unit
 * testable and the endpoints in `work_with.ts` stay thin.
 *
 * A Work-With is a coaching session a trainer (Sr CDS, CDS, DS — positions that carry a
 * `workWithWeeklyMin`) runs with one field person. It is its own record, never a visit note.
 * Call answer 6 (2 Oct 2026): the minimum is counted per position with the memo's base
 * numbers, so cadence is judged per trainer against the trainer's position standard.
 */

export const workWithObjective = v.union(
  v.literal("training"),
  v.literal("sales_validation"),
);
export type WorkWithObjective = Infer<typeof workWithObjective>;

/** End-to-end mode: a Booking work-with ends with the MCP; a truck work-with also rides it. */
export const workWithMode = v.union(v.literal("booking"), v.literal("truck"));
export type WorkWithMode = Infer<typeof workWithMode>;

export const workWithStatus = v.union(
  v.literal("open"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const observationArea = v.union(v.literal("bcp"), v.literal("psf"));
export const observationRating = v.union(
  v.literal("met"),
  v.literal("partial"),
  v.literal("not_met"),
);
/** Basic Call Procedure / Persuasive Selling Format observation. Steps are client wording. */
export const workWithObservation = v.object({
  area: observationArea,
  item: v.string(),
  rating: observationRating,
  remark: v.optional(v.string()),
});
export type WorkWithObservation = Infer<typeof workWithObservation>;

/** Training objective (a): training log reviewed and discussed by trainer and trainee; (c). */
export const workWithTrainingLog = v.object({
  topics: v.string(),
  tradeDevelopment: v.string(),
  discussedWithTrainee: v.boolean(),
});
export type WorkWithTrainingLog = Infer<typeof workWithTrainingLog>;

/** The reports the memo names for the sales and validation objective (a). */
export const PRE_CALL_DOCUMENTS = [
  "distribution",
  "productivity",
  "daily_productive_sales_report",
  "call_sheet",
] as const;
export const preCallDocument = v.union(
  v.literal("distribution"),
  v.literal("productivity"),
  v.literal("daily_productive_sales_report"),
  v.literal("call_sheet"),
);
export const PRE_CALL_DOCUMENT_LABELS: Record<
  (typeof PRE_CALL_DOCUMENTS)[number],
  string
> = {
  distribution: "Distribution report",
  productivity: "Productivity report",
  daily_productive_sales_report: "Daily Productive Sales Report",
  call_sheet: "Call Sheet",
};

export const workWithPreCall = v.object({
  documents: v.array(preCallDocument),
  remarks: v.string(),
});
export type WorkWithPreCall = Infer<typeof workWithPreCall>;

/** Post-call review with SWOT remarks. */
export const workWithPostCall = v.object({
  strengths: v.string(),
  weaknesses: v.string(),
  opportunities: v.string(),
  threats: v.string(),
});
export type WorkWithPostCall = Infer<typeof workWithPostCall>;

export const MAX_TEXT = 2_000;
export const MAX_SHORT_TEXT = 120;
export const MAX_OBSERVATIONS = 40;

export type McpDay = { planned: number; done: number };

export type WorkWithDraft = {
  objective: WorkWithObjective;
  mode: WorkWithMode;
  truckReference?: string;
  rodeWithTruck?: boolean;
  trainingLog?: WorkWithTrainingLog;
  observations: readonly WorkWithObservation[];
  preCall?: WorkWithPreCall;
  postCall?: WorkWithPostCall;
};

export const GAP_LABELS = {
  bcp_observation: "Record at least one Basic Call Procedure (BCP) observation",
  psf_observation:
    "Record at least one Persuasive Selling Format (PSF) observation",
  training_log: "Write the training log",
  trade_development: "Write the trade development remark",
  training_log_discussed:
    "Review and discuss the training log with the trainee",
  pre_call_documents: "Pick the reports reviewed before the call",
  pre_call_remarks: "Write the pre-call review remarks",
  post_call_swot: "Write all four SWOT remarks after the call",
  mcp_missing: "The trainee has no approved MCP stops on this day",
  mcp_unfinished: "The trainee has not finished the day's MCP",
  truck_missing: "Name the truck for a truck work-with",
  truck_not_ridden: "Confirm you rode the named truck",
} as const;
export type WorkWithGap = keyof typeof GAP_LABELS;

const filled = (text: string | undefined) => !!text && text.trim().length > 0;

/**
 * Everything still missing before a session may be completed (memo §III Work With
 * Requirements). BCP compliance incorporated with PSF is observed in ALL work-withs; the
 * training log applies to the training objective; pre/post review with SWOT and the
 * end-to-end rule apply to the sales and validation objective.
 */
export function completionGaps(
  draft: WorkWithDraft,
  mcp: McpDay,
): WorkWithGap[] {
  const gaps: WorkWithGap[] = [];
  if (!draft.observations.some((row) => row.area === "bcp"))
    gaps.push("bcp_observation");
  if (!draft.observations.some((row) => row.area === "psf"))
    gaps.push("psf_observation");
  if (draft.objective === "training") {
    if (!filled(draft.trainingLog?.topics)) gaps.push("training_log");
    if (!filled(draft.trainingLog?.tradeDevelopment))
      gaps.push("trade_development");
    if (!draft.trainingLog?.discussedWithTrainee)
      gaps.push("training_log_discussed");
    return gaps;
  }
  if (!draft.preCall?.documents.length) gaps.push("pre_call_documents");
  if (!filled(draft.preCall?.remarks)) gaps.push("pre_call_remarks");
  const swot = draft.postCall;
  if (
    !swot ||
    ![swot.strengths, swot.weaknesses, swot.opportunities, swot.threats].every(
      filled,
    )
  )
    gaps.push("post_call_swot");
  if (mcp.planned === 0) gaps.push("mcp_missing");
  else if (mcp.done < mcp.planned) gaps.push("mcp_unfinished");
  if (draft.mode === "truck") {
    if (!filled(draft.truckReference)) gaps.push("truck_missing");
    if (!draft.rodeWithTruck) gaps.push("truck_not_ridden");
  }
  return gaps;
}

const DAY = 86_400_000;

function parseDate(date: string) {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid date");
  return ms;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Monday-to-Sunday week (Manila calendar) containing the date: first and last day. */
export function weekOf(date: string) {
  const ms = parseDate(date);
  const weekday = new Date(ms).getUTCDay(); // Sunday=0
  const start = ms - ((weekday + 6) % 7) * DAY;
  return { start: iso(start), end: iso(start + 6 * DAY) };
}

/** Calendar month of the date: first and last day. */
export function monthOf(date: string) {
  const ms = parseDate(date);
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return {
    start: iso(start),
    end: iso(next - DAY),
    month: iso(start).slice(0, 7),
  };
}

export type CadenceState = "met" | "on_track" | "behind" | "no_standard";

/**
 * A period with fewer sessions than its minimum is "behind" once it has ended and
 * "on_track" while it is still running (the supervisor still has days left).
 */
export function cadenceState(
  count: number,
  minimum: number | null,
  periodEnd: string,
  today: string,
): CadenceState {
  if (minimum === null) return "no_standard";
  if (count >= minimum) return "met";
  return today > periodEnd ? "behind" : "on_track";
}

/** Count completed sessions whose service date falls inside [start, end]. */
export function countIn(
  sessions: readonly { serviceDate: string; status: string }[],
  start: string,
  end: string,
) {
  return sessions.filter(
    (row) =>
      row.status === "completed" &&
      row.serviceDate >= start &&
      row.serviceDate <= end,
  ).length;
}
