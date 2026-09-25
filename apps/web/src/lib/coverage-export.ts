import { coverageStatusLabel, slotKindLabel } from "./coverage-view-model";

export function manilaMinute(value?: number): string {
  if (value === undefined) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export type ScheduleHeader = {
  planId: string;
  localMonth: string;
  version: number;
  status: string;
  assigneeName: string;
  preparedByName: string;
  preparedAt: number;
  submittedByName?: string;
  submittedAt?: number;
  approvedByName?: string;
  approvedAt?: number;
  signedHashPrefix?: string;
};
export type ScheduleRow = {
  slotKey: string;
  serviceDate: string;
  kind: string;
  outletCode?: string;
  name?: string;
  territoryId?: string;
  routeId?: string;
  territoryCode?: string;
  routeCode?: string;
  sequence: number;
  visitStatus?: "planned" | "cancelled" | "replaced";
  durationMinutes: number;
};
export type ScheduleFilters = {
  territoryId?: string;
  routeId?: string;
  visitStatus?: "planned" | "cancelled" | "replaced";
  territoryLabel?: string;
  routeLabel?: string;
};
export type SchedulePage = {
  page: ScheduleRow[];
  planHeader: ScheduleHeader;
  continueCursor: string;
  isDone: boolean;
};
export const MAX_EXPORT_ROWS = 500;
export const EXPORT_PAGE_SIZE = 20;

/** Fetch atomically from the caller's perspective: no consumer sees partial rows. */
export async function collectSchedule(
  fetchPage: (cursor: string | null) => Promise<SchedulePage>,
): Promise<{ header: ScheduleHeader; rows: ScheduleRow[] }> {
  const rows: ScheduleRow[] = [];
  let cursor: string | null = null;
  let header: ScheduleHeader | undefined;
  const seen = new Set<string>();
  for (
    let page = 0;
    page <= Math.ceil(MAX_EXPORT_ROWS / EXPORT_PAGE_SIZE);
    page++
  ) {
    const result = await fetchPage(cursor);
    if (!result || result.page.length > EXPORT_PAGE_SIZE)
      throw new Error("Invalid export page");
    if (header && JSON.stringify(result.planHeader) !== JSON.stringify(header))
      throw new Error("Plan changed during export; retry");
    header = result.planHeader;
    rows.push(...result.page);
    if (rows.length > MAX_EXPORT_ROWS)
      throw new Error("Export exceeds 500 rows");
    if (result.isDone) return { header, rows };
    if (!result.continueCursor || seen.has(result.continueCursor))
      throw new Error("Export cursor did not advance");
    seen.add(result.continueCursor);
    cursor = result.continueCursor;
  }
  throw new Error("Export page limit exceeded");
}

function cell(value: string | number | undefined): string {
  const text = String(value ?? "");
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
export function scheduleCsv(
  header: ScheduleHeader,
  rows: ScheduleRow[],
  filters: ScheduleFilters,
): string {
  const lines: (string | number | undefined)[][] = [
    [
      "Plan",
      `${header.assigneeName} · ${header.localMonth} · v${header.version}`,
      "Status",
      header.status,
      "Version",
      header.version,
    ],
    ["Manila month", header.localMonth, "Assignee", header.assigneeName],
    [
      "Prepared by",
      header.preparedByName,
      "Prepared at",
      manilaMinute(header.preparedAt),
    ],
    [
      "Submitted by",
      header.submittedByName,
      "Submitted at",
      manilaMinute(header.submittedAt),
    ],
    [
      "Approved by",
      header.approvedByName,
      "Approved at",
      manilaMinute(header.approvedAt),
      "Signed hash prefix",
      header.signedHashPrefix,
    ],
    [
      "Territory filter",
      filters.territoryId
        ? (filters.territoryLabel ?? "Selected territory")
        : "All",
      "Route filter",
      filters.routeId ? (filters.routeLabel ?? "Selected route") : "All",
      "Visit status filter",
      filters.visitStatus ? coverageStatusLabel(filters.visitStatus) : "All",
    ],
    [
      "Service date",
      "Stop",
      "Kind",
      "Outlet code",
      "Outlet / activity",
      "Territory",
      "Route",
      "Visit status",
      "Duration (min)",
    ],
    ...rows.map((row) => [
      row.serviceDate,
      row.sequence,
      slotKindLabel(row.kind),
      row.outletCode,
      row.name,
      row.territoryCode,
      row.routeCode,
      row.visitStatus ? coverageStatusLabel(row.visitStatus) : "",
      row.durationMinutes,
    ]),
  ];
  return `\uFEFF${lines.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
