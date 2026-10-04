import type { StatusTone } from "@sunpride/ui";

/** Pure view rules for the Talk Sheet tab (SOP-011, memo Annex E). */

export type ItemStatus = "completed" | "on_going" | "overdue";

/** Annex E's standard issue lines, in form order (mirrors the backend list). */
export const TOPICS = [
  ["siv_stt", "SIV and STT"],
  ["buying_accounts", "Buying Accounts"],
  ["program_utilization", "Program Utilization"],
  ["report_submission", "Submission of Reports"],
  ["inventory_days", "Inventory Days Level"],
  ["marketing_program", "Marketing Program Execution"],
  ["other_operational", "Other Operational Issues"],
] as const;
export type Topic = (typeof TOPICS)[number][0];
export const TOPIC_LABELS = Object.fromEntries(TOPICS) as Record<Topic, string>;

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  completed: "Completed",
  on_going: "On-going",
  overdue: "Overdue",
};

export const SHEET_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  final: "Signed off",
};

export function itemTone(status: ItemStatus): StatusTone {
  return status === "completed"
    ? "success"
    : status === "overdue"
      ? "danger"
      : "warning";
}

export function sheetTone(status: string): StatusTone {
  return status === "final" ? "success" : "warning";
}

/** "36 days" / "1 day". */
export function daysLabel(days: number) {
  return `${days} day${days === 1 ? "" : "s"}`;
}
