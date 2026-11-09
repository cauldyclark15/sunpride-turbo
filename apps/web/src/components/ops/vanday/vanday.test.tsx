import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/lib/api/provider";
import { ApiStore } from "@/lib/api/store";
import {
  PlannedLoadView,
  RosterEditorView,
  VanDayBoardView,
  actionRequest,
  approveAllRequest,
  attentionFor,
  byStage,
  cleanTripIds,
  editPayload,
  emptyRosterForm,
  reasonsFor,
  rosterPayload,
  rosterProblems,
  toggleDay,
  type BoardRow,
  type DayBoard,
  type PlanDetail,
  type PlanLine,
} from ".";

const wrap = (node: ReactElement) =>
  renderToStaticMarkup(createElement(ApiProvider, { store: new ApiStore() }, node));
const noop = () => {};

const row = (o: Partial<BoardRow> & { code?: string } = {}): BoardRow => ({
  vehicleId: `v-${o.code ?? "1"}`,
  vehicleCode: o.code ?? "VAN1",
  plateNumber: "ABC 1234",
  routeName: "Mandaue route",
  tripId: `t-${o.code ?? "1"}`,
  tripNumber: "TRIP-1",
  sellerName: "Sam Seller",
  crew: [
    { profileId: "p1", name: "Sam Seller", role: "seller" },
    { profileId: "p2", name: "Hana Helper", role: "helper" },
  ],
  onPhone: null,
  trip: { status: "planned", label: "Planned", stage: "planned" },
  load: {
    state: "suggested",
    detail: "suggested",
    label: "Suggested",
    number: null,
    products: 2,
    totalBase: 62,
    cases: 5,
    pieces: 2,
    attention: [],
    source: "nightly",
    agreement: null,
    differenceCentavos: 0,
  },
  cash: { expectedCentavos: 125000, salesCentavos: 0, remittedCentavos: null },
  loadIn: null,
  settlement: { status: "open", label: "Not yet" },
  primary: { kind: "approve_load", label: "Approve load", enabled: true, tripId: `t-${o.code ?? "1"}` },
  needsAttention: false,
  ...o,
});
const board = (rows: BoardRow[]): DayBoard => ({
  date: "2026-11-07",
  summary: {
    trucks: rows.length,
    planned: rows.length,
    needAttention: rows.filter((r) => r.needsAttention).length,
    text: `${rows.length} trips planned, ${rows.filter((r) => r.needsAttention).length} need attention`,
    byStage: { planned: rows.length, loaded: 0, on_route: 0, back: 0, settled: 0, closed: 0 },
    lastRun: { at: 1, trigger: "nightly", planned: rows.length, needsAttention: 0 },
  },
  rows,
});

describe("van day model", () => {
  it("groups trucks under the board's columns in order and drops empty ones", () => {
    const rows = [
      row({ code: "A", trip: { status: "active", label: "On route", stage: "on_route" } }),
      row({ code: "B" }),
    ];
    expect(byStage(rows).map((s) => [s.label, s.rows.length])).toEqual([
      ["Planned", 1],
      ["On route", 1],
    ]);
  });
  it("each primary button posts one request, or only opens a screen", () => {
    const at = (kind: BoardRow["primary"]["kind"]) =>
      actionRequest({ primary: { kind, label: "x", enabled: true, tripId: "t1" } }, "2026-11-07");
    expect(at("approve_load")).toEqual({ path: "/api/v1/van/loads/approve-plan", body: { tripIds: ["t1"] } });
    expect(at("pick")).toEqual({ path: "/api/v1/van/loads/pick", body: { tripId: "t1" } });
    expect(at("dispatch")).toEqual({ path: "/api/v1/van/loads/dispatch", body: { tripId: "t1" } });
    expect(at("plan_trip")).toEqual({ path: "/api/v1/van/trips/generate", body: { date: "2026-11-07" } });
    for (const k of ["review_load", "recount", "decide", "view_trip", "wait_seller"] as const)
      expect(at(k)).toBeNull();
  });
  it("only suggested loads with nothing odd are clean to approve in one tap", () => {
    const odd = row({ code: "O" });
    odd.load.attention = ["No sales history for this route and weekday. Copy yesterday or enter a load"];
    const ids = cleanTripIds([row({ code: "A" }), odd, row({ code: "P", load: { ...row().load, state: "approved" } })]);
    expect(ids).toEqual(["t-A"]);
    expect(approveAllRequest(ids).body).toEqual({ tripIds: ["t-A"] });
  });
  it("says why a truck needs a person in plain words", () => {
    const d = row({ code: "D", load: { ...row().load, state: "difference", detail: "disputed" } });
    expect(attentionFor(d)).toContain("Seller and clerk counted differently. A supervisor decides");
    expect(attentionFor(row({ tripId: null }))).toContain("No trip yet for this rostered truck");
  });
  it("gives the reason behind a line, including ship-first and a short depot", () => {
    const l: PlanLine = { productId: "p", code: "LNG", name: "Longganisa", caseBase: 12, averageBase: 35, mustCarryBase: 24, shipFirstBase: 12, onTruckBase: 5, depotAvailableBase: 24, historyTrips: 4, suggestedBase: 36, approvedBase: null, loadBase: 36, edited: false, flags: ["ship_first", "depot_short"] };
    const r = reasonsFor(l);
    expect(r[0]).toBe("Usually sells 35 pc (average of the last 4 same-weekday trips)");
    expect(r).toContain("Ship first: 12 pc of a batch that expires soon");
    expect(r).toContain("5 pc already on the truck");
    expect(r).toContain("The depot only has 24 pc free");
    expect(reasonsFor({ ...l, historyTrips: 0, flags: [] })[0]).toBe("No sales history for this route and weekday");
  });
  it("sends only the lines whose quantity changed, in pieces", () => {
    const l = (id: string, load: number): PlanLine => ({ productId: id, code: id, name: id, caseBase: 12, averageBase: 0, mustCarryBase: 0, shipFirstBase: 0, onTruckBase: 0, depotAvailableBase: 999, historyTrips: 0, suggestedBase: load, approvedBase: null, loadBase: load, edited: false, flags: [] });
    expect(editPayload("t1", [l("a", 24), l("b", 12)], { a: { cases: 3, pieces: 0 }, b: { cases: 1, pieces: 0 } })).toEqual({ tripId: "t1", lines: [{ productId: "a", quantityBase: 36 }] });
  });
  it("roster form: needs a truck, a seller, days, and three different people", () => {
    const f = emptyRosterForm("2026-11-07");
    expect(rosterProblems(f)).toEqual(["Choose the truck", "Choose the seller"]);
    const g = { ...f, vehicleId: "v", sellerProfileId: "s", helperProfileId: "s" };
    expect(rosterProblems(g)).toEqual(["The seller, helper and driver must be different people"]);
    expect(rosterProblems({ ...g, helperProfileId: "h", weekdays: [] })).toEqual(["Pick the days of the week"]);
    expect(rosterPayload({ ...g, helperProfileId: "h" })).toMatchObject({ vehicleId: "v", helperProfileId: "h", driverProfileId: null, routeId: null });
    expect(toggleDay([1, 3], 2)).toEqual([1, 2, 3]);
    expect(toggleDay([1, 2, 3], 2)).toEqual([1, 3]);
  });
});

describe("van day screens", () => {
  it("the board shows the summary sentence, the stage columns, cases + pieces, pesos and one button per truck", () => {
    const html = wrap(
      createElement(VanDayBoardView, {
        board: board([row({ code: "A" }), row({ code: "B", needsAttention: true, load: { ...row().load, state: "difference", detail: "recount", label: "Difference" }, primary: { kind: "recount", label: "Recount the load", enabled: true, tripId: "t-B" } })]),
        onAction: noop,
        onApproveClean: noop,
        onCopyYesterday: noop,
      }),
    );
    expect(html).toContain("2 trips planned, 1 need attention");
    expect(html).toContain("Planned");
    expect(html).toContain("2 products, 5 cs 2 pc");
    expect(html).toContain("Suggested");
    expect(html).toContain("Difference");
    expect(html).toContain("Approve load");
    expect(html).toContain("Recount the load");
    expect(html).toContain("₱1,250.00");
    expect(html).toContain("Approve 1 clean load");
    expect(html).toContain("Copy yesterday");
    expect(html).toContain("The seller counted a difference. The clerk recounts");
    expect(html).not.toMatch(/\bMSL\b|route session|centavos/i);
  });
  it("an empty day says what to do next", () => {
    const html = wrap(createElement(VanDayBoardView, { board: board([]), onAction: noop, onApproveClean: noop, onCopyYesterday: noop }));
    expect(html).toContain("No trucks are rostered for this day.");
    expect(html).toContain("No clean loads to approve");
  });
  it("the suggested load shows each line's reason and edit steppers; an approved load is read-only", () => {
    const line: PlanLine = { productId: "p", code: "LNG", name: "Longganisa 500g", caseBase: 12, averageBase: 35, mustCarryBase: 0, shipFirstBase: 24, onTruckBase: 0, depotAvailableBase: 480, historyTrips: 4, suggestedBase: 36, approvedBase: null, loadBase: 36, edited: false, flags: ["ship_first"] };
    const detail: PlanDetail = { tripId: "t1", tripNumber: "TRIP-1", plan: { id: "pl", state: "suggested", label: "Suggested", source: "copy", attention: ["The depot does not have enough for some products"], agreement: null, clerkName: null }, lines: [line] };
    const open = wrap(createElement(PlannedLoadView, { detail, edits: {}, onEdit: noop, onSave: noop, onApprove: noop, onCopy: noop }));
    expect(open).toContain("Longganisa 500g");
    expect(open).toContain("Ship first");
    expect(open).toContain("Copied from an earlier trip");
    expect(open).toContain("Usually sells 35 pc");
    expect(open).toContain("The depot does not have enough for some products");
    expect(open).toContain("Approve load");
    expect(open).toContain("Save changes");
    const locked = wrap(createElement(PlannedLoadView, { detail: { ...detail, plan: { ...detail.plan!, state: "approved", label: "Approved" } }, edits: {}, onEdit: noop, onSave: noop, onApprove: noop, onCopy: noop }));
    expect(locked).not.toContain("Approve load");
    expect(locked).toContain("3 cs");
    const none = wrap(createElement(PlannedLoadView, { detail: { tripId: "t", plan: null, lines: [] }, edits: {}, onEdit: noop, onSave: noop, onApprove: noop, onCopy: noop }));
    expect(none).toContain("This trip has no suggested load yet.");
  });
  it("IP-INT3: a role that may only read the roster sees the lines and a plain note, no Change, End or form", () => {
    const html = wrap(
      createElement(RosterEditorView, {
        rows: [{ rosterId: "r1", vehicleId: "v1", vehicleCode: "VAN1", plateNumber: "ABC 1234", routeName: "Mandaue route", sellerProfileId: "s", sellerName: "Sam Seller", helperProfileId: null, helperName: null, driverProfileId: null, driverName: null, weekdays: [1, 3, 5], weekdayLabel: "Mon, Wed, Fri", effectiveFrom: "2026-11-01", effectiveTo: null, status: "active" }],
        choices: { vehicles: [], sellers: [], routes: [] },
        readOnly: true,
        form: emptyRosterForm("2026-11-07"),
        onForm: noop,
        onSave: noop,
        onEdit: noop,
        onEnd: noop,
      }),
    );
    expect(html).toContain("Mon, Wed, Fri");
    expect(html).toContain("You can read the roster here.");
    expect(html).not.toContain("Add roster line");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Remove<");
  });
  it("the roster editor lists lines with their days and blocks a bad form with plain reasons", () => {
    const save = vi.fn();
    const html = wrap(
      createElement(RosterEditorView, {
        rows: [{ rosterId: "r1", vehicleId: "v1", vehicleCode: "VAN1", plateNumber: "ABC 1234", routeName: "Mandaue route", sellerProfileId: "s", sellerName: "Sam Seller", helperProfileId: "h", helperName: "Hana Helper", driverProfileId: null, driverName: null, weekdays: [1, 3, 5], weekdayLabel: "Mon, Wed, Fri", effectiveFrom: "2026-11-01", effectiveTo: null, status: "active" }],
        choices: { vehicles: [{ vehicleId: "v1", name: "Van 1", plateNumber: "ABC 1234" }], sellers: [{ profileId: "s", name: "Sam Seller" }], routes: [] },
        form: emptyRosterForm("2026-11-07"),
        onForm: noop,
        onSave: save,
        onEdit: noop,
        onEnd: noop,
      }),
    );
    expect(html).toContain("Mon, Wed, Fri");
    expect(html).toContain("Sam Seller + Hana Helper");
    expect(html).toContain("Choose the truck");
    expect(html).toContain("Choose the seller");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">Edit<");
    expect(html).toContain("from Nov 1");
    expect(html).not.toContain("2026-11-01");
    expect(html.indexOf("Add roster line")).toBeLessThan(html.indexOf("Mon, Wed, Fri"));
    expect(html).toContain(">Save<");
    expect(html).toContain(">Cancel<");
    expect(html).not.toContain(">Change<");
  });
});
