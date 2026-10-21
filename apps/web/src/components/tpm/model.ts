import type { EvidenceSnapshot } from "./claim-evidence-preview";
export type Campaign = {
  id: string;
  versionId: string;
  version: number;
  code: string;
  name: string;
  mechanic: string;
  status: string;
  effectiveFrom: number;
  effectiveTo: number;
  scope: Record<string, { include?: string[]; exclude?: string[] }>;
  checklist: string[];
  budgetCentavos: number;
  committedCentavos: number;
  expectedVolumeBase: number;
  expectedRoiBps: number;
  source: string;
};
export type Claim = {
  productId?: string;
  quantityUnits?: number;
  uom?: string;
  id: string;
  reference: string;
  partyType: string;
  partyName: string;
  type: string;
  status: string;
  amountCentavos: number;
  periodFrom: string;
  periodTo: string;
  createdAt: number;
};
export type Summary = {
  asOf: number;
  budgetCentavos: number;
  committedCentavos: number;
  claimsAwaitingEvidence: number;
  claimsAwaitingApproval: number;
  rejectionBps: number | null;
  claimsCurrentCentavos: number;
  claimsPriorCentavos: number;
  trend: { date: string; amountCentavos: number }[];
};
export type Options = {
  parties?: { id: string; name: string; type: string }[];
  territories?: { id: string; code: string; name: string }[];
  products: { id: string; code: string; name: string; uom: string }[];
  outlets: { id: string; code: string; name: string }[];
  people: { id: string; name: string }[];
  evidence: {
    id: string;
    label: string;
    kind: string;
    snapshot?: EvidenceSnapshot;
    photoUrl?: string;
  }[];
  evidenceTruncated?: boolean;
};
export type Liability = {
  id: string;
  campaignVersionId: string;
  campaignName: string;
  promotionName: string;
  accountKey: string;
  earnedCentavos: number;
  reversedCentavos: number;
  releasedCentavos: number;
  openCentavos: number | null;
  operationalOpenCentavos: number;
  acknowledgedEarnedCentavos: number;
  acknowledgedReversedCentavos: number;
  pendingSap: boolean;
};
export type Deduction = {
  id: string;
  accountKey: string;
  classification: string;
  ownerName: string;
  amountCentavos: number;
  recoveredCentavos: number;
  writtenOffCentavos: number;
  ageDays: number;
  status: string;
};
export type Roi = {
  id: string;
  campaignName: string;
  accountKey: string;
  mechanic: string;
  baselineVolumeBase: number;
  promotedVolumeBase: number;
  incrementalVolumeBase: number;
  netRoiBps: number | null;
  grossRoiBps: number | null;
  spendCentavos: number;
  directional: boolean;
};
export type Policies = {
  types: { id: string; code: string; required_evidence: string[] }[];
  approvals: {
    id: string;
    name: string;
    min_centavos: string;
    max_centavos: string;
    source: string;
  }[];
};
export type Incentives = {
  adjustments?: {
    id: string;
    statement_id: string;
    amount_centavos: number | string;
    reason: string;
    status: string;
  }[];
  plans: { id: string; name: string }[];
  statements: {
    id: string;
    personName: string;
    planName: string;
    status: string;
    amountCentavos: number;
    periodFrom: string;
    periodTo: string;
    result: {
      lines: {
        metric: string;
        actual: number | null;
        target: number | null;
        excluded?: boolean;
        amountCentavos: number;
      }[];
    };
  }[];
};
export const peso = (n: number | null | undefined) =>
  n == null
    ? "Unknown"
    : new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        maximumFractionDigits: 2,
      }).format(n / 100);
export const words = (s: string) =>
  s.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
export const day = (n: number) =>
  new Date(n + 8 * 3600_000).toISOString().slice(0, 10);
/** Exact decimal pesos -> centavos, never binary float multiplication. */
export function centavos(v: FormDataEntryValue | null) {
  if (typeof v !== "string" || !/^\d+(\.\d{1,2})?$/.test(v))
    throw new Error("Enter pesos with at most two decimals.");
  const [whole, part = ""] = v.split(".");
  const n = Number(BigInt(whole!) * 100n + BigInt(part.padEnd(2, "0")));
  if (!Number.isSafeInteger(n)) throw new Error("Amount is too large.");
  return n;
}
export function signedCentavos(v: FormDataEntryValue | null) {
  if (typeof v !== "string") throw new Error("Enter an adjustment amount");
  return v.startsWith("-") ? -centavos(v.slice(1)) : centavos(v);
}
