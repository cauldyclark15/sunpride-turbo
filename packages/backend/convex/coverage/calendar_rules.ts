/**
 * Master Coverage Plan (MCP) calendar (client call 2 Oct 2026, CALL-06):
 * the MCP for month M is submitted in the last week (last 7 days) of month M-1;
 * the direct supervisor approves it at the latest by the end of day 7 of month M.
 *
 * Pure and import-free so the web mirror can parity-test against it. All dates are
 * Manila local dates; instants are epoch milliseconds.
 */
const DAY = 86_400_000;
const MANILA_OFFSET = 8 * 3_600_000;
export const MCP_SUBMISSION_WINDOW_DAYS = 7;
export const MCP_APPROVAL_DEADLINE_DAY = 7;

export type McpDeadlines = {
  localMonth: string;
  submissionOpensDate: string;
  submissionDueDate: string;
  approvalDueDate: string;
  /** First instant of the submission week. */
  submissionOpensAt: number;
  /** Submitted at or after this instant is late (end of month M-1). */
  submissionDueAt: number;
  /** Approved at or after this instant is late (end of day 7 of month M). */
  approvalDueAt: number;
};

export type McpDeadlineState =
  | "not_open"
  | "due"
  | "overdue"
  | "awaiting_approval"
  | "approval_overdue"
  | "approved"
  | "approved_late";

function dateLabel(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function startOf(date: string) {
  return Date.parse(`${date}T00:00:00.000Z`) - MANILA_OFFSET;
}

export function mcpDeadlines(localMonth: string): McpDeadlines {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(localMonth))
    throw new Error("Invalid Manila month");
  const year = Number(localMonth.slice(0, 4));
  const index = Number(localMonth.slice(5, 7)) - 1;
  // Day 0 of month M is the last day of month M-1.
  const previousLength = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const submissionOpensDate = dateLabel(
    year,
    index - 1,
    previousLength - MCP_SUBMISSION_WINDOW_DAYS + 1,
  );
  const submissionDueDate = dateLabel(year, index, 0);
  const approvalDueDate = dateLabel(year, index, MCP_APPROVAL_DEADLINE_DAY);
  return {
    localMonth,
    submissionOpensDate,
    submissionDueDate,
    approvalDueDate,
    submissionOpensAt: startOf(submissionOpensDate),
    submissionDueAt: startOf(submissionDueDate) + DAY,
    approvalDueAt: startOf(approvalDueDate) + DAY,
  };
}

export type McpPlanProgress = {
  status: "draft" | "submitted" | "approved" | "active" | "superseded";
  submittedAt?: number;
  approvedAt?: number;
};

const SUBMITTED = new Set(["submitted", "approved", "active", "superseded"]);
const APPROVED = new Set(["approved", "active", "superseded"]);

export function mcpDeadlineState(
  deadlines: McpDeadlines,
  plan: McpPlanProgress | null,
  now: number,
): {
  state: McpDeadlineState;
  submittedLate: boolean;
  approvedLate: boolean;
} {
  const submitted = !!plan && SUBMITTED.has(plan.status);
  const approved = !!plan && APPROVED.has(plan.status);
  const submittedLate =
    submitted &&
    plan!.submittedAt !== undefined &&
    plan!.submittedAt >= deadlines.submissionDueAt;
  const approvedLate =
    approved &&
    plan!.approvedAt !== undefined &&
    plan!.approvedAt >= deadlines.approvalDueAt;
  const state: McpDeadlineState = approved
    ? approvedLate
      ? "approved_late"
      : "approved"
    : submitted
      ? now >= deadlines.approvalDueAt
        ? "approval_overdue"
        : "awaiting_approval"
      : now < deadlines.submissionOpensAt
        ? "not_open"
        : now < deadlines.submissionDueAt
          ? "due"
          : "overdue";
  return { state, submittedLate, approvedLate };
}

const RANK: Record<McpPlanProgress["status"], number> = {
  draft: 0,
  submitted: 1,
  superseded: 2,
  approved: 3,
  active: 4,
};

/**
 * The month's original MCP decides deadline state; mid-month revisions (basedOnPlanId)
 * are approved later by design and are never "late". Most advanced status wins, then
 * the highest version.
 */
export function deadlinePlan<
  T extends McpPlanProgress & { version: number; basedOnPlanId?: unknown },
>(plans: T[]): T | null {
  const originals = plans.filter((plan) => plan.basedOnPlanId === undefined);
  const pool = originals.length ? originals : plans;
  return (
    [...pool].sort(
      (a, b) => RANK[b.status] - RANK[a.status] || b.version - a.version,
    )[0] ?? null
  );
}
