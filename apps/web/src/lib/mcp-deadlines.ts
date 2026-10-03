import type { StatusTone } from "@sunpride/ui";

/** Server-computed MCP deadline states (coverage/calendar_rules.ts). */
export type McpDeadlineState =
  | "not_open"
  | "due"
  | "overdue"
  | "awaiting_approval"
  | "approval_overdue"
  | "approved"
  | "approved_late";

export type ApprovalCapacity = "supervisor" | "backup" | "scope_approver";

const LABELS: Record<McpDeadlineState, [string, StatusTone]> = {
  not_open: ["Not yet due", "neutral"],
  due: ["Due", "warning"],
  overdue: ["Overdue", "danger"],
  awaiting_approval: ["Awaiting approval", "warning"],
  approval_overdue: ["Approval late", "danger"],
  approved: ["Approved", "success"],
  approved_late: ["Approved late", "warning"],
};

export function deadlineStateLabel(state: McpDeadlineState) {
  const [label, tone] = LABELS[state];
  return { label, tone };
}

/** States that put a person on the "no submitted MCP" reminder list. */
export function needsSubmissionReminder(state: McpDeadlineState) {
  return state === "not_open" || state === "due" || state === "overdue";
}

export function capacityLabel(capacity: ApprovalCapacity) {
  return capacity === "supervisor"
    ? "Direct supervisor"
    : capacity === "backup"
      ? "Backup approver (supervisor away)"
      : "Scoped approver (no supervisor recorded)";
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-10-25" → "25 Oct 2026": a date label, never shifted by host timezone or ICU. */
export function deadlineDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month! - 1]} ${year}`;
}
