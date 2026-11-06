import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/lib/api/provider";
import { ApiStore } from "@/lib/api/store";
import {
  TransferDetailView,
  TransfersList,
  TransfersListView,
  VarianceResolutionView,
} from ".";
import {
  emptyResolveForm,
  resolvePayload,
  resolveProblems,
  type Transfer,
  type TransferSummary,
} from "./transfer-model";
import { line } from "./transfer-fixtures";

const wrap = (node: ReactElement, store = new ApiStore()) =>
  renderToStaticMarkup(createElement(ApiProvider, { store }, node));

const base = (o: Partial<Transfer> = {}): Transfer => ({
  id: "t1",
  number: "TRF-CEB-261106-0012",
  type: "depot_transfer",
  typeLabel: "Depot transfer",
  status: "dispatched",
  source: { id: "a", code: "CEB", name: "Cebu main depot", type: "warehouse" },
  destination: {
    id: "b",
    code: "MDE",
    name: "Mandaue store",
    type: "warehouse",
  },
  inTransit: null,
  header: {
    driverName: "Juan Dela Cruz",
    vehiclePlate: "ABC 1234",
    receiverName: "Maria Santos",
    note: null,
    sourceRef: null,
  },
  people: {
    requestedBy: { id: "u1", name: "Ana Clerk" },
    approvedBy: { id: "u2", name: "Pedro Boss" },
    pickedBy: null,
    dispatchedBy: { id: "u1", name: "Ana Clerk" },
    receivedBy: null,
    closedBy: null,
  },
  dates: {},
  varianceStatus: "none",
  varianceValueCentavos: 0,
  lineCount: 1,
  lines: [line()],
  ...o,
});
const noop = () => {};
const detail = (t: Transfer) =>
  wrap(
    createElement(TransferDetailView, {
      transfer: t,
      onCommand: noop,
      dispatchHeader: { driverName: "", vehiclePlate: "", receiverName: "" },
      onDispatchHeader: noop,
    }),
  );

describe("Transfers list", () => {
  const summary = (o: Partial<TransferSummary>): TransferSummary => ({
    ...base(),
    lines: undefined,
    ...o,
  });
  it("shows number, status, route, and the value of an open difference", () => {
    const html = wrap(
      createElement(TransfersListView, {
        transfers: [
          summary({}),
          summary({
            id: "t2",
            number: "TRF-CEB-261106-0013",
            status: "review_needed",
            varianceStatus: "open",
            varianceValueCentavos: 96000,
          }),
        ],
        filter: "open",
        onFilter: noop,
        onOpen: noop,
      }),
    );
    expect(html).toContain("TRF-CEB-261106-0012");
    expect(html).toContain("In transit");
    expect(html).toContain("Needs review");
    expect(html).toContain("Cebu main depot → Mandaue store");
    expect(html).toContain("₱960.00");
    for (const f of ["Open", "In transit", "Needs a decision", "Closed"])
      expect(html).toContain(f);
  });
  it("reads the list from the API store by filter", () => {
    const store = new ApiStore();
    store.setData(["inventory", "transfers", "list", "open"], {
      transfers: [summary({})],
    });
    const html = wrap(createElement(TransfersList, { onOpen: noop }), store);
    expect(html).toContain("TRF-CEB-261106-0012");
  });
  it("says so when nothing matches", () => {
    const html = wrap(
      createElement(TransfersListView, {
        transfers: [],
        filter: "closed",
        onFilter: noop,
        onOpen: noop,
      }),
    );
    expect(html).toContain("No transfers match");
  });
});

describe("Transfer detail", () => {
  it("shows the dispatch header and one primary action for each state", () => {
    const expected: Record<string, string> = {
      requested: "Approve and hold the stock",
      approved: "Start picking",
      picking: "Dispatch to truck or store",
      dispatched: "Receive",
      partially_received: "Receive",
      review_needed: "Decide the difference",
    };
    for (const [status, label] of Object.entries(expected)) {
      const html = detail(base({ status: status as Transfer["status"] }));
      expect(html).toContain(label);
    }
    const html = detail(base());
    expect(html).toContain("Juan Dela Cruz");
    expect(html).toContain("ABC 1234");
    expect(html).toContain("Maria Santos");
    expect(html).toContain("Sent by");
    expect(html).not.toContain(">Cancel<"); // in transit cannot be cancelled
    expect(detail(base({ status: "closed" }))).not.toContain("Start picking");
  });
  it("lets the clerk edit driver, plate and receiver only before dispatch, and cancel before dispatch", () => {
    const html = detail(base({ status: "picking" }));
    expect(html).toContain("Vehicle plate");
    expect(html).toContain("Cancel");
  });
  it("shows every quantity in cases and pieces with the batch countdown", () => {
    const html = detail(
      base({
        lines: [
          line({
            receivedGoodBase: 384,
            receivedDamagedBase: 48,
            shortBase: 48,
            overBase: 6,
          }),
        ],
      }),
    );
    expect(html).toContain("10 cs");
    expect(html).toContain("8 cs");
    expect(html).toContain("1 cs");
    expect(html).toContain("6 pc");
    expect(html).toContain("Batch B-100");
    expect(html).toContain("days)");
  });
  it("flags an open difference and a decision already made", () => {
    const open = detail(
      base({
        status: "review_needed",
        varianceStatus: "open",
        varianceValueCentavos: 96000,
      }),
    );
    expect(open).toContain("difference waiting for a decision");
    expect(open).toContain("₱960.00");
    const done = detail(
      base({
        status: "closed",
        varianceStatus: "resolved",
        resolutions: [
          {
            id: "r1",
            auto: false,
            chargeTo: "driver",
            shortBase: 96,
            overBase: 0,
            valueCentavos: 192000,
            note: "Two cases not on the truck",
          },
        ],
      }),
    );
    expect(done).toContain("Charged to driver");
    expect(done).toContain("short 96 pc written off");
    expect(done).toContain("Two cases not on the truck");
  });
});

describe("Variance resolution", () => {
  const t = base({
    status: "review_needed",
    varianceStatus: "open",
    varianceValueCentavos: 96000,
    lines: [line({ shortBase: 96, overBase: 6, receivedDamagedBase: 48 })],
  });
  it("asks who carries it and why, in plain words", () => {
    const problems = resolveProblems(t, emptyResolveForm());
    expect(problems).toEqual([
      "Say who carries the difference.",
      "Choose a reason for what is short.",
      "Choose a reason for what is over.",
    ]);
    const html = wrap(
      createElement(VarianceResolutionView, {
        transfer: t,
        form: emptyResolveForm(),
        onForm: noop,
        problems,
        onResolve: noop,
      }),
    );
    expect(html).toContain("Who carries the difference");
    expect(html).toContain("Sending side (the depot)");
    expect(html).toContain("Carrier");
    expect(html).toContain("Why it is short");
    expect(html).toContain("Why it is over");
    expect(html).toContain("₱960.00");
    expect(html).toContain("short");
    expect(html).toContain("Clear the difference and close");
    expect(html).toMatch(/<button[^>]*disabled/);
  });
  it("builds the resolve body once it is complete", () => {
    const form = {
      ...emptyResolveForm(),
      chargeTo: "driver",
      shortReason: "SHORT-TRANSIT",
      overReason: "COUNT-ERR",
      overNeedsNote: true,
    };
    expect(resolveProblems(t, form)).toEqual(["Add a short note."]);
    expect(
      resolvePayload(t, { ...form, note: " Recounted at the dock " }),
    ).toEqual({
      transferId: "t1",
      chargeTo: "driver",
      shortReasonCode: "SHORT-TRANSIT",
      overReasonCode: "COUNT-ERR",
      note: "Recounted at the dock",
    });
  });
  it("only damaged items: nothing to charge, one button to confirm", () => {
    const damagedOnly = base({
      status: "review_needed",
      lines: [line({ receivedDamagedBase: 48 })],
    });
    expect(resolveProblems(damagedOnly, emptyResolveForm())).toEqual([]);
    expect(resolvePayload(damagedOnly, emptyResolveForm())).toEqual({
      transferId: "t1",
    });
    const html = wrap(
      createElement(VarianceResolutionView, {
        transfer: damagedOnly,
        form: emptyResolveForm(),
        onForm: noop,
        problems: [],
        onResolve: vi.fn(),
      }),
    );
    expect(html).toContain("Only damaged items");
    expect(html).toContain("Confirm and close");
  });
});
