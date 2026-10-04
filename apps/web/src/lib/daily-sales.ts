/**
 * Annex B "Daily Sales Report" helpers for the web: money, labels, Manila date, CSV. Pure so
 * the Node test runner covers them without a DOM. The server report (dsr/report:day) is
 * authoritative; every amount it returns is in PHP centavos.
 */

export type DsrCallStatus =
  "productive" | "nonproductive" | "open" | "not_visited" | "off_plan";

export type DsrReport = {
  serviceDate: string;
  localMonth: string;
  salesman: {
    name: string;
    employeeCode: string | null;
    position: string | null;
  };
  areaCovered: string[];
  invoiceNumbers: string[];
  sellingDay: boolean;
  sellingDaysInMonth: number;
  targets: {
    daily: number | null;
    dailySource: "set" | "derived_from_monthly" | null;
    monthly: number | null;
    sourceRef: string | null;
  };
  totals: {
    todaySales: number;
    todayPct: number | null;
    mtdSales: number;
    mtdPct: number | null;
    balanceToSell: number | null;
  };
  calls: {
    planned: number;
    calls: number;
    productiveCalls: number;
    productivePct: number | null;
    dailyCallsTarget: number | null;
    productiveCallTargetPct: number | null;
  };
  customers: Array<{
    key: string;
    outletCode: string | null;
    customerCode: string | null;
    name: string;
    inRoutePlan: boolean;
    callStatus: DsrCallStatus | null;
    matchedCodes: string[];
    todaySales: number;
    mtdSales: number;
    invoiceNumbers: string[];
    reasonCode: string | null;
    remarks: string[];
  }>;
  categories: Array<{
    category: string;
    todaySales: number;
    todayQuantity: number;
    mtdSales: number;
    mtdQuantity: number;
  }>;
  programs: Array<{
    programRef: string;
    executed: number;
    notExecuted: number;
    notApplicable: number;
  }>;
};

/** Current Asia/Manila date as YYYY-MM-DD (UTC+08, no DST). */
export function manilaToday(now = Date.now()): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Centavos to "₱1,234.50"; null is a dash. */
export function pesoText(centavos: number | null): string {
  return centavos === null ? "—" : peso.format(centavos / 100);
}

/** Centavos to a plain "1234.50" for spreadsheets. */
export function pesoPlain(centavos: number | null): string {
  return centavos === null ? "" : (centavos / 100).toFixed(2);
}

export function percentText(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

export const CALL_STATUS_LABELS: Record<DsrCallStatus, string> = {
  productive: "Productive",
  nonproductive: "Not productive",
  open: "In progress",
  not_visited: "Not visited",
  off_plan: "Off plan",
};

export function callStatusText(status: DsrCallStatus | null): string {
  return status === null ? "No visit" : CALL_STATUS_LABELS[status];
}

const ACTIVITY_LABELS: Record<string, string> = {
  purchase_order: "PO",
  merchandising: "Merchandising",
  inventory_retrieval: "Inventory",
  suggested_order: "ICO",
  negotiation: "Negotiation",
  bad_order_pickup: "BO pickup",
  collection: "Collection",
  meeting: "Meeting",
};

/** Remarks column: what made the call productive, the reason code, and the notes. */
export function remarksText(row: DsrReport["customers"][number]): string {
  const parts: string[] = [];
  if (row.matchedCodes.length)
    parts.push(
      row.matchedCodes.map((code) => ACTIVITY_LABELS[code] ?? code).join(", "),
    );
  if (row.reasonCode)
    parts.push(`Reason: ${row.reasonCode.replaceAll("_", " ")}`);
  parts.push(...row.remarks);
  return parts.join(" · ");
}

export function dateLabel(serviceDate: string): string {
  const [year, month, day] = serviceDate.split("-").map(Number);
  if (!year || !month || !day) return serviceDate;
  return new Intl.DateTimeFormat("en-PH", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, day));
}

export function dailyTargetNote(report: DsrReport): string {
  if (report.targets.dailySource === "set") return "Daily target";
  if (report.targets.dailySource === "derived_from_monthly")
    return `Monthly target ÷ ${report.sellingDaysInMonth} selling days`;
  if (!report.sellingDay) return "Not a selling day";
  return "No target set";
}

function cell(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  // Spreadsheet formula injection guard (same rule as the coverage export).
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Annex B as CSV: salesman header, totals, customer rows, category, program blocks. */
export function dailySalesCsv(report: DsrReport): string {
  const t = report.totals;
  const lines: Array<Array<string | number | null>> = [
    ["Daily Sales Report (Annex B)", report.serviceDate],
    ["SI number", report.invoiceNumbers.join(" ")],
    ["Salesman", report.salesman.name],
    ["Position", report.salesman.position],
    ["Area covered", report.areaCovered.join(", ")],
    ["Date", report.serviceDate],
    [],
    ["Today's sale", pesoPlain(t.todaySales)],
    ["Today's target", pesoPlain(report.targets.daily)],
    ["Today vs target %", t.todayPct],
    ["MTD performance", pesoPlain(t.mtdSales)],
    ["MTD target", pesoPlain(report.targets.monthly)],
    ["MTD %", t.mtdPct],
    ["MTD balance to sell", pesoPlain(t.balanceToSell)],
    ["Planned calls", report.calls.planned],
    ["Calls", report.calls.calls],
    ["Productive calls", report.calls.productiveCalls],
    ["Productive %", report.calls.productivePct],
    [],
    [
      "Outlet code",
      "Customer code",
      "Customer",
      "In route plan",
      "Call",
      "Today's sale",
      "MTD sale",
      "SI numbers",
      "Remarks",
    ],
    ...report.customers.map((row) => [
      row.outletCode,
      row.customerCode,
      row.name,
      row.inRoutePlan ? "Yes" : "No",
      callStatusText(row.callStatus),
      pesoPlain(row.todaySales),
      pesoPlain(row.mtdSales),
      row.invoiceNumbers.join(" "),
      remarksText(row),
    ]),
    [],
    ["Category", "Today's sale", "Today's qty", "MTD sale", "MTD qty"],
    ...report.categories.map((row) => [
      row.category,
      pesoPlain(row.todaySales),
      row.todayQuantity,
      pesoPlain(row.mtdSales),
      row.mtdQuantity,
    ]),
    [],
    ["Program", "Executed", "Not executed", "Not applicable"],
    ...report.programs.map((row) => [
      row.programRef,
      row.executed,
      row.notExecuted,
      row.notApplicable,
    ]),
  ];
  return `\uFEFF${lines.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
