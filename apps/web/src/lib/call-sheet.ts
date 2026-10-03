/**
 * Annex C "Call Sheet" helpers for the web: labels, Manila month, CSV. Pure so the
 * Node test runner covers them without a DOM. The server report is authoritative.
 */

export const CALL_SHEET_MEASURES = [
  ["order", "Order"],
  ["beginningInventory", "Beginning inventory"],
  ["take", "Take"],
  ["delivered", "Delivered"],
  ["offtake", "Off-take"],
  ["endInventory", "End inventory"],
] as const;
export type CallSheetMeasure = (typeof CALL_SHEET_MEASURES)[number][0];

export const CALL_SHEET_HEADER_LABELS = [
  ["accountName", "Account name"],
  ["address", "Address"],
  ["buyerName", "Buyer name"],
  ["contactNumber", "Contact #"],
  ["accountInCharge", "Account in-charge"],
  ["receivingInCharge", "Receiving in-charge"],
  ["distributorName", "Distributor name"],
  ["distributorSchedule", "Schedule & contact #"],
  ["foc", "FOC"],
  ["pricing", "Pricing"],
] as const;
export type CallSheetHeaderField = (typeof CALL_SHEET_HEADER_LABELS)[number][0];

export type CallSheetWeek = { week: number } & Record<
  CallSheetMeasure,
  number | null
>;
export type CallSheetReport = {
  outlet: { code: string; name: string };
  localMonth: string;
  configured: boolean;
  revision: number | null;
  header: Record<CallSheetHeaderField, string | null> & { accountName: string };
  rows: Array<{
    productId: string;
    code: string;
    name: string;
    uom: string;
    barcode: string | null;
    pricing: string | null;
    onSheet: boolean;
    weeks: CallSheetWeek[];
  }>;
  capturedVisits: number;
  lastCapturedAt: number | null;
};

/** Current Asia/Manila month as YYYY-MM (UTC+08, no DST). */
export function manilaMonth(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 7);
}

export function monthLabel(localMonth: string): string {
  const [year, month] = localMonth.split("-").map(Number);
  if (!year || !month) return localMonth;
  return new Intl.DateTimeFormat("en-PH", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, 1));
}

/** Day ranges of the four Annex C week columns; week 4 runs to month end. */
export function weekRange(localMonth: string, week: number): string {
  const [year, month] = localMonth.split("-").map(Number);
  const last = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const from = (week - 1) * 7 + 1;
  const to = week === 4 ? last : week * 7;
  return `${from}–${to}`;
}

export function quantityText(value: number | null): string {
  return value === null ? "" : String(value);
}

function cell(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  // Spreadsheet formula injection guard (same rule as the coverage export).
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Annex C as CSV: header block, then one row per product with 4 weeks × 6 measures. */
export function callSheetCsv(report: CallSheetReport): string {
  const lines: Array<Array<string | number | null>> = [
    ["Call Sheet (Annex C)", monthLabel(report.localMonth)],
    ["Outlet", `${report.outlet.code} · ${report.outlet.name}`],
    ...CALL_SHEET_HEADER_LABELS.map(([field, label]) => [
      label,
      report.header[field] ?? "",
    ]),
    [],
    [
      "Item barcode",
      "Product description",
      "Product code",
      "UOM",
      "Pricing",
      ...[1, 2, 3, 4].flatMap((week) =>
        CALL_SHEET_MEASURES.map(([, label]) => `Week ${week} ${label}`),
      ),
    ],
    ...report.rows.map((row) => [
      row.barcode,
      row.name,
      row.code,
      row.uom,
      row.pricing,
      ...row.weeks.flatMap((week) =>
        CALL_SHEET_MEASURES.map(([measure]) => week[measure]),
      ),
    ]),
  ];
  return `\uFEFF${lines.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
