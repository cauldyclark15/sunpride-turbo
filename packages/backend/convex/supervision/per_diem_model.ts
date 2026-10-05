import { ConvexError, v } from "convex/values";
import { localDate, monthDates } from "../coverage/validation";

/**
 * SOP-004 per-diem validation rules (memo §II "Per Diem Validation Policy"). Pure: no
 * database access, so every rule is unit-testable.
 *
 * Memo: "Only calls and activities reflected in the MCP, and supported by the required
 * reports and documentation, are valid for per diem entitlement."
 * Call answers (2 Oct 2026): the rate is set per position and is NOT part of the system;
 * all sales personnel claim; supervisors or managers validate; "money follows the approved
 * plan"; reports are filed daily per salesperson; location is recorded but there is no
 * fixed distance. Still open: whether a call outside the approved plan is ever payable.
 *
 * So this module counts validated calls and days; it never computes an amount.
 */

/** Bumped whenever a rule below changes; stored with every supervisor decision. */
export const PER_DIEM_RULE_VERSION = "sop-004/2026-10-05";
/** Planned stops and visits read per person per claim period (31 days × 60). */
export const MAX_PERIOD_ROWS = 1_860;
export const MAX_NOTE = 500;

export const perDiemReason = v.union(
  v.literal("outside_mcp"),
  v.literal("removed_from_plan"),
  v.literal("plan_not_approved"),
  v.literal("not_completed"),
  v.literal("still_open"),
  v.literal("no_location"),
  v.literal("location_rejected"),
  v.literal("late_pending"),
  v.literal("late_rejected"),
  v.literal("no_report"),
  v.literal("no_call_sheet"),
  v.literal("forms_missing"),
  v.literal("not_visited"),
);
export type PerDiemReason = typeof perDiemReason.type;

export const perDiemNote = v.union(
  v.literal("location_unreviewed"),
  v.literal("late_accepted"),
  v.literal("location_exception_approved"),
);
export type PerDiemNote = typeof perDiemNote.type;

export const perDiemStatus = v.union(
  v.literal("valid"),
  v.literal("held"),
  v.literal("invalid"),
);
export type PerDiemStatus = typeof perDiemStatus.type;

/** Held reasons can still turn valid after a review; the rest never count. */
const HELD: ReadonlySet<PerDiemReason> = new Set([
  "still_open",
  "no_location",
  "late_pending",
  // A completed call without its purpose's required forms is held, never validated, until
  // the forms are recorded or a supervisor returns the period.
  "forms_missing",
]);

export const REASON_LABELS: Record<PerDiemReason, string> = {
  outside_mcp: "Not in the approved MCP",
  removed_from_plan: "Stop was taken out of the approved MCP",
  plan_not_approved: "MCP for this stop is not approved",
  not_completed: "Call not finished",
  still_open: "Call still open",
  no_location: "No location recorded at check-in",
  location_rejected: "Location rejected by a supervisor",
  late_pending: "Sent after the 10 PM close, waiting for review",
  late_rejected: "Sent after the 10 PM close and rejected",
  no_report: "No call report recorded",
  no_call_sheet: "Call sheet not filled for this account",
  forms_missing: "Required forms for the call's purpose are missing",
  not_visited: "Planned stop not visited",
};

const DONE = new Set(["checked-out", "completed"]);
const OPEN = new Set(["arrived", "checked-in", "in-progress"]);
const APPROVED_PLAN = new Set(["approved", "active", "superseded"]);

export type LocationFact = {
  event: "check_in" | "check_out";
  hasFix: boolean;
  /** Decision event outcome if a supervisor decided, else the stored review status. */
  status: string;
};

export type VisitFacts = {
  source: "planned" | "unplanned";
  state: string;
  /** The linked planned stop, or null when the visit has none or it does not match. */
  planned: { status: string; planStatus: string | null } | null;
  hasPlannedLink: boolean;
  location: readonly LocationFact[];
  lateReviewStatus: string | null;
  activityCount: number;
  hasCallSheet: boolean;
  callSheetRequired: boolean;
  /**
   * Required activity forms for the visit's intents (governing rules at call start) that
   * are not recorded, merged with what was flagged at End. Empty for a nonproductive
   * outcome (a closed store files no merchandising form).
   */
  requiredMissing: readonly string[];
};

/** Every reason a visit does not count, plus non-blocking notes. */
export function classifyVisit(facts: VisitFacts): {
  status: PerDiemStatus;
  reasons: PerDiemReason[];
  notes: PerDiemNote[];
} {
  const reasons: PerDiemReason[] = [];
  const notes: PerDiemNote[] = [];
  if (facts.source === "unplanned" || !facts.hasPlannedLink)
    reasons.push("outside_mcp");
  else if (!facts.planned) reasons.push("removed_from_plan");
  else if (facts.planned.status !== "planned")
    reasons.push("removed_from_plan");
  else if (
    !facts.planned.planStatus ||
    !APPROVED_PLAN.has(facts.planned.planStatus)
  )
    reasons.push("plan_not_approved");

  if (OPEN.has(facts.state)) reasons.push("still_open");
  else if (!DONE.has(facts.state)) reasons.push("not_completed");

  const checkIn = facts.location.filter((row) => row.event === "check_in");
  if (facts.location.some((row) => row.status === "rejected"))
    reasons.push("location_rejected");
  else if (
    !checkIn.some((row) => row.hasFix || row.status === "approved_exception")
  )
    reasons.push("no_location");
  if (facts.location.some((row) => row.status === "approved_exception"))
    notes.push("location_exception_approved");
  // No fixed distance (call answer 13): an unreviewed off-pin fix is shown, never blocks.
  if (
    facts.location.some((row) => row.status === "pending_review" && row.hasFix)
  )
    notes.push("location_unreviewed");

  if (facts.lateReviewStatus === "pending_review") reasons.push("late_pending");
  else if (facts.lateReviewStatus === "rejected") reasons.push("late_rejected");
  else if (facts.lateReviewStatus === "accepted") notes.push("late_accepted");

  if (DONE.has(facts.state)) {
    if (facts.activityCount === 0) reasons.push("no_report");
    else {
      if (facts.callSheetRequired && !facts.hasCallSheet)
        reasons.push("no_call_sheet");
      if (facts.requiredMissing.length) reasons.push("forms_missing");
    }
  }

  const status: PerDiemStatus = reasons.some((reason) => !HELD.has(reason))
    ? "invalid"
    : reasons.length
      ? "held"
      : "valid";
  return { status, reasons, notes };
}

/** Validated claim period: Manila dates inside one month, from ≤ to. */
export function claimPeriod(from: string, to: string) {
  localDate(from);
  localDate(to);
  if (from.slice(0, 7) !== to.slice(0, 7) || from > to)
    throw new ConvexError("A claim period stays inside one month");
  const dates = monthDates(from.slice(0, 7)).filter(
    (date) => date >= from && date <= to,
  );
  return { localMonth: from.slice(0, 7), dates };
}

export type DayLine = {
  serviceDate: string;
  plannedStops: number;
  validCalls: number;
  heldCalls: number;
  invalidCalls: number;
  notVisited: number;
};

export type ItemLike = {
  serviceDate: string;
  status: PerDiemStatus;
  kind: "visit" | "not_visited";
};

/**
 * Per-day lines and period totals. A day is valid when it has at least one valid call and
 * nothing held; a day with held calls is "held" until a supervisor decides them.
 * PROVISIONAL: the client has not said whether one valid call earns the day.
 */
export function summarizePeriod(
  dates: readonly string[],
  plannedByDate: ReadonlyMap<string, number>,
  items: readonly ItemLike[],
) {
  const days: (DayLine & { dayStatus: "valid" | "held" | "none" })[] = [];
  for (const serviceDate of dates) {
    const own = items.filter((item) => item.serviceDate === serviceDate);
    const visits = own.filter((item) => item.kind === "visit");
    const line = {
      serviceDate,
      plannedStops: plannedByDate.get(serviceDate) ?? 0,
      validCalls: visits.filter((item) => item.status === "valid").length,
      heldCalls: visits.filter((item) => item.status === "held").length,
      invalidCalls: visits.filter((item) => item.status === "invalid").length,
      notVisited: own.filter((item) => item.kind === "not_visited").length,
    };
    if (!line.plannedStops && !visits.length) continue;
    days.push({
      ...line,
      dayStatus: line.heldCalls ? "held" : line.validCalls ? "valid" : "none",
    });
  }
  const sum = (key: keyof DayLine) =>
    days.reduce((total, day) => total + (day[key] as number), 0);
  return {
    days,
    totals: {
      plannedStops: sum("plannedStops"),
      validCalls: sum("validCalls"),
      heldCalls: sum("heldCalls"),
      invalidCalls: sum("invalidCalls"),
      notVisited: sum("notVisited"),
      validDays: days.filter((day) => day.dayStatus === "valid").length,
      heldDays: days.filter((day) => day.dayStatus === "held").length,
    },
  };
}

/**
 * Required forms still missing: governing rules recomputed against the recorded kinds,
 * united with what End flagged. A nonproductive outcome needs no purpose forms (the same
 * rule `visits/commands` applies at End). Pure; stable order.
 */
export function missingForms(input: {
  outcome: string | null;
  storedMissing: readonly string[] | null;
  required: readonly string[];
  recorded: readonly string[];
}): string[] {
  // Fail closed: only an explicit nonproductive End is excused from the purpose's forms.
  if (input.outcome === "nonproductive") return [];
  const missing = input.required.filter(
    (kind) => !input.recorded.includes(kind),
  );
  for (const kind of input.storedMissing ?? [])
    if (!missing.includes(kind) && !input.recorded.includes(kind))
      missing.push(kind);
  return missing;
}

/** Stable SHA-256 of what the supervisor looked at, so a stale decision is refused. */
export async function periodHash(parts: readonly string[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\n")),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
