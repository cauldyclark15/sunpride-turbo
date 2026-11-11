/**
 * Stock counts v2 (SPEC 4.3, 4.8): data shapes the API returns, and the small pure rules the screens share.
 * Everything here is plain TypeScript so it can be tested without a browser.
 */
import type { CasesPieces } from "../qty-cases-pieces";
import {
  splitCasesPieces,
  stepCasesPieces,
  toBaseQty,
} from "../qty-cases-pieces";

export const COUNTS_PATH = "/api/v1/inventory/counts";
/** Every read of a count lives under this key; invalidating it refreshes all count screens. */
export const COUNTS_KEY = ["inventory", "counts"] as const;

/** A quantity as the API sends it. */
export type Qty = {
  base: number;
  cases: number | null;
  pieces: number | null;
  display: string;
  basePerCase: number | null;
  basePerPiece: number | null;
};

export type Finding =
  | "damaged"
  | "expired"
  | "wrong_location"
  | "wrong_lot"
  | "over"
  | "missing";

/** What a counter may flag on a line. */
export const FINDING_CHOICES: { value: Finding; label: string }[] = [
  { value: "damaged", label: "Damaged" },
  { value: "expired", label: "Expired" },
  { value: "wrong_location", label: "Wrong place" },
  { value: "wrong_lot", label: "Wrong batch" },
];

export const FINDING_LABEL: Record<Finding, string> = {
  damaged: "Damaged",
  expired: "Expired",
  wrong_location: "Wrong place",
  wrong_lot: "Wrong batch",
  over: "Found extra",
  missing: "Missing",
};

export type CountStatus =
  | "planned"
  | "counting"
  | "submitted"
  | "posted"
  | "cancelled";

export type CountCard = {
  id: string;
  number: string;
  title: string | null;
  status: CountStatus;
  blindCount: boolean;
  countType: string;
  locationId: string;
  location: string | null;
  scope: string;
  scheduledFor: string | null;
  submittedAt: number | null;
  createdAt: number;
  progress: {
    total: number;
    counted: number;
    recount: number;
    needsReview: number;
  };
};

export type MyCounts = { mine: CountCard[]; toReview: CountCard[] };

export type CountLine = {
  id: string;
  locationId: string | null;
  bin: string;
  productId: string;
  code: string;
  name: string;
  lotId: string | null;
  lotNumber: string | null;
  expiresAt: number | null;
  stockStatus: string;
  source: "plan" | "found";
  basePerCase: number | null;
  basePerPiece: number | null;
  counted: Qty | null;
  countedAt: number | null;
  finding: Finding | null;
  note: string | null;
  photoFileId: string | null;
  needsRecount: boolean;
  recountNote: string | null;
  /** Only when the viewer may see what the books say (never on a blind count for the counter). */
  expected?: Qty;
  variance?: Qty | null;
  diffCentavos?: number | null;
  unitCostKnown?: boolean;
};

export type CountHead = {
  session: {
    id: string;
    number: string;
    title: string | null;
    status: CountStatus;
    blindCount: boolean;
    locationId: string;
    scope: string;
  };
  progress: { total: number; counted: number; recount: number };
  canSeeExpected: boolean;
  lines: CountLine[];
  nextCursor: string | null;
};

export type ReviewLine = CountLine & {
  decision: "accepted" | "rejected" | "recount" | null;
  auto: boolean;
  reasonCode: string | null;
  reviewNote: string | null;
  countedBy: string | null;
  recountCount: number;
  tolerance: { within: boolean; reason: ToleranceReason };
};

export type ToleranceReason =
  | "exact"
  | "within"
  | "over"
  | "no_cost"
  | "not_counted";

export type CountReview = {
  session: {
    id: string;
    number: string;
    title: string | null;
    status: CountStatus;
    blindCount: boolean;
    locationId: string;
    scope: string;
    submittedAt: number | null;
  };
  canSeeExpected: boolean;
  canApprove: boolean;
  /** Set when this person may decide lines but an approver must post the difference. */
  approveBlockedReason?: string | null;
  tolerance: {
    maxCentavos: number | null;
    maxPieces: number | null;
    isDefault: boolean;
  };
  summary: {
    total: number;
    counted: number;
    withDifference: number;
    autoAccepted: number;
    needsReview: number;
    accepted: number;
    rejected: number;
    recount: number;
    shortCentavos: number;
    overCentavos: number;
    netCentavos: number;
    unpricedLines: number;
  };
  lines: ReviewLine[];
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------------------------
// Counting drafts
// ---------------------------------------------------------------------------------------------

export type SaveState = "idle" | "editing" | "saving" | "saved" | "error";

/** What the counter has typed for one line, before and after it is sent. */
export type Draft = {
  cases: number;
  pieces: number;
  finding: Finding | null;
  note: string;
  photoFileId: string | null;
  state: SaveState;
};

export function draftFromLine(line: CountLine): Draft {
  const counted = line.counted
    ? splitCasesPieces(line.counted.base, line.basePerCase)
    : { cases: 0, pieces: 0 };
  return {
    ...counted,
    finding: line.finding,
    note: line.note ?? "",
    photoFileId: line.photoFileId,
    // idle = nobody has put a number on this line yet.
    state: line.counted && !line.needsRecount ? "saved" : "idle",
  };
}

/** The body entry for counts/save-lines. Empty note and finding are sent as null so they can be cleared. */
export function entryFromDraft(
  line: Pick<CountLine, "id" | "basePerCase">,
  draft: Draft,
  clientOpId: string,
) {
  return {
    lineId: line.id,
    countedBase: toBaseQty(
      { cases: draft.cases, pieces: draft.pieces },
      line.basePerCase,
    ),
    finding: draft.finding,
    note: draft.note.trim() || null,
    photoFileId: draft.photoFileId,
    clientOpId,
  };
}

/** A line the counter has put a number on (saved before, or typed and saved now). */
export function isCounted(line: CountLine, draft: Draft | undefined): boolean {
  if (draft) return draft.state === "saved" || draft.state === "saving";
  return line.counted != null && !line.needsRecount;
}

/** One scan adds one piece to the matching line, never guesses between two. */
export function applyScan(
  lines: CountLine[],
  drafts: Record<string, Draft>,
  scanned: string,
): { lineId: string; draft: Draft } | { error: string } {
  const code = scanned.trim().toLowerCase();
  if (!code) return { error: "Scan or type a product code." };
  const hits = lines.filter((l) => l.code.toLowerCase() === code);
  const first = hits[0];
  if (!first)
    return {
      error: `${scanned.trim()} is not on this count. Use “Found item” to add it.`,
    };
  const line = hits.find((l) => drafts[l.id]?.state !== "saving") ?? first;
  if (hits.length > 1 && new Set(hits.map((l) => l.lotNumber)).size > 1)
    return {
      error: `${line.name} has more than one batch here. Tap the batch you are counting.`,
    };
  const base = drafts[line.id] ?? draftFromLine(line);
  const next = stepCasesPieces(
    { cases: base.cases, pieces: base.pieces },
    "pieces",
    1,
    line.basePerCase,
  );
  return { lineId: line.id, draft: { ...base, ...next, state: "editing" } };
}

export type CountTab = "todo" | "counted" | "recount" | "found" | "all";
export const COUNT_TABS: { value: CountTab; label: string }[] = [
  { value: "todo", label: "To count" },
  { value: "counted", label: "Counted" },
  { value: "recount", label: "Recount" },
  { value: "found", label: "Found items" },
  { value: "all", label: "All" },
];

/** Bin headers in bin order; lines keep the order the API gave them. */
export function groupByBin<T extends { bin: string }>(lines: T[]) {
  const groups: { bin: string; lines: T[] }[] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (last && last.bin === line.bin) last.lines.push(line);
    else groups.push({ bin: line.bin, lines: [line] });
  }
  return groups;
}

export const percent = (done: number, total: number) =>
  total <= 0 ? 0 : Math.min(100, Math.round((done / total) * 100));

// ---------------------------------------------------------------------------------------------
// Review words
// ---------------------------------------------------------------------------------------------

/** The chip next to a line in review, in plain words. */
export function toleranceChip(line: ReviewLine): {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
} {
  if (line.decision === "rejected")
    return { label: "Left out of the count", tone: "neutral" };
  if (line.decision === "recount")
    return { label: "Waiting for a recount", tone: "warn" };
  if (line.auto && line.decision === "accepted")
    return { label: "Accepted automatically", tone: "good" };
  if (line.decision === "accepted")
    return { label: "Accepted", tone: "good" };
  switch (line.tolerance.reason) {
    case "exact":
      return { label: "Matches the books", tone: "good" };
    case "within":
      return { label: "Small difference", tone: "good" };
    case "no_cost":
      return { label: "No cost on file. Needs your decision", tone: "warn" };
    case "over":
      return { label: "Bigger than allowed. Needs your decision", tone: "bad" };
    default:
      return { label: "Not counted yet", tone: "neutral" };
  }
}

/** True while at least one line still needs the reviewer. */
export const reviewBlockers = (s: CountReview["summary"]) => ({
  needsReview: s.needsReview,
  recount: s.recount,
  ready: s.needsReview === 0 && s.recount === 0,
});

/** What the approve button says when it cannot be pressed yet. */
export function approveHint(s: CountReview["summary"]): string | null {
  if (s.recount)
    return `${s.recount} ${s.recount === 1 ? "line is" : "lines are"} waiting for a recount.`;
  if (s.needsReview)
    return `${s.needsReview} ${s.needsReview === 1 ? "line needs" : "lines need"} your decision first.`;
  return null;
}

export type { CasesPieces };

/** Plan form -> API body. `null` fields are left out so the server defaults apply. */
export type PlanForm = {
  locationId: string;
  title: string;
  mode: "everything" | "bins" | "fast" | "filter";
  includeSublocations: boolean;
  binFrom: string;
  binTo: string;
  fastDays: number;
  fastTop: number;
  search: string;
  category: string;
  assignedTo: string;
  blindCount: boolean;
  scheduledFor: string;
};

export function planBody(f: PlanForm) {
  const scope: Record<string, unknown> = {};
  if (f.mode === "bins") {
    if (f.binFrom.trim()) scope.binFrom = f.binFrom.trim();
    if (f.binTo.trim()) scope.binTo = f.binTo.trim();
  }
  if (f.mode === "fast")
    scope.fastMovers = { days: f.fastDays, top: f.fastTop };
  if (f.mode === "filter") {
    if (f.search.trim()) scope.search = f.search.trim();
    if (f.category.trim()) scope.category = f.category.trim();
  }
  return {
    locationId: f.locationId,
    ...(f.title.trim() ? { title: f.title.trim() } : {}),
    includeSublocations: f.mode === "bins" ? true : f.includeSublocations,
    scope,
    countType: f.mode === "everything" ? "full" : "cycle",
    blindCount: f.blindCount,
    ...(f.assignedTo ? { assignedTo: f.assignedTo } : {}),
    ...(f.scheduledFor ? { scheduledFor: f.scheduledFor } : {}),
  };
}
