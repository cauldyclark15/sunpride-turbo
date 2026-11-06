import { describe, expect, it } from "vitest";
import {
  applyScan,
  approveHint,
  draftFromLine,
  entryFromDraft,
  groupByBin,
  isCounted,
  percent,
  planBody,
  toleranceChip,
  type CountLine,
  type CountReview,
  type Draft,
  type PlanForm,
  type ReviewLine,
} from "./model";

const qty = (base: number, per: number | null = 48) => ({
  base,
  cases: per ? Math.floor(base / per) : null,
  pieces: per ? base % per : base,
  display: "",
  basePerCase: per,
  basePerPiece: 1,
});

const line = (o: Partial<CountLine> = {}): CountLine => ({
  id: "l1",
  locationId: null,
  bin: "B-01",
  productId: "p1",
  code: "SP-001",
  name: "Corned beef 150g",
  lotId: null,
  lotNumber: null,
  expiresAt: null,
  stockStatus: "available",
  source: "plan",
  basePerCase: 48,
  basePerPiece: 1,
  counted: null,
  countedAt: null,
  finding: null,
  note: null,
  photoFileId: null,
  needsRecount: false,
  recountNote: null,
  ...o,
});

describe("draft <-> API", () => {
  it("starts idle for an uncounted line and saved for a counted one", () => {
    expect(draftFromLine(line()).state).toBe("idle");
    const d = draftFromLine(line({ counted: qty(100) }));
    expect(d).toMatchObject({ cases: 2, pieces: 4, state: "saved" });
    // A line sent back for recount has no number yet.
    expect(draftFromLine(line({ counted: null, needsRecount: true })).state).toBe("idle");
  });

  it("turns cases + pieces into base units and clears an empty note", () => {
    const d: Draft = { cases: 3, pieces: 5, finding: "damaged", note: "  ", photoFileId: "f1", state: "editing" };
    expect(entryFromDraft(line(), d, "op-1")).toEqual({
      lineId: "l1",
      countedBase: 149,
      finding: "damaged",
      note: null,
      photoFileId: "f1",
      clientOpId: "op-1",
    });
    // No case size: pieces only.
    expect(
      entryFromDraft(line({ basePerCase: null }), { ...d, cases: 0, pieces: 7 }, "op").countedBase,
    ).toBe(7);
  });

  it("says a line is counted only once a number is saved or being saved", () => {
    expect(isCounted(line(), undefined)).toBe(false);
    expect(isCounted(line({ counted: qty(1) }), undefined)).toBe(true);
    expect(isCounted(line({ counted: qty(1), needsRecount: true }), undefined)).toBe(false);
    const d = draftFromLine(line());
    expect(isCounted(line(), { ...d, state: "editing" })).toBe(false);
    expect(isCounted(line(), { ...d, state: "saving" })).toBe(true);
  });
});

describe("scan", () => {
  const lines = [
    line({ id: "a", code: "SP-001" }),
    line({ id: "b", code: "SP-002", name: "Tuna" }),
  ];
  it("adds one piece per scan and carries pieces into cases", () => {
    const first = applyScan(lines, {}, "sp-001 ");
    expect("draft" in first && first.draft.pieces).toBe(1);
    if (!("draft" in first)) throw new Error("expected a draft");
    const at47 = { a: { ...first.draft, cases: 0, pieces: 47, state: "saved" as const } };
    const next = applyScan(lines, at47, "SP-001");
    expect("draft" in next && next.draft).toMatchObject({ cases: 1, pieces: 0, state: "editing" });
  });
  it("tells the counter in words when the code is not on the count", () => {
    const r = applyScan(lines, {}, "999");
    expect("error" in r && r.error).toContain("not on this count");
    expect("error" in applyScan(lines, {}, "  ")).toBe(true);
  });
  it("won't guess between two batches", () => {
    const two = [
      line({ id: "a", lotNumber: "L1" }),
      line({ id: "b", lotNumber: "L2" }),
    ];
    const r = applyScan(two, {}, "SP-001");
    expect("error" in r && r.error).toContain("more than one batch");
  });
});

describe("lists", () => {
  it("groups consecutive lines under their bin", () => {
    const g = groupByBin([{ bin: "B-01" }, { bin: "B-01" }, { bin: "B-02" }]);
    expect(g.map((x) => [x.bin, x.lines.length])).toEqual([["B-01", 2], ["B-02", 1]]);
  });
  it("percent never exceeds 100 or divides by zero", () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(150, 300)).toBe(50);
    expect(percent(5, 3)).toBe(100);
  });
});

const rl = (o: Partial<ReviewLine> = {}): ReviewLine => ({
  ...line({ counted: qty(10) }),
  decision: null,
  auto: false,
  reasonCode: null,
  reviewNote: null,
  countedBy: "u1",
  recountCount: 0,
  tolerance: { within: false, reason: "over" },
  ...o,
});

describe("review words", () => {
  it("names each state in plain words", () => {
    expect(toleranceChip(rl({ decision: "accepted", auto: true }))).toEqual({ label: "Accepted automatically", tone: "good" });
    expect(toleranceChip(rl({ decision: "accepted" })).label).toBe("Accepted");
    expect(toleranceChip(rl({ decision: "rejected" })).label).toBe("Left out of the count");
    expect(toleranceChip(rl({ decision: "recount" })).tone).toBe("warn");
    expect(toleranceChip(rl()).label).toContain("Needs your decision");
    expect(toleranceChip(rl()).tone).toBe("bad");
    expect(toleranceChip(rl({ tolerance: { within: false, reason: "no_cost" } })).label).toContain("No cost on file");
    expect(toleranceChip(rl({ tolerance: { within: true, reason: "exact" } })).label).toBe("Matches the books");
  });

  const summary = (o: Partial<CountReview["summary"]> = {}): CountReview["summary"] => ({
    total: 10, counted: 10, withDifference: 3, autoAccepted: 1, needsReview: 0, accepted: 0, rejected: 0, recount: 0,
    shortCentavos: 0, overCentavos: 0, netCentavos: 0, unpricedLines: 0, ...o,
  });
  it("explains what blocks the approval", () => {
    expect(approveHint(summary())).toBeNull();
    expect(approveHint(summary({ needsReview: 1 }))).toBe("1 line needs your decision first.");
    expect(approveHint(summary({ needsReview: 4 }))).toBe("4 lines need your decision first.");
    expect(approveHint(summary({ recount: 2, needsReview: 4 }))).toBe("2 lines are waiting for a recount.");
  });
});

describe("plan form", () => {
  const base: PlanForm = {
    locationId: "loc", title: " ", mode: "everything", includeSublocations: false, binFrom: "", binTo: "",
    fastDays: 30, fastTop: 50, search: "", category: "", assignedTo: "", blindCount: true, scheduledFor: "",
  };
  it("everything is a full count, blind by default, without empty fields", () => {
    expect(planBody(base)).toEqual({ locationId: "loc", includeSublocations: false, scope: {}, countType: "full", blindCount: true });
  });
  it("a bin range is a cycle count that includes the bins", () => {
    expect(planBody({ ...base, mode: "bins", binFrom: "B-02", binTo: "B-09", assignedTo: "u9", scheduledFor: "2026-11-09", title: "Row B" })).toEqual({
      locationId: "loc", title: "Row B", includeSublocations: true, scope: { binFrom: "B-02", binTo: "B-09" },
      countType: "cycle", blindCount: true, assignedTo: "u9", scheduledFor: "2026-11-09",
    });
  });
  it("fast movers and filters carry only what was filled in", () => {
    expect(planBody({ ...base, mode: "fast", fastDays: 7, fastTop: 20 }).scope).toEqual({ fastMovers: { days: 7, top: 20 } });
    expect(planBody({ ...base, mode: "filter", search: " pork ", category: "" }).scope).toEqual({ search: "pork" });
  });
});
