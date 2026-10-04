import type { StatusTone } from "@sunpride/ui";

/**
 * Pure view rules for the per-diem validation tab (SOP-004). Labels mirror the server's
 * `REASON_LABELS` in `supervision/per_diem_model.ts`; a parity test keeps them aligned.
 */

export type PerDiemReason =
  | "outside_mcp"
  | "removed_from_plan"
  | "plan_not_approved"
  | "not_completed"
  | "still_open"
  | "no_location"
  | "location_rejected"
  | "late_pending"
  | "late_rejected"
  | "no_report"
  | "no_call_sheet"
  | "not_visited";

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
  not_visited: "Planned stop not visited",
};

export const NOTE_LABELS: Record<string, string> = {
  location_unreviewed: "Away from the pin, not reviewed",
  late_accepted: "Late, accepted",
  location_exception_approved: "Location exception approved",
};

export type ClaimHalf = "month" | "first" | "second";
export const HALF_LABELS: [ClaimHalf, string][] = [
  ["month", "Whole month"],
  ["first", "1–15"],
  ["second", "16–end"],
];

/** Manila claim period for a YYYY-MM month and half. */
export function claimRange(month: string, half: ClaimHalf) {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const day = (n: number) => `${month}-${String(n).padStart(2, "0")}`;
  if (half === "first") return { from: day(1), to: day(15) };
  if (half === "second") return { from: day(16), to: day(last) };
  return { from: day(1), to: day(last) };
}

export function statusTone(status: string): StatusTone {
  if (status === "valid" || status === "validated") return "success";
  if (status === "held") return "warning";
  if (status === "returned" || status === "invalid") return "danger";
  return "neutral";
}

export const STATUS_LABELS: Record<string, string> = {
  valid: "Counts",
  held: "Held",
  invalid: "Does not count",
  validated: "Validated",
  returned: "Returned",
  none: "No valid call",
};

export function reasonText(reasons: readonly string[]) {
  return reasons
    .map((reason) => REASON_LABELS[reason as PerDiemReason] ?? reason)
    .join(" · ");
}

export function shortDay(date: string) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(Date.parse(`${date}T00:00:00Z`));
}

/** Server error text worth showing; anything else becomes a generic retry. */
export function decisionError(error: unknown) {
  const data = (error as { data?: unknown })?.data;
  if (data === "stale_validation")
    return "The calls changed since you opened this. Check again, then decide.";
  return typeof data === "string" ? data : "Not saved. Try again.";
}
