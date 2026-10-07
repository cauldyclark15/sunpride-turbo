/**
 * SOP-012 admin report pack: pure totals and CSV builders for the web. The server returns
 * one row per person per page (`analytics/admin_reports.day`); everything here adds pages
 * up and formats them. Definitions: docs/architecture/ADMIN_REPORT_PACK.md.
 */

export type AdminPackRow = {
  profileId: string;
  name: string;
  employeeCode: string | null;
  positionLabel: string | null;
  channel: string;
  sellingDay: boolean;
  manday: boolean;
  calls: number;
  productiveCalls: number;
  callsTarget: number | null;
  productiveTargetPct: number | null;
  buyingAccounts: readonly string[];
  osaAudits: number;
  osaRequired: number;
  osaAvailable: number;
  collections: number;
  collectedMinor: number;
};

export type ProgramTally = {
  programRef: string;
  executed: number;
  notExecuted: number;
  notApplicable: number;
};

export type CollectionLine = {
  id: string;
  personName: string;
  customerCode: string;
  customerName: string;
  outletCode: string;
  amountMinor: number;
  currency: string;
  method: string;
  reference: string;
  status: "recorded" | "pending_review";
  at: number;
};

export type AdminPackTotals = {
  people: number;
  mandays: number;
  calls: number;
  productiveCalls: number;
  callsTarget: number;
  /** UBA across the scope: each customer code once, whoever sold to it. */
  uniqueBuyingAccounts: number;
  osaAudits: number;
  osaRequired: number;
  osaAvailable: number;
  collections: number;
  collectedMinor: number;
};

/** Whole percent, rounded down like every other SFA report; null without a base. */
export function ratioPct(part: number, whole: number) {
  return whole > 0 ? Math.floor((part * 100) / whole) : null;
}

export function pctText(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export function pesoText(centavos: number) {
  return peso.format(centavos / 100);
}

/** Plain pesos with two decimals for spreadsheets (no currency sign or grouping). */
export function pesoPlain(centavos: number) {
  return (centavos / 100).toFixed(2);
}

export function packTotals(rows: readonly AdminPackRow[]): AdminPackTotals {
  const accounts = new Set<string>();
  const totals: AdminPackTotals = {
    people: rows.length,
    mandays: 0,
    calls: 0,
    productiveCalls: 0,
    callsTarget: 0,
    uniqueBuyingAccounts: 0,
    osaAudits: 0,
    osaRequired: 0,
    osaAvailable: 0,
    collections: 0,
    collectedMinor: 0,
  };
  for (const row of rows) {
    totals.mandays += Number(row.manday);
    totals.calls += row.calls;
    totals.productiveCalls += row.productiveCalls;
    totals.callsTarget += row.callsTarget ?? 0;
    for (const code of row.buyingAccounts) accounts.add(code);
    totals.osaAudits += row.osaAudits;
    totals.osaRequired += row.osaRequired;
    totals.osaAvailable += row.osaAvailable;
    totals.collections += row.collections;
    totals.collectedMinor += row.collectedMinor;
  }
  totals.uniqueBuyingAccounts = accounts.size;
  return totals;
}

/** Programme tallies from several pages, summed per reference and sorted. */
export function mergePrograms(
  pages: readonly (readonly ProgramTally[])[],
): ProgramTally[] {
  const merged = new Map<string, ProgramTally>();
  for (const page of pages)
    for (const row of page) {
      const sum = merged.get(row.programRef) ?? {
        programRef: row.programRef,
        executed: 0,
        notExecuted: 0,
        notApplicable: 0,
      };
      sum.executed += row.executed;
      sum.notExecuted += row.notExecuted;
      sum.notApplicable += row.notApplicable;
      merged.set(row.programRef, sum);
    }
  return [...merged.values()].sort((a, b) =>
    a.programRef.localeCompare(b.programRef),
  );
}

/** Utilization of a programme: executed over the stores where it applied. */
export function programUtilizationPct(row: ProgramTally) {
  return ratioPct(row.executed, row.executed + row.notExecuted);
}

export function cell(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  // Spreadsheet formula injection guard (same rule as the coverage export and DSR).
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csv(lines: Array<Array<string | number | null>>) {
  return `\uFEFF${lines.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

const ACRONYMS: Array<[string, string]> = [
  ["PC", "Productive Call"],
  ["UBA", "Unique Buying Account"],
  ["OSA", "On Shelf Availability"],
  ["Manday", "One person in the field for one day (checked in at least once)"],
];

/** Daily Productive Calls, UBA, OSA, Mandays as CSV: totals then one row per person. */
export function dailyPackCsv(
  serviceDate: string,
  rows: readonly AdminPackRow[],
): string {
  const t = packTotals(rows);
  return csv([
    ["Daily Productive Calls, UBA, OSA, Mandays", serviceDate],
    ...ACRONYMS.map(([term, meaning]) => [term, meaning]),
    [],
    ["People", t.people],
    ["Mandays", t.mandays],
    ["Calls", t.calls],
    ["Call target", t.callsTarget],
    ["Productive calls", t.productiveCalls],
    ["Productive %", ratioPct(t.productiveCalls, t.calls)],
    ["UBA (unique accounts in scope)", t.uniqueBuyingAccounts],
    ["OSA %", ratioPct(t.osaAvailable, t.osaRequired)],
    [],
    [
      "Employee code",
      "Name",
      "Position",
      "Channel",
      "Selling day",
      "Manday",
      "Calls",
      "Call target",
      "Productive calls",
      "Productive %",
      "Productive target %",
      "UBA",
      "Buying accounts",
      "OSA audits",
      "OSA required SKUs",
      "OSA on shelf",
      "OSA %",
    ],
    ...rows.map((row) => [
      row.employeeCode,
      row.name,
      row.positionLabel,
      row.channel,
      row.sellingDay ? "Yes" : "No",
      row.manday ? 1 : 0,
      row.calls,
      row.callsTarget,
      row.productiveCalls,
      ratioPct(row.productiveCalls, row.calls),
      row.productiveTargetPct,
      row.buyingAccounts.length,
      row.buyingAccounts.join(" "),
      row.osaAudits,
      row.osaRequired,
      row.osaAvailable,
      ratioPct(row.osaAvailable, row.osaRequired),
    ]),
  ]);
}

/** The day's programme checks as CSV; allocation is in the monthly pack. */
export function programsCsv(
  serviceDate: string,
  programs: readonly ProgramTally[],
): string {
  return csv([
    ["Programs utilization (day)", serviceDate],
    ["Allocation", "See the monthly pack: Programs utilization vs allocation"],
    [],
    ["Program", "Executed", "Not executed", "Not applicable", "Utilization %"],
    ...programs.map((row) => [
      row.programRef,
      row.executed,
      row.notExecuted,
      row.notApplicable,
      programUtilizationPct(row),
    ]),
  ]);
}

const STATUS_TEXT = { recorded: "Recorded", pending_review: "Pending review" };

/** Field collections of the day, the collections side of the KAS AR reckoning. */
export function collectionsCsv(
  serviceDate: string,
  lines: readonly CollectionLine[],
): string {
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  return csv([
    ["Collections for Account Receivables reckoning", serviceDate],
    ["AR balance", "See the monthly pack: Account Receivables reckoning"],
    ["Total collected", pesoPlain(total)],
    [],
    [
      "Salesperson",
      "Customer code",
      "Customer",
      "Outlet code",
      "Amount",
      "Currency",
      "Method",
      "Reference",
      "Status",
    ],
    ...lines.map((line) => [
      line.personName,
      line.customerCode,
      line.customerName,
      line.outletCode,
      pesoPlain(line.amountMinor),
      line.currency,
      line.method,
      line.reference,
      STATUS_TEXT[line.status],
    ]),
  ]);
}
