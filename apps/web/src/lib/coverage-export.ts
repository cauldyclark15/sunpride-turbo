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
    ["Plan", header.planId, "Status", header.status, "Version", header.version],
    ["Manila month", header.localMonth, "Assignee", header.assigneeName],
    ["Prepared by", header.preparedByName, "Prepared at", header.preparedAt],
    [
      "Submitted by",
      header.submittedByName,
      "Submitted at",
      header.submittedAt,
    ],
    [
      "Approved by",
      header.approvedByName,
      "Approved at",
      header.approvedAt,
      "Signed hash prefix",
      header.signedHashPrefix,
    ],
    [
      "Territory filter",
      filters.territoryId ?? "All",
      "Route filter",
      filters.routeId ?? "All",
      "Visit status filter",
      filters.visitStatus ?? "All",
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
      row.kind,
      row.outletCode,
      row.name,
      row.territoryCode,
      row.routeCode,
      row.visitStatus,
      row.durationMinutes,
    ]),
  ];
  return `\uFEFF${lines.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
