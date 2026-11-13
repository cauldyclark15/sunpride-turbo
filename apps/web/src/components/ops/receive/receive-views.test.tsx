import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/lib/api/provider";
import { ApiStore } from "@/lib/api/store";
import { line } from "../transfers/transfer-fixtures";
import { receiveProblems, receiveRows } from "../transfers/transfer-model";
import {
  ReceiveDeliveryView,
  ReceiveGrid,
  ReceiveQueue,
  ReceiveQueueView,
  emptyHeader,
  newLine,
  type ReceiveQueueData,
} from ".";

const wrap = (node: ReactElement, store = new ApiStore()) =>
  renderToStaticMarkup(createElement(ApiProvider, { store }, node));

const queue: ReceiveQueueData = {
  expectedDeliveries: [],
  expectedDeliveriesNote: "No purchase orders are linked yet.",
  inboundTransfers: [
    {
      id: "t1",
      number: "TRF-CEB-261106-0012",
      type: "depot_transfer",
      status: "dispatched",
      from: "Cebu main depot",
      to: "Mandaue store",
      toLocationId: "mandaue",
      driverName: "Juan Dela Cruz",
      vehiclePlate: "ABC 1234",
      dispatchedAt: "2026-11-06T05:30:00Z",
      lineCount: 3,
      dispatchedBase: 960,
      receivedBase: 0,
      waitingForDecision: false,
    },
    {
      id: "t2",
      number: "TRF-CEB-261106-0013",
      type: "depot_transfer",
      status: "review_needed",
      from: "Cebu main depot",
      to: "Mandaue store",
      toLocationId: "mandaue",
      driverName: null,
      vehiclePlate: null,
      dispatchedAt: null,
      lineCount: 1,
      dispatchedBase: 48,
      receivedBase: 47,
      waitingForDecision: true,
    },
  ],
  vanLoadIns: [
    {
      observationId: "o1",
      tripId: "trip1",
      tripNumber: "TRIP-0042",
      truck: "Van ABC-1234",
      countedAt: "2026-11-06T09:00:00Z",
      status: "waiting_for_clerk",
    },
  ],
  locations: [],
};

describe("Receive queue", () => {
  it("shows inbound transfers, trucks back, and an Add delivery button", () => {
    const html = wrap(
      createElement(ReceiveQueueView, {
        data: queue,
        onOpenTransfer: vi.fn(),
        onUnplanned: vi.fn(),
      }),
    );
    expect(html).toContain("Add delivery");
    expect(html).not.toContain("Unplanned delivery");
    expect(html.indexOf("Add delivery")).toBeLessThan(html.indexOf("Expected deliveries"));
    expect(html).toContain("TRF-CEB-261106-0012");
    expect(html).toContain("Cebu main depot → Mandaue store");
    expect(html).toContain("driver Juan Dela Cruz");
    expect(html).toContain("ABC 1234");
    expect(html).toContain("In transit");
    expect(html).toContain("Van ABC-1234 is back");
    expect(html).toContain("Receive truck stock");
    expect(html).toContain("See difference");
    expect(html).toContain("waiting for a supervisor");
    expect(html).toContain("No purchase orders are linked yet.");
  });
  it("reads the queue from the API store", () => {
    const store = new ApiStore();
    store.setData(["inventory", "receive", "queue"], queue);
    const html = wrap(
      createElement(ReceiveQueue, {
        onOpenTransfer: vi.fn(),
        onUnplanned: vi.fn(),
      }),
      store,
    );
    expect(html).toContain("TRF-CEB-261106-0012");
    expect(
      wrap(
        createElement(ReceiveQueue, {
          onOpenTransfer: vi.fn(),
          onUnplanned: vi.fn(),
        }),
      ),
    ).toContain("Loading");
  });
});

describe("Receive grid for a transfer", () => {
  const rows = receiveRows({ lines: [line()] });
  const base = {
    onChange: vi.fn(),
    final: false,
    onFinalChange: vi.fn(),
    onReceive: vi.fn(),
  };
  it("shows what was sent in cases, the batch countdown and 'All here' by default", () => {
    const html = wrap(
      createElement(ReceiveGrid, { ...base, rows, problems: [] }),
    );
    expect(html).toContain("Longganisa 500 g");
    expect(html).toContain("Batch B-100");
    expect(html).toContain("10 cs");
    expect(html).toContain("Arrived good");
    expect(html).toContain("Arrived damaged");
    expect(html).toContain("All here");
    expect(html).not.toContain("That is everything");
  });
  it("shows what is missing and offers to close it out as short", () => {
    const short = rows.map((r) => ({ ...r, good: { cases: 8, pieces: 0 } }));
    const html = wrap(
      createElement(ReceiveGrid, {
        ...base,
        rows: short,
        problems: [],
        final: true,
      }),
    );
    expect(html).toContain("Not here:");
    expect(html).toContain("2 cs");
    expect(html).toContain(
      "That is everything. Count what did not arrive as short.",
    );
    expect(html).toContain("Receive and close out");
  });
  it("shows extra stock as over, and a held batch goes On hold, not refused", () => {
    const over = rows.map((r) => ({
      ...r,
      held: true,
      good: { cases: 10, pieces: 6 },
    }));
    const html = wrap(
      createElement(ReceiveGrid, { ...base, rows: over, problems: [] }),
    );
    // EDGE-030 (r6): an auto-accepted over must not be promised to a supervisor.
    expect(html).not.toContain("only after a supervisor decides");
    expect(html).toContain("Inside the allowed difference it is added to your stock at once");
    expect(html).toContain("recorded as over");
    expect(html).toContain("This batch goes On hold, it is not refused.");
  });
  it("lists plain-word problems and disables Receive until they are fixed", () => {
    const damaged = rows.map((r) => ({
      ...r,
      good: { cases: 9, pieces: 0 },
      damaged: { cases: 1, pieces: 0 },
    }));
    const problems = receiveProblems(damaged);
    const html = wrap(
      createElement(ReceiveGrid, { ...base, rows: damaged, problems }),
    );
    expect(html).toContain("choose why some are damaged.");
    expect(html).toContain("Why damaged");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Receive/);
  });
});

describe("Receive delivery grid", () => {
  const product = {
    id: "p1",
    code: "LONG-500",
    name: "Longganisa 500 g",
    tracking: "lot",
    units: { basePerCase: 48 },
  };
  const props = {
    header: { ...emptyHeader("depot"), supplierName: "Mekeni Foods" },
    onHeader: vi.fn(),
    onLines: vi.fn(),
    locations: [
      { id: "depot", code: "CEB", name: "Cebu main depot", type: "warehouse" },
    ],
    matches: [],
    query: "",
    onQuery: vi.fn(),
    onScan: vi.fn(),
    onAdd: vi.fn(),
    onPost: vi.fn(),
  };
  it("has the header, a scan field, and one Post", () => {
    const html = wrap(
      createElement(ReceiveDeliveryView, {
        ...props,
        lines: [],
        problems: ["Enter the delivery receipt number."],
      }),
    );
    expect(html).toContain("Delivery receipt no.");
    expect(html).toContain("PO reference");
    expect(html).toContain("Supplier");
    expect(html).toContain("Scan a barcode or type a name");
    expect(html).toContain("Post delivery");
    expect(html).toContain("0</span> lines");
  });
  it("shows batch and expiry for lot products, rejected with a reason, and the count of lines", () => {
    const l = {
      ...newLine(product),
      accepted: { cases: 2, pieces: 0 },
      rejected: { cases: 0, pieces: 3 },
    };
    const html = wrap(
      createElement(ReceiveDeliveryView, {
        ...props,
        lines: [l],
        matches: [product],
        query: "long",
        problems: ["Longganisa 500 g: enter the batch number."],
      }),
    );
    expect(html).toContain("Batch number");
    expect(html).toContain("Expiry date");
    expect(html).toContain("Rejected");
    expect(html).toContain("Why rejected");
    expect(html).toContain("1</span> line");
    expect(html).toContain("1 with rejects");
    expect(html).toContain("LONG-500");
    expect(html).toContain("enter the batch number.");
  });
  it("does not ask for batch and expiry on products that are not tracked by batch", () => {
    const html = wrap(
      createElement(ReceiveDeliveryView, {
        ...props,
        lines: [newLine({ ...product, tracking: "none" })],
        problems: [],
      }),
    );
    expect(html).not.toContain("Batch number");
  });
});

describe("WEB-098/WEB-070: a posted delivery stays confirmed", () => {
  it("shows Delivery posted with the receipt number and a way back", async () => {
    const { DeliveryPostedView } = await import(".");
    const html = renderToStaticMarkup(
      createElement(DeliveryPostedView, {
        number: "RCV-SMP-DEPOT-261111-0001",
        onAnother: () => {},
        onDone: () => {},
      }),
    );
    expect(html).toContain("Delivery posted");
    expect(html).toContain("Posted as RCV-SMP-DEPOT-261111-0001");
    expect(html).toContain("Receive another delivery");
    expect(html).toContain("Back to To receive");
  });
});
