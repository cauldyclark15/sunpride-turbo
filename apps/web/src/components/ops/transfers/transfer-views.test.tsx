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
import { matchTransfer } from "./transfers-list";
import {
  AddTransferFormView,
  addTransferPayload,
  addTransferProblems,
  emptyAddTransfer,
} from "./add-transfer";

vi.mock("@/lib/auth", () => ({
  usePermissions: () => ({ can: () => true }),
}));
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/operations/transfers",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

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
  const view = (o: Partial<Parameters<typeof TransfersListView>[0]> = {}) =>
    wrap(
      createElement(TransfersListView, {
        transfers: [summary({})],
        filter: null,
        onFilter: noop,
        onAdd: noop,
        ...o,
      }),
    ).replaceAll("&amp;", "&");
  it("shows number, status, route, and the value of an open difference", () => {
    const html = view({
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
    });
    expect(html).toContain("TRF-CEB-261106-0012");
    expect(html).toContain("In transit");
    expect(html).toContain("Needs review");
    expect(html).toContain("Cebu main depot → Mandaue store");
    expect(html).toContain("₱960.00");
    for (const f of ["All", "Open", "In transit", "Needs a decision", "Closed"])
      expect(html).toContain(f);
  });
  it("puts Add transfer in the header row, before the list", () => {
    const html = view();
    const add = html.indexOf('data-testid="list-add"');
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(html.indexOf('data-testid="list-table"'));
    expect(html).toContain("Add transfer");
    expect(html).toContain("Search by number, place or driver");
  });
  it("hides Add for people who may not add transfers", () => {
    expect(view({ onAdd: undefined })).not.toContain("Add transfer");
  });
  it("each row opens the transfer and shows a visible Edit", () => {
    const html = view();
    expect(html).toContain('href="/operations/transfers/t1"');
    expect(html).toMatch(/>Edit</);
  });
  it("searches as you type across number, place and driver", () => {
    const t = summary({});
    expect(matchTransfer(t, "mandaue")).toBe(true);
    expect(matchTransfer(t, "juan")).toBe(true);
    expect(matchTransfer(t, "0012")).toBe(true);
    expect(matchTransfer(t, "iloilo")).toBe(false);
    const html = view({ q: "iloilo" });
    expect(html).toContain("No transfer named “iloilo”");
  });
  it("pages 50 at a time", () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      summary({ id: `t${i}`, number: `TRF-${i}` }),
    );
    const html = view({ transfers: many, page: 3 });
    expect(html).toContain("Showing 101–120 of 120 transfers");
    expect(html).toContain('data-testid="list-pages"');
  });
  it("empty list offers Add transfer instead of only another filter", () => {
    const html = view({ transfers: [], filter: "closed" });
    expect(html).toContain("No transfers yet");
    expect(html).toContain('data-testid="list-add-named"');
    expect(html).not.toContain("Try another filter");
  });
  it("reads filter, search and page from the URL", async () => {
    nav.params = new URLSearchParams("filter=open&q=mandaue");
    const store = new ApiStore();
    store.setData(["inventory", "transfers", "list", "open"], {
      transfers: [summary({}), summary({ id: "t9", number: "TRF-X", destination: { id: "z", code: "ILO", name: "Iloilo", type: "warehouse" } })],
    });
    const html = wrap(createElement(TransfersList, {}), store);
    expect(html).toContain("TRF-CEB-261106-0012");
    expect(html).not.toContain("TRF-X");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Open/);
    nav.params = new URLSearchParams();
  });
});

describe("Add transfer form", () => {
  const places = [
    { id: "a", code: "CEB", name: "Cebu main depot", type: "warehouse", active: true },
    { id: "b", code: "MDE", name: "Mandaue store", type: "warehouse", active: true },
    { id: "tr", code: "TRN", name: "In transit", type: "in_transit", active: true },
  ];
  const products = [
    { id: "p", code: "SP1", name: "Ube 1L", units: { basePerCase: 12, basePerPiece: 1 } as never },
  ];
  it("says why Save is off, one line", () => {
    expect(addTransferProblems(emptyAddTransfer, places, products)[0]).toBe(
      "Pick where it comes from.",
    );
    expect(
      addTransferProblems({ ...emptyAddTransfer, source: "a", destination: "a", productId: "p", cases: "1" }, places, products),
    ).toContain("From and To must be different.");
    expect(addTransferProblems(emptyAddTransfer, places.slice(0, 2), products)).toContain(
      "Set up an in-transit place first.",
    );
  });
  it("sends the same request the old /inventory form sent", () => {
    const form = { source: "a", destination: "b", productId: "p", cases: "2", pieces: "3" };
    expect(addTransferProblems(form, places, products)).toEqual([]);
    expect(addTransferPayload(form, places, products)).toEqual({
      sourceLocationId: "a",
      destinationLocationId: "b",
      inTransitLocationId: "tr",
      lines: [{ productId: "p", quantityBase: 27 }],
    });
  });
  it("uses Save and Cancel and never offers the in-transit place", () => {
    const html = wrap(
      createElement(AddTransferFormView, {
        form: emptyAddTransfer,
        onForm: noop,
        places,
        products,
        onSave: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain(">Save<");
    expect(html).toContain(">Cancel<");
    expect(html).not.toContain(">In transit<");
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
  it("IP-INT3: a document sent back for a recount says who asked and why, and still offers Receive", () => {
    const html = detail(
      base({
        status: "partially_received",
        varianceStatus: "recount",
        recountOpen: true,
        recounts: [
          {
            round: 1,
            reason: "Count the last pallet again",
            requestedBy: { id: "u1", name: "Sam Supervisor" },
            requestedAt: "2026-11-06T01:00:00Z",
            answeredAt: null,
          },
        ],
      }),
    );
    expect(html).toContain("asked for the count to be done again");
    expect(html).toContain("Sam Supervisor: Count the last pallet again");
    expect(html).toContain("Receive");
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
