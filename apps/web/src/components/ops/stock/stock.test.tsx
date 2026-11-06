import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "@/lib/api/provider";
import { ApiStore } from "@/lib/api/store";
import { BadOrders } from "./bad-orders";
import { ExpiryBoard } from "./expiry-board";
import { board, card, queue, valuation } from "./fixtures";
import { approvalHint, csvQuery, expiryLabel, expiryTone, missingForRequest } from "./helpers";
import { StockCard } from "./stock-card";
import { StockOnHand } from "./stock-on-hand";
import { formatPeso } from "../peso";

function render(component: unknown, props: Record<string, unknown>, seeds: [unknown[], unknown][]) {
  const store = new ApiStore();
  for (const [key, data] of seeds) store.setData(key as never, data as never);
  return renderToStaticMarkup(createElement(ApiProvider, { store }, createElement(component as never, props as never)));
}

describe("Stock on hand", () => {
  const html = render(StockOnHand, { cardHref: (p: string, l: string) => `/stock/card?productId=${p}&locationId=${l}` }, [
    [["inventory", "valuation", { basis: "cost", groupBy: "product" }], valuation],
  ]);
  it("shows cost value first and selling value as a labelled second column", () => {
    expect(html.indexOf("Value at cost")).toBeGreaterThan(-1);
    const header = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
    expect(header.indexOf("Value at cost")).toBeLessThan(header.indexOf("At selling price"));
    expect(html).toContain("₱660.00"); // corned beef cost
    expect(html).toContain("₱1,200.00"); // corned beef selling, second column
    expect(html).toContain("Stock value at cost");
    expect(html).toContain("₱1,680.00");
  });
  it("shows cases and pieces for every status column", () => {
    for (const label of ["Available", "Reserved", "On hold", "Damaged", "Expired", "In transit"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("5 cs"); // 60 pc = 5 cases
    expect(html).toContain("4 cs 2 pc"); // available 50 = 4 cs 2 pc
  });
  it("warns when a product has no cost instead of calling it free", () => {
    expect(html).toContain("1 product has no cost yet");
    expect(html).toContain("No cost yet");
  });
  it("offers a CSV download, a stock card link and the place and status filters", () => {
    expect(html).toContain('href="/api/v1/inventory/valuation?basis=cost&amp;groupBy=product&amp;format=csv"');
    expect(html).toContain("/stock/card?productId=p1&amp;locationId=l1");
    expect(html).toContain("Any status");
    expect(html).toContain("All places");
    expect(html).not.toMatch(/centavo/i);
  });
});

describe("Stock card", () => {
  const props = { productId: "p1", locationId: "l1", documentHref: (l: { type: string; id: string }) => (l.type === "goods_receipt" ? `/receipts/${l.id}` : null) };
  const key = ["inventory", "stock-card", { productId: "p1", locationId: "l1" }];
  it("lists opening, each movement with its document number, running balance and closing", () => {
    const html = render(StockCard, props, [[key, card]]);
    expect(html).toContain("Opening balance");
    expect(html).toContain("RCV-DEP-261105-0003");
    expect(html).toContain('href="/receipts/r1"');
    expect(html).toContain("Closing balance");
    expect(html).toContain("₱600.00");
    expect(html).not.toContain("does not match today");
  });
  it("tells the person when the card disagrees with today's stock", () => {
    const html = render(StockCard, props, [[key, { ...card, reconcilesToday: false }]]);
    expect(html).toContain("does not match today&#x27;s stock");
  });
});

describe("Bad orders", () => {
  const html = render(BadOrders, {}, [[["inventory", "dispositions", { status: "requested" }], queue]]);
  it("puts stock waiting for a decision first, with its value and status", () => {
    expect(html).toContain("Stock waiting");
    expect(html).toContain("Damaged");
    expect(html).toContain("₱264.00");
    expect(html).toContain(">Decide<");
  });
  it("shows requests with photos, who must approve and why, and only offers Approve to someone who can", () => {
    expect(html).toContain("DSP-DEP-261106-0001");
    expect(html).toContain('src="/api/v1/inventory/dispositions/photo?id=ph1"');
    expect(html).toContain("Needs a manager: over ₱1,000.00.");
    expect(html).toContain("A supervisor can approve this.");
    expect(html).toContain("Needs a photo before it can be approved.");
    expect(html.match(/>Approve</g)?.length).toBe(1);
    expect(html).toContain("Decline");
  });
});

describe("Expiry board", () => {
  const html = render(ExpiryBoard, {}, [[["inventory", "expiry-board", { days: 90 }], board]]);
  it("groups batches by days to expiry with the countdown in plain words", () => {
    for (const label of ["Already expired", "Within 30 days", "31 to 60 days", "61 to 90 days"]) expect(html).toContain(label);
    expect(html).toContain("(10 days)");
    expect(html).toContain("(expired 2 days ago)");
    expect(html).toContain("Ship first");
    expect(html).toContain("Stop shipping first");
  });
  it("offers hold and bad order only for stock that can move, and marks held stock", () => {
    expect(html.match(/>Hold</g)?.length).toBe(2);
    expect(html.match(/>Move to bad order</g)?.length).toBe(2);
    expect(html).toContain("On hold");
  });
});

describe("helpers", () => {
  it("expiry label and tone", () => {
    expect(expiryLabel(Date.parse("2031-03-31T04:00:00Z"), 1606)).toBe("March 31, 2031 (1606 days)");
    expect(expiryLabel(Date.parse("2026-11-07T04:00:00Z"), 1)).toContain("(1 day)");
    expect(expiryLabel(Date.parse("2026-11-06T04:00:00Z"), 0)).toContain("expires today");
    expect([expiryTone(-1), expiryTone(30), expiryTone(31), expiryTone(60), expiryTone(61)]).toEqual(["danger", "danger", "warning", "warning", "neutral"]);
  });
  it("tells the person exactly what is missing before a request can be sent", () => {
    const base = { decision: "write_off" as const, quantityBase: 6, maxBase: 24, reasonCode: "DMG-HANDLING", note: "", supplierRef: "", photos: 1 };
    expect(missingForRequest(base)).toEqual([]);
    expect(missingForRequest({ ...base, decision: null })).toEqual(["Choose what to do with this stock."]);
    expect(missingForRequest({ ...base, quantityBase: 25 })).toEqual(["That is more than is waiting."]);
    expect(missingForRequest({ ...base, quantityBase: 0 })).toEqual(["Enter how many."]);
    expect(missingForRequest({ ...base, reasonCode: null })).toEqual(["Choose a reason."]);
    expect(missingForRequest({ ...base, photos: 0, reasonNeedsPhoto: true })).toEqual(["Take a photo."]);
    expect(missingForRequest({ ...base, decision: "destroy", photos: 0 })).toEqual(["Take a photo."]);
    expect(missingForRequest({ ...base, decision: "return_to_supplier" })).toEqual(["Add the supplier or return slip number."]);
    expect(missingForRequest({ ...base, decision: "release" })).toEqual(["Say why this stock is fine to sell again."]);
    expect(missingForRequest({ ...base, decision: "release", note: "Temperature log is fine", reasonCode: null, photos: 0 })).toEqual([]);
  });
  it("approval hint and CSV link", () => {
    expect(approvalHint({ approvalLevel: "manager", approvalLimitCentavos: 100000 }, formatPeso)).toBe("Needs a manager: over ₱1,000.00.");
    expect(csvQuery({ basis: "cost", locationId: undefined, status: "hold" })).toBe("/api/v1/inventory/valuation?basis=cost&status=hold&format=csv");
  });
});
