import {
  formatCasesPieces,
  splitCasesPieces,
  toBaseQty,
  type CasesPieces,
} from "../qty-cases-pieces";

/** Shapes returned by GET /api/v1/inventory/transfers/list and /transfers/detail. Quantities are base pieces. */
export type TransferAllocation = {
  id: string;
  batchId: string | null;
  batch: string | null;
  expiresAt: number | null;
  held: boolean;
  dispatchedBase: number;
  receivedGoodBase: number;
  receivedDamagedBase: number;
  receivedHoldBase: number;
  remainingBase: number;
  shortBase: number;
  overBase: number;
};
export type TransferLine = {
  id: string;
  productId: string;
  code: string;
  name: string;
  stockStatus: string;
  basePerCase: number | null;
  requestedBase: number;
  approvedBase: number;
  pickedBase: number;
  dispatchedBase: number;
  receivedGoodBase: number;
  receivedDamagedBase: number;
  receivedHoldBase: number;
  shortBase: number;
  overBase: number;
  reasonCode: string | null;
  allocations: TransferAllocation[];
};
type Place = { id: string; code: string; name: string; type: string } | null;
type Person = { id: string; name: string | null } | null;
export type TransferStatus =
  | "draft"
  | "requested"
  | "approved"
  | "picking"
  | "dispatched"
  | "partially_received"
  | "received"
  | "review_needed"
  | "closed"
  | "cancelled";
export type Transfer = {
  id: string;
  number: string;
  type: string;
  typeLabel: string;
  status: TransferStatus;
  source: Place;
  destination: Place;
  inTransit: Place;
  header: {
    driverName: string | null;
    vehiclePlate: string | null;
    receiverName: string | null;
    note: string | null;
    sourceRef: string | null;
  };
  people: Record<
    | "requestedBy"
    | "approvedBy"
    | "pickedBy"
    | "dispatchedBy"
    | "receivedBy"
    | "closedBy",
    Person
  >;
  dates: Record<string, string | null>;
  varianceStatus: "none" | "open" | "resolved" | "auto_accepted" | "recount";
  /** IP-INT3: each time a supervisor sent the count back to the receiving side. */
  recounts?: Array<{
    round: number;
    reason: string;
    requestedBy: { id: string; name: string | null };
    requestedAt: string;
    answeredAt: string | null;
  }>;
  recountOpen?: boolean;
  varianceValueCentavos: number;
  lineCount: number;
  lines: TransferLine[];
  resolutions?: Array<{
    id: string;
    auto: boolean;
    chargeTo: string;
    shortBase: number;
    overBase: number;
    valueCentavos: number;
    note: string | null;
  }>;
};
export type TransferSummary = Omit<Transfer, "lines" | "resolutions"> & {
  lines?: undefined;
};

/** The single next step for a document: one primary action, in plain words. */
export type NextStep = {
  command: "approve" | "pick" | "dispatch" | "receive" | "resolve-variance";
  label: string;
} | null;

export function nextStep(status: TransferStatus): NextStep {
  switch (status) {
    case "requested":
      return { command: "approve", label: "Approve and hold the stock" };
    case "approved":
      return { command: "pick", label: "Start picking" };
    case "picking":
      return { command: "dispatch", label: "Dispatch to truck or store" };
    case "dispatched":
    case "partially_received":
      return { command: "receive", label: "Receive" };
    case "review_needed":
      return { command: "resolve-variance", label: "Decide the difference" };
    default:
      return null;
  }
}

/** Open differences in words: "Short 2 cs · Damaged 1 cs · Over 6 pc". */
export function varianceText(t: Pick<Transfer, "lines">): string {
  const parts: string[] = [];
  for (const l of t.lines) {
    const bits = [
      ["Short", l.shortBase],
      ["Damaged", l.receivedDamagedBase],
      ["Over", l.overBase],
    ] as const;
    for (const [label, n] of bits)
      if (n > 0)
        parts.push(
          `${l.name}: ${label.toLowerCase()} ${formatCasesPieces(n, l.basePerCase)}`,
        );
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------- receive grid

export type ReceiveRow = {
  key: string;
  lineId: string;
  batchId: string | null;
  name: string;
  batch: string | null;
  expiresAt: number | null;
  held: boolean;
  basePerCase: number | null;
  dispatchedBase: number;
  /** What has already been counted in. */
  alreadyBase: number;
  remainingBase: number;
  good: CasesPieces;
  damaged: CasesPieces;
  reason: string;
  reasonNeedsPhoto: boolean;
  photoCount: number;
};

/** One row per batch still to arrive; "everything arrived" is pre-filled, the receiver changes what is different. */
export function receiveRows(t: Pick<Transfer, "lines">): ReceiveRow[] {
  const rows: ReceiveRow[] = [];
  for (const l of t.lines)
    for (const a of l.allocations) {
      if (a.remainingBase <= 0) continue;
      rows.push({
        key: a.id,
        lineId: l.id,
        batchId: a.batchId,
        name: l.name,
        batch: a.batch,
        expiresAt: a.expiresAt,
        held: a.held,
        basePerCase: l.basePerCase,
        dispatchedBase: a.dispatchedBase,
        alreadyBase:
          a.receivedGoodBase + a.receivedDamagedBase + a.receivedHoldBase,
        remainingBase: a.remainingBase,
        good: splitCasesPieces(a.remainingBase, l.basePerCase),
        damaged: { cases: 0, pieces: 0 },
        reason: "",
        reasonNeedsPhoto: false,
        photoCount: 0,
      });
    }
  return rows;
}

export const rowGood = (r: ReceiveRow) => toBaseQty(r.good, r.basePerCase);
export const rowDamaged = (r: ReceiveRow) =>
  toBaseQty(r.damaged, r.basePerCase);
/** Still not here after this receipt. */
export const rowMissing = (r: ReceiveRow) =>
  Math.max(0, r.remainingBase - rowGood(r) - rowDamaged(r));
/** More than was sent. */
export const rowExtra = (r: ReceiveRow) =>
  Math.max(0, rowGood(r) + rowDamaged(r) - r.remainingBase);

export function receiveProblems(rows: ReceiveRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (rowDamaged(r) > 0 && !r.reason)
      out.push(`${r.name}: choose why some are damaged.`);
    if (rowDamaged(r) > 0 && r.reasonNeedsPhoto && r.photoCount < 1)
      out.push(`${r.name}: take a photo of the damaged items.`);
  }
  return out;
}

/** Body for POST /api/v1/inventory/transfers/receive. `final` closes out what did not arrive as short. */
export function receivePayload(
  transferId: string,
  rows: ReceiveRow[],
  final: boolean,
) {
  return {
    transferId,
    final,
    lines: rows
      .filter((r) => rowGood(r) > 0 || rowDamaged(r) > 0)
      .map((r) => ({
        lineId: r.lineId,
        ...(r.batchId ? { batchId: r.batchId } : {}),
        receivedGoodBase: rowGood(r),
        receivedDamagedBase: rowDamaged(r),
        ...(rowDamaged(r) > 0
          ? { reasonCode: r.reason, photoCount: r.photoCount }
          : {}),
      })),
  };
}

/** Days until expiry, for the batch countdown ("(41 days)"); null when there is no expiry. */
export function daysToExpiry(expiresAt: number | null, now = Date.now()) {
  if (expiresAt == null) return null;
  return Math.ceil((expiresAt - now) / 86_400_000);
}

// ---------------------------------------------------------------- variance resolution

export const CHARGE_OPTIONS = [
  { value: "dispatch_side", label: "Sending side (the depot)" },
  { value: "receive_side", label: "Receiving side" },
  { value: "carrier", label: "Carrier" },
  { value: "driver", label: "Driver" },
] as const;

/** What is still open on the document, in base pieces. */
export function openDifferences(t: Pick<Transfer, "lines">) {
  let shortBase = 0,
    overBase = 0,
    damagedBase = 0;
  for (const l of t.lines) {
    shortBase += l.shortBase;
    overBase += l.overBase;
    damagedBase += l.receivedDamagedBase;
  }
  return { shortBase, overBase, damagedBase };
}

export type ResolveForm = {
  chargeTo: string;
  shortReason: string;
  shortNeedsNote: boolean;
  overReason: string;
  overNeedsNote: boolean;
  note: string;
};
export const emptyResolveForm = (): ResolveForm => ({
  chargeTo: "",
  shortReason: "",
  shortNeedsNote: false,
  overReason: "",
  overNeedsNote: false,
  note: "",
});

export function resolveProblems(
  t: Pick<Transfer, "lines">,
  f: ResolveForm,
): string[] {
  const { shortBase, overBase } = openDifferences(t);
  const out: string[] = [];
  if ((shortBase > 0 || overBase > 0) && !f.chargeTo)
    out.push("Say who carries the difference.");
  if (shortBase > 0 && !f.shortReason)
    out.push("Choose a reason for what is short.");
  if (overBase > 0 && !f.overReason)
    out.push("Choose a reason for what is over.");
  const needsNote =
    (shortBase > 0 && f.shortNeedsNote) || (overBase > 0 && f.overNeedsNote);
  if (needsNote && !f.note.trim()) out.push("Add a short note.");
  return out;
}

/** Body for POST /api/v1/inventory/transfers/resolve-variance. */
export function resolvePayload(
  t: Pick<Transfer, "lines"> & { id: string },
  f: ResolveForm,
) {
  const { shortBase, overBase } = openDifferences(t);
  return {
    transferId: t.id,
    ...(f.chargeTo ? { chargeTo: f.chargeTo } : {}),
    ...(shortBase > 0 ? { shortReasonCode: f.shortReason } : {}),
    ...(overBase > 0 ? { overReasonCode: f.overReason } : {}),
    ...(f.note.trim() ? { note: f.note.trim() } : {}),
  };
}

export const FILTERS = [
  { id: "open", label: "Open", query: { open: "1" } },
  { id: "in_transit", label: "In transit", query: { status: "in_transit" } },
  {
    id: "review_needed",
    label: "Needs a decision",
    query: { status: "review_needed" },
  },
  { id: "closed", label: "Closed", query: { status: "closed" } },
] as const;
export type FilterId = (typeof FILTERS)[number]["id"];
