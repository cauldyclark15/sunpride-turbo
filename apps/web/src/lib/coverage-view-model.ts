export function slotKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    outlet_visit: "Store visit",
    non_visit: "Non-visit activity",
  };
  return (
    labels[kind] ??
    kind.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())
  );
}

export function coverageStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned: "Planned",
    cancelled: "Cancelled",
    replaced: "Replaced",
    draft: "Draft",
    submitted: "Submitted",
    approved: "Approved",
    active: "Active",
    superseded: "Superseded",
  };
  return (
    labels[status] ??
    status.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())
  );
}

export type CalendarRow = {
  serviceDate: string;
  slotKey: string;
  sequence: number;
};
export type CalendarMode = "day" | "week" | "month";
/** ISO dates are Manila civil dates; UTC here is used solely for weekday arithmetic. */
export function calendarBucket(date: string, mode: CalendarMode): string {
  if (mode === "day") return date;
  if (mode === "month") return date.slice(0, 7);
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc.toISOString().slice(0, 10);
}
export function groupCalendar<T extends CalendarRow>(
  rows: T[],
  mode: CalendarMode,
): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = calendarBucket(row.serviceDate, mode);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
