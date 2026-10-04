import type { StatusTone } from "@sunpride/ui";

/** Pure view rules for the Work-With tab (SOP-005, memo §III). */

export type CadenceState = "met" | "on_track" | "behind" | "no_standard";

export const OBJECTIVE_LABELS = {
  training: "Training",
  sales_validation: "Sales and validation",
} as const;

export const MODE_LABELS = {
  booking: "Booking",
  truck: "Truck",
} as const;

export const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  completed: "Done",
  cancelled: "Cancelled",
};

export const PRE_CALL_DOCUMENTS = [
  ["distribution", "Distribution report"],
  ["productivity", "Productivity report"],
  ["daily_productive_sales_report", "Daily Productive Sales Report"],
  ["call_sheet", "Call Sheet"],
] as const;
export type PreCallDocument = (typeof PRE_CALL_DOCUMENTS)[number][0];

export const RATING_LABELS = {
  met: "Met",
  partial: "Partly",
  not_met: "Not met",
} as const;

export function statusTone(status: string): StatusTone {
  return status === "completed"
    ? "success"
    : status === "cancelled"
      ? "neutral"
      : "warning";
}

/** "2/4" with a tone: green once met, red once the period ended short. */
export function cadenceCell(
  count: number,
  minimum: number | null,
  state: CadenceState,
): { label: string; tone: StatusTone } {
  if (minimum === null) return { label: `${count}`, tone: "neutral" };
  const label = `${count}/${minimum}`;
  if (state === "met") return { label, tone: "success" };
  if (state === "behind") return { label: `${label} · behind`, tone: "danger" };
  return { label, tone: "warning" };
}

export function shortDate(date: string) {
  const [, month, day] = date.split("-");
  const names = [
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
  return `${Number(day)} ${names[Number(month) - 1] ?? month}`;
}
