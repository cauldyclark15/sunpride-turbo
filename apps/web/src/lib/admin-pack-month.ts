/**
 * SOP-012 monthly admin report pack: pure figures and CSV builders for the web
 * (`analytics/admin_pack.month`). Programs utilization vs allocation, Priorities, Claims
 * Summary (ADP) and AR reckoning (KAS). Definitions: docs/architecture/ADMIN_REPORT_PACK.md.
 */
import { csv, pesoPlain, ratioPct } from "./admin-reports";

export type PackSource = "sample" | "office" | null;

export type AllocationRow = {
  code: string;
  programRef: string;
  programName: string;
  allocatedStores: number;
  budgetMinor: number;
  executedStores: number;
  executedChecks: number;
  notExecutedChecks: number;
};

export type PriorityDocType =
  "da_contract" | "promo_advice" | "coa" | "sasr" | "br_template";
export type PriorityStatus = "pending" | "submitted" | "approved" | "returned";

export type PriorityRow = {
  code: string;
  docType: PriorityDocType;
  title: string;
  accountName: string;
  ownerName: string;
  dueDate: string;
  status: PriorityStatus;
  submittedDate: string | null;
};

export type ClaimType =
  "display_allowance" | "promo_discount" | "bad_order" | "rebate";
export type ClaimStatus =
  "filed" | "validated" | "approved" | "paid" | "rejected";

export type ClaimRow = {
  code: string;
  partnerCode: string;
  partnerName: string;
  claimType: ClaimType;
  claimRef: string;
  filedDate: string;
  claimedMinor: number;
  approvedMinor: number | null;
  status: ClaimStatus;
};

export type ReceivableRow = {
  code: string;
  customerCode: string;
  customerName: string;
  asOfDate: string;
  termsDays: number;
  currentMinor: number;
  days1to30Minor: number;
  days31to60Minor: number;
  days61to90Minor: number;
  over90Minor: number;
  collectedMinor: number;
  pendingReviewMinor: number;
  customerFound: boolean;
};

export const DOC_TYPE_LABEL: Record<PriorityDocType, string> = {
  da_contract: "D.A. contract",
  promo_advice: "Promo Advice",
  coa: "COA",
  sasr: "SASR",
  br_template: "BR template",
};

export const PRIORITY_STATUS_LABEL: Record<PriorityStatus, string> = {
  pending: "Pending",
  submitted: "Submitted",
  approved: "Approved",
  returned: "Returned",
};

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  display_allowance: "Display allowance",
  promo_discount: "Promo discount",
  bad_order: "Bad order",
  rebate: "Rebate",
};

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  filed: "Filed",
  validated: "Validated",
  approved: "Approved",
  paid: "Paid",
  rejected: "Rejected",
};

/** The memo's short forms, defined at the top of every export (open question #9). */
export const PACK_ACRONYMS: Array<[string, string]> = [
  ["D.A.", "Display Allowance"],
  ["COA", "Calendar of Activity"],
  ["SASR", "Sales Activation Support Request"],
  ["BR", "Business Review"],
  ["ADP", "Area Distribution Partner"],
  ["KAS", "Key Account Specialist"],
  ["AR", "Account Receivables"],
];

export function sourceText(source: PackSource) {
  if (source === "sample")
    return "Sample data (made up for the beta; Sunpride's real data replaces it)";
  if (source === "office") return "Office records";
  return "No records for this month";
}

/** Allocation used: stores where the programme was executed ÷ stores allocated. */
export function allocationUsePct(row: AllocationRow) {
  return ratioPct(row.executedStores, row.allocatedStores);
}

/** A document still owed (pending or returned) after its due date. */
export function priorityOverdue(row: PriorityRow, today: string) {
  return (
    (row.status === "pending" || row.status === "returned") &&
    row.dueDate < today
  );
}

export type PartnerClaims = {
  partnerCode: string;
  partnerName: string;
  claims: number;
  claimedMinor: number;
  approvedMinor: number;
  paidMinor: number;
  /** Filed or validated, not yet decided. */
  openMinor: number;
  rejectedMinor: number;
};

/** Claims Summary per distribution partner, sorted by partner code. */
export function claimsByPartner(rows: readonly ClaimRow[]): PartnerClaims[] {
  const out = new Map<string, PartnerClaims>();
  for (const row of rows) {
    const sum = out.get(row.partnerCode) ?? {
      partnerCode: row.partnerCode,
      partnerName: row.partnerName,
      claims: 0,
      claimedMinor: 0,
      approvedMinor: 0,
      paidMinor: 0,
      openMinor: 0,
      rejectedMinor: 0,
    };
    sum.claims++;
    sum.claimedMinor += row.claimedMinor;
    if (row.status === "approved" || row.status === "paid")
      sum.approvedMinor += row.approvedMinor ?? row.claimedMinor;
    if (row.status === "paid")
      sum.paidMinor += row.approvedMinor ?? row.claimedMinor;
    if (row.status === "filed" || row.status === "validated")
      sum.openMinor += row.claimedMinor;
    if (row.status === "rejected") sum.rejectedMinor += row.claimedMinor;
    out.set(row.partnerCode, sum);
  }
  return [...out.values()].sort((a, b) =>
    a.partnerCode.localeCompare(b.partnerCode),
  );
}

export function openingMinor(row: ReceivableRow) {
  return (
    row.currentMinor +
    row.days1to30Minor +
    row.days31to60Minor +
    row.days61to90Minor +
    row.over90Minor
  );
}

/** Balance after recorded field collections; pending-review collections are not deducted. */
export function remainingMinor(row: ReceivableRow) {
  return openingMinor(row) - row.collectedMinor;
}

/** Past-due part of the opening balance (every bucket after current). */
export function pastDueMinor(row: ReceivableRow) {
  return openingMinor(row) - row.currentMinor;
}

function header(title: string, month: string, source: PackSource) {
  return [
    [title, month],
    ["Data source", sourceText(source)],
    ...PACK_ACRONYMS.map(([term, meaning]) => [term, meaning]),
    [],
  ];
}

export function allocationsCsv(
  month: string,
  rows: readonly AllocationRow[],
  source: PackSource,
) {
  return csv([
    ...header(
      "Programs utilization vs allocation (Promo Advice)",
      month,
      source,
    ),
    [
      "Program",
      "Program name",
      "Allocated stores",
      "Budget",
      "Stores executed",
      "Allocation used %",
      "Executed checks",
      "Not executed checks",
    ],
    ...rows.map((row) => [
      row.programRef,
      row.programName,
      row.allocatedStores,
      pesoPlain(row.budgetMinor),
      row.executedStores,
      allocationUsePct(row),
      row.executedChecks,
      row.notExecutedChecks,
    ]),
  ]);
}

export function prioritiesCsv(
  month: string,
  rows: readonly PriorityRow[],
  today: string,
  source: PackSource,
) {
  return csv([
    ...header("Priorities", month, source),
    [
      "Document",
      "Title",
      "Account",
      "Owner",
      "Due",
      "Status",
      "Submitted",
      "Overdue",
    ],
    ...rows.map((row) => [
      DOC_TYPE_LABEL[row.docType],
      row.title,
      row.accountName,
      row.ownerName,
      row.dueDate,
      PRIORITY_STATUS_LABEL[row.status],
      row.submittedDate,
      priorityOverdue(row, today) ? "Yes" : "No",
    ]),
  ]);
}

export function claimsCsv(
  month: string,
  rows: readonly ClaimRow[],
  source: PackSource,
) {
  return csv([
    ...header("Claims Summary (ADP)", month, source),
    [
      "Partner code",
      "Partner",
      "Claims",
      "Claimed",
      "Approved",
      "Paid",
      "Open",
      "Rejected",
    ],
    ...claimsByPartner(rows).map((row) => [
      row.partnerCode,
      row.partnerName,
      row.claims,
      pesoPlain(row.claimedMinor),
      pesoPlain(row.approvedMinor),
      pesoPlain(row.paidMinor),
      pesoPlain(row.openMinor),
      pesoPlain(row.rejectedMinor),
    ]),
    [],
    [
      "Partner code",
      "Claim reference",
      "Type",
      "Filed",
      "Claimed",
      "Approved",
      "Status",
    ],
    ...rows.map((row) => [
      row.partnerCode,
      row.claimRef,
      CLAIM_TYPE_LABEL[row.claimType],
      row.filedDate,
      pesoPlain(row.claimedMinor),
      row.approvedMinor === null ? "" : pesoPlain(row.approvedMinor),
      CLAIM_STATUS_LABEL[row.status],
    ]),
  ]);
}

export function receivablesCsv(
  month: string,
  rows: readonly ReceivableRow[],
  source: PackSource,
) {
  return csv([
    ...header("Account Receivables reckoning (KAS)", month, source),
    [
      "Customer code",
      "Customer",
      "Balance date",
      "Terms (days)",
      "Current",
      "1-30 days",
      "31-60 days",
      "61-90 days",
      "Over 90 days",
      "Opening balance",
      "Collected in the field",
      "Pending review",
      "Remaining",
    ],
    ...rows.map((row) => [
      row.customerCode,
      row.customerName,
      row.asOfDate,
      row.termsDays,
      pesoPlain(row.currentMinor),
      pesoPlain(row.days1to30Minor),
      pesoPlain(row.days31to60Minor),
      pesoPlain(row.days61to90Minor),
      pesoPlain(row.over90Minor),
      pesoPlain(openingMinor(row)),
      pesoPlain(row.collectedMinor),
      pesoPlain(row.pendingReviewMinor),
      pesoPlain(remainingMinor(row)),
    ]),
  ]);
}
