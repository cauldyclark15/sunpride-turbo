import type { StatusTone } from "@sunpride/ui";

/**
 * Pure view rules for the DAR / ROAR screens (SOP-009). Backend truth lives in
 * `packages/backend/convex/field_reports/model.ts`; nothing here decides access.
 */

export type ReportKind = "dar" | "roar";
export type Completeness =
  "submitted" | "late" | "due" | "missing" | "off_day" | "upcoming";

export const REPORT_TITLES: Record<ReportKind, string> = {
  dar: "Daily Activity Report (DAR)",
  roar: "Route Activity Report (ROAR)",
};

export const REPORT_SHORT: Record<ReportKind, string> = {
  dar: "DAR",
  roar: "ROAR",
};

const COMPLETENESS: Record<Completeness, { label: string; tone: StatusTone }> =
  {
    submitted: { label: "Submitted", tone: "success" },
    late: { label: "Late", tone: "warning" },
    due: { label: "Due 10 PM", tone: "neutral" },
    missing: { label: "Missing", tone: "danger" },
    off_day: { label: "Off day", tone: "neutral" },
    upcoming: { label: "—", tone: "neutral" },
  };

export function completenessMeta(status: Completeness) {
  return COMPLETENESS[status];
}

/** One-letter cell text for the week grid; the full label is the cell's title. */
export function completenessMark(status: Completeness) {
  return {
    submitted: "✓",
    late: "L",
    due: "·",
    missing: "✕",
    off_day: "",
    upcoming: "",
  }[status];
}

const CALL_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  productive: { label: "Productive", tone: "success" },
  nonproductive: { label: "Not productive", tone: "warning" },
  open: { label: "In call", tone: "neutral" },
  not_visited: { label: "Not visited", tone: "danger" },
  off_plan: { label: "Unplanned", tone: "neutral" },
};

export function callStatusMeta(status: string) {
  return CALL_STATUS[status] ?? { label: status, tone: "neutral" as const };
}

const ACTIVITY_LABELS: Record<string, string> = {
  order_intent: "Order",
  merchandising: "Merchandising",
  price_check: "Price check",
  inventory_check: "Inventory",
  promotion: "Promo",
  note: "Note",
  call_sheet: "Call sheet",
};

export function activityLabel(kind: string) {
  return ACTIVITY_LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function activitySummary(kinds: readonly string[], collections: number) {
  const labels = kinds.filter((kind) => kind !== "note").map(activityLabel);
  if (collections > 0)
    labels.push(
      collections === 1 ? "Collection" : `${collections} collections`,
    );
  return labels.length ? labels.join(", ") : "—";
}

export function formatMinutes(minutes: number | null) {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatPct(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

/** "Wed 30" header for a YYYY-MM-DD date in the week grid. */
export function dayHeader(serviceDate: string) {
  const date = new Date(`${serviceDate}T00:00:00.000Z`);
  const weekday = new Intl.DateTimeFormat("en-PH", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

/** "30 Sep 2026" for a YYYY-MM-DD date. */
export function longDate(serviceDate: string) {
  return new Intl.DateTimeFormat("en-PH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${serviceDate}T00:00:00.000Z`));
}

/** Short sentence under a person's report: what was filed and when. */
export function submissionLine(input: {
  status: Completeness;
  revisions: number;
}) {
  if (input.revisions === 0) return "Not submitted yet";
  const corrected =
    input.revisions > 1 ? ` · corrected ${input.revisions - 1}×` : "";
  return `${completenessMeta(input.status).label}${corrected}`;
}
