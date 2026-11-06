import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/lib/api/provider";
import { ApiStore } from "@/lib/api/store";
import {
  CountLineCard,
  CountReviewScreen,
  CountScreen,
  MyCounts,
  PlanCount,
  ReviewLineCard,
  ReviewSummary,
  previewQuery,
  expiryText,
  draftFromLine,
  type CountCard,
  type CountHead,
  type CountLine,
  type CountReview,
  type ReviewLine,
} from "./index";

const qty = (base: number, per: number | null = 48) => ({
  base,
  cases: per ? Math.floor(base / per) : null,
  pieces: per ? base % per : base,
  display: "",
  basePerCase: per,
  basePerPiece: 1,
});
const line = (o: Partial<CountLine> = {}): CountLine => ({
  id: "l1", locationId: null, bin: "B-01", productId: "p1", code: "SP-001", name: "Corned beef 150g",
  lotId: null, lotNumber: null, expiresAt: null, stockStatus: "available", source: "plan",
  basePerCase: 48, basePerPiece: 1, counted: null, countedAt: null, finding: null, note: null,
  photoFileId: null, needsRecount: false, recountNote: null, ...o,
});
const reviewLine = (o: Partial<ReviewLine> = {}): ReviewLine => ({
  ...line({ counted: qty(100), expected: qty(148), variance: qty(-48), diffCentavos: 4800 }),
  decision: null, auto: false, reasonCode: null, reviewNote: null, countedBy: "u1", recountCount: 0,
  tolerance: { within: false, reason: "over" }, ...o,
});
const card = (o: Partial<CountCard> = {}): CountCard => ({
  id: "s1", number: "CNT-CEB-261106-0001", title: "Friday fast movers", status: "counting", blindCount: true,
  countType: "cycle", locationId: "loc", location: "Cebu depot", scope: "Fast movers (top 50, last 30 days)",
  scheduledFor: "2026-11-06", submittedAt: null, createdAt: 1, progress: { total: 300, counted: 120, recount: 2, needsReview: 0 }, ...o,
});
const render = (store: ApiStore, el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(ApiProvider, { store }, el));

describe("My counts", () => {
  it("shows the next count with its progress and one big button", () => {
    const store = new ApiStore();
    store.setData(["inventory", "counts", "mine"], { mine: [card()], toReview: [] });
    const html = render(store, createElement(MyCounts, { onOpen: vi.fn() }));
    expect(html).toContain("My counts");
    expect(html).toContain("Friday fast movers");
    expect(html).toContain("Blind count");
    expect(html).toContain("120 of 300 counted");
    expect(html).toContain("2 to recount");
    expect(html).toContain("Continue counting");
    expect(html).toContain("CNT-CEB-261106-0001");
    expect(html).not.toContain("Review count");
  });
  it("says what to do when nothing is waiting, and lists counts to review for a supervisor", () => {
    const store = new ApiStore();
    store.setData(["inventory", "counts", "mine"], {
      mine: [],
      toReview: [card({ id: "s2", status: "submitted", progress: { total: 10, counted: 10, recount: 0, needsReview: 3 } })],
    });
    const html = render(store, createElement(MyCounts, { onOpen: vi.fn(), onReview: vi.fn(), onPlan: vi.fn() }));
    expect(html).toContain("No counts waiting for you");
    expect(html).toContain("Review count");
    expect(html).toContain("3 lines need a decision");
    expect(html).toContain("Plan a count");
  });
  it("starts a fresh count with Start counting", () => {
    const store = new ApiStore();
    store.setData(["inventory", "counts", "mine"], {
      mine: [card({ progress: { total: 5, counted: 0, recount: 0, needsReview: 0 } })],
      toReview: [],
    });
    expect(render(store, createElement(MyCounts, { onOpen: vi.fn() }))).toContain("Start counting");
  });
});

describe("Count line", () => {
  const props = { onChange: vi.fn(), onRetry: vi.fn() };
  it("never shows what the books say when the viewer must not see it", () => {
    const l = line({ expected: qty(96) });
    const html = renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: draftFromLine(l), showExpected: false, ...props }));
    expect(html).not.toContain("Books say");
    expect(html).toContain("Not counted yet");
    expect(html).toContain("None here");
    expect(html).toContain("Something wrong with it?");
  });
  it("shows it on an open count, in cases and pieces", () => {
    const l = line({ expected: qty(100) });
    const html = renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: draftFromLine(l), showExpected: true, ...props }));
    expect(html).toContain("Books say");
    expect(html).toContain("2 cs 4 pc");
  });
  it("shows batch and days left, a found-item chip, and the recount request", () => {
    const l = line({
      lotNumber: "L2", expiresAt: Date.now() + 10 * 86400000 + 3600000, source: "found",
      needsRecount: true, recountNote: "Check the second shelf",
    });
    const html = renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: draftFromLine(l), showExpected: false, ...props }));
    expect(html).toContain("Batch L2");
    expect(html).toMatch(/expires .* \(11 days\)/);
    expect(html).toContain("Found item");
    expect(html).toContain("Please count this again.");
    expect(html).toContain("Check the second shelf");
  });
  it("reports save state and offers a retry when saving failed", () => {
    const l = line({ counted: qty(10) });
    const saved = renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: draftFromLine(l), showExpected: false, ...props }));
    expect(saved).toContain("Saved");
    const failed = renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: { ...draftFromLine(l), state: "error" }, showExpected: false, ...props }));
    expect(failed).toContain("Couldn’t save. Tap to try again");
  });
  it("offers a photo button only when the host can take photos, and the problem choices in plain words", () => {
    const l = line();
    const withPhoto = renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: { ...draftFromLine(l), photoFileId: "f1", finding: "damaged" }, showExpected: false, onPickPhoto: vi.fn(), ...props }));
    expect(withPhoto).toContain("Change photo");
    expect(withPhoto).toContain("Photo added");
    expect(withPhoto).toContain("Problem: Damaged");
    for (const word of ["Damaged", "Expired", "Wrong place", "Wrong batch"]) expect(withPhoto).toContain(word);
    expect(renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: draftFromLine(l), showExpected: false, ...props }))).not.toContain("Add photo");
  });
  it("has 48 px touch targets on the buttons", () => {
    const l = line();
    const html = renderToStaticMarkup(createElement(CountLineCard, { line: l, draft: draftFromLine(l), showExpected: false, ...props }));
    expect(html).toContain("min-h-12");
  });
  it("words an expiry in the past", () => {
    expect(expiryText(null)).toBeNull();
    expect(expiryText(Date.now() - 3 * 86400000)).toMatch(/^expired /);
  });
});

describe("Count screen", () => {
  const head = (o: Partial<CountHead> = {}): CountHead => ({
    session: { id: "s1", number: "CNT-CEB-261106-0001", title: "Friday fast movers", status: "counting", blindCount: true, locationId: "loc", scope: "Fast movers (top 50, last 30 days)" },
    progress: { total: 300, counted: 120, recount: 0 },
    canSeeExpected: false, lines: [], nextCursor: null, ...o,
  });
  const seed = (h: CountHead, lines: CountLine[]) => {
    const store = new ApiStore();
    store.setData(["inventory", "counts", "lines", "s1", "head"], h);
    store.setData(["inventory", "counts", "lines", "s1", { tab: "todo", q: "" }], { pages: [{ items: lines, nextCursor: null }], truncated: false });
    return store;
  };
  it("shows progress, a scan field, bins in order and the finish bar", () => {
    const html = render(
      seed(head(), [line({ id: "a", bin: "B-01" }), line({ id: "b", bin: "B-01", code: "SP-002", name: "Tuna" }), line({ id: "c", bin: "B-02", code: "SP-003", name: "Sausage" })]),
      createElement(CountScreen, { sessionId: "s1" }),
    );
    expect(html).toContain("Friday fast movers");
    expect(html).toContain("120 of 300 counted");
    expect(html).toContain("Blind count");
    expect(html).toContain("Scan or type a product code");
    expect(html.indexOf("Bin B-01")).toBeLessThan(html.indexOf("Bin B-02"));
    expect(html).toContain("Found item");
    expect(html).toContain("180</strong> still to count");
    expect(html).toContain("Leave 180 out and finish");
    expect(html).toContain("Finish counting");
    expect(html).not.toContain("Books say");
  });
  it("disables Finish counting until everything is counted", () => {
    const todo = render(seed(head(), [line()]), createElement(CountScreen, { sessionId: "s1" }));
    expect(todo).toMatch(/<button[^>]*\sdisabled=""[^>]*>Finish counting/);
    const done = render(seed(head({ progress: { total: 300, counted: 300, recount: 0 } }), []), createElement(CountScreen, { sessionId: "s1" }));
    expect(done).toContain("All counted");
    expect(done).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Finish counting/);
    expect(done).not.toContain("out and finish");
  });
  it("shows what the books say on an open count", () => {
    const html = render(
      seed(head({ canSeeExpected: true, session: { ...head().session, blindCount: false } }), [line({ expected: qty(96) })]),
      createElement(CountScreen, { sessionId: "s1" }),
    );
    expect(html).toContain("Books say");
    expect(html).not.toContain("Blind count");
  });
});

describe("Count review", () => {
  const review = (o: Partial<CountReview> = {}): CountReview => ({
    session: { id: "s1", number: "CNT-CEB-261106-0001", title: "Friday fast movers", status: "submitted", blindCount: true, locationId: "loc", scope: "Everything", submittedAt: 1 },
    canSeeExpected: true, canApprove: true,
    tolerance: { maxCentavos: 50000, maxPieces: 2, isDefault: true },
    summary: { total: 300, counted: 300, withDifference: 8, autoAccepted: 294, needsReview: 6, accepted: 0, rejected: 0, recount: 0, shortCentavos: 15500, overCentavos: 100, netCentavos: -15400, unpricedLines: 0 },
    lines: [], nextCursor: null, ...o,
  });
  const seed = (r: CountReview, lines: ReviewLine[]) => {
    const store = new ApiStore();
    store.setData(["inventory", "counts", "review", "s1", "head"], r);
    store.setData(["inventory", "counts", "review", "s1", { filter: "needs_review", sort: "diff" }], { pages: [{ items: lines, nextCursor: null }], truncated: false });
    return store;
  };
  it("leads with the net peso difference and the tolerance in words", () => {
    const html = renderToStaticMarkup(createElement(ReviewSummary, { review: review() }));
    expect(html).toContain("Net difference");
    expect(html).toContain("-₱154.00");
    expect(html).toContain("8 of 300 lines differ from the books");
    expect(html).toContain("up to ₱500.00 and 2 pc a line are accepted automatically");
    expect(html).toContain("Default limit, not confirmed by Sunpride");
  });
  it("warns when some differences have no cost, so the pesos are incomplete", () => {
    expect(renderToStaticMarkup(createElement(ReviewSummary, { review: review({ summary: { ...review().summary, unpricedLines: 2 } }) }))).toContain("2 lines have no cost on file");
  });
  it("lists lines with books, counted, difference and worth, and blocks approval until decided", () => {
    const html = render(seed(review(), [reviewLine(), reviewLine({ id: "l2", code: "SP-002", name: "Tuna", decision: "accepted", auto: true, tolerance: { within: true, reason: "within" } })]), createElement(CountReviewScreen, { sessionId: "s1" }));
    expect(html).toContain("Books say");
    expect(html).toContain("Difference");
    expect(html).toContain("-1 cs");
    expect(html).toContain("-₱48.00");
    expect(html).toContain("Bigger than allowed. Needs your decision");
    expect(html).toContain("Accepted automatically");
    expect(html).toContain("Needs your decision · 6");
    expect(html).toContain("6 lines need your decision first.");
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Approve count/);
    expect(html).toContain("Biggest difference first");
    expect(html).toContain("Recount");
    expect(html).toContain("Leave out");
  });
  it("allows approval once every line is decided", () => {
    const html = render(seed(review({ summary: { ...review().summary, needsReview: 0 } }), []), createElement(CountReviewScreen, { sessionId: "s1" }));
    expect(html).toContain("Every line is decided. Approve to update the stock.");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Approve count/);
  });
  it("tells a counter who opens review that someone else must approve", () => {
    const html = render(seed(review({ canSeeExpected: false, canApprove: false }), []), createElement(CountReviewScreen, { sessionId: "s1" }));
    expect(html).toContain("You counted this one");
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Approve count/);
  });
  it("hides the books-say figures when the viewer may not see them", () => {
    const html = renderToStaticMarkup(createElement(ReviewLineCard, { line: reviewLine(), showExpected: false, canDecide: false, active: null, onOpen: vi.fn(), onClose: vi.fn(), onDecide: vi.fn(), busy: false, error: null }));
    expect(html).not.toContain("Books say");
    expect(html).not.toContain("Worth");
    expect(html).toContain("Counted");
  });
  it("opens the accept form with a reason list, and demands a note to leave a line out", () => {
    const base = { line: reviewLine(), showExpected: true, canDecide: true, onOpen: vi.fn(), onClose: vi.fn(), onDecide: vi.fn(), busy: false, error: null };
    const accept = renderToStaticMarkup(createElement(ApiProvider, { store: new ApiStore() }, createElement(ReviewLineCard, { ...base, active: "accept" })));
    expect(accept).toContain("Why is it different?");
    expect(accept).toContain("Accept this line");
    expect(accept).toMatch(/<button[^>]*\sdisabled=""[^>]*>Accept this line/);
    const reject = renderToStaticMarkup(createElement(ReviewLineCard, { ...base, active: "reject" }));
    expect(reject).toContain("Why leave it out? (required)");
    expect(reject).toMatch(/<button[^>]*\sdisabled=""[^>]*>Leave it out/);
    const recount = renderToStaticMarkup(createElement(ReviewLineCard, { ...base, active: "recount" }));
    expect(recount).toContain("Ask for a recount");
    expect(recount).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Ask for a recount/);
  });
  it("shows the counter’s finding and note, and a found item", () => {
    const html = renderToStaticMarkup(createElement(ReviewLineCard, { line: reviewLine({ finding: "damaged", note: "2 dented", source: "found", photoFileId: "f1" }), showExpected: true, canDecide: false, active: null, onOpen: vi.fn(), onClose: vi.fn(), onDecide: vi.fn(), busy: false, error: null }));
    expect(html).toContain("Damaged");
    expect(html).toContain("Counter’s note: “2 dented”");
    expect(html).toContain("Found item");
    expect(html).toContain("Photo");
  });
});

describe("Plan a count", () => {
  it("offers the four scopes in plain words, blind on by default, and repeat choices", () => {
    const store = new ApiStore();
    store.setData(["inventory", "counts", "places"], [{ id: "loc", code: "CEB", name: "Cebu depot", type: "warehouse", active: true }]);
    const html = render(store, createElement(PlanCount, {}));
    for (const w of ["Plan a count", "Everything", "A range of bins", "Fast movers", "A product filter", "Blind count.", "Every week", "Create count", "Cebu depot"])
      expect(html).toContain(w);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Create count/);
  });
  it("shows how many lines the scope gives before anything is created", () => {
    const store = new ApiStore();
    store.setData(["inventory", "counts", "places"], []);
    store.setData(["inventory", "counts", "counters"], []);
    const q = previewQuery({ locationId: "loc", title: "", mode: "everything", includeSublocations: false, binFrom: "", binTo: "", fastDays: 30, fastTop: 50, search: "", category: "", assignedTo: "", blindCount: true, scheduledFor: "" });
    store.setData(["inventory", "counts", "preview", q], { lines: 134, products: 120, places: 4, tooLarge: false, scope: "Everything" });
    const html = render(store, createElement(PlanCount, { initialLocationId: "loc" }));
    expect(html).toContain("134 lines · 120 products · 4 places");
  });
  it("builds the preview query only from the fields the chosen scope uses", () => {
    const form = { locationId: "loc", title: "", mode: "bins" as const, includeSublocations: false, binFrom: "B-01", binTo: "B-09", fastDays: 30, fastTop: 50, search: "pork", category: "", assignedTo: "", blindCount: true, scheduledFor: "" };
    expect(previewQuery(form)).toMatchObject({ includeSublocations: "1", binFrom: "B-01", binTo: "B-09", search: undefined, fastMovers: undefined });
    expect(previewQuery({ ...form, mode: "fast", fastDays: 7, fastTop: 5 })).toMatchObject({ fastMovers: "1", days: "7", top: "5", binFrom: undefined });
  });
});
