import { describe, expect, it } from "vitest";
import {
  deliveryProblems,
  emptyHeader,
  findProduct,
  lineProblems,
  newLine,
  toReceiptBody,
  type CatalogProduct,
} from "./receive-model";

const product = (o: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id: "p1",
  code: "LONG-500",
  name: "Longganisa 500 g",
  tracking: "lot",
  units: { basePerCase: 48 },
  ...o,
});
const header = {
  ...emptyHeader("depot"),
  supplierName: "Mekeni Foods",
  deliveryReceiptNo: "DR-77821",
};

describe("Receive delivery model", () => {
  it("finds a product by exact code, else by a single name match", () => {
    const catalog = [
      product(),
      product({ id: "p2", code: "TOCINO-1", name: "Tocino 1 kg" }),
    ];
    expect(findProduct(catalog, "long-500")?.id).toBe("p1");
    expect(findProduct(catalog, "tocino")?.id).toBe("p2");
    expect(findProduct(catalog, "o")).toBeNull(); // two products match: do not guess
    expect(findProduct(catalog, "")).toBeNull();
  });

  it("says what is missing in plain words", () => {
    const line = newLine(product());
    expect(lineProblems(line)).toEqual([
      "Longganisa 500 g: enter how many arrived.",
      "Longganisa 500 g: enter the batch number.",
      "Longganisa 500 g: enter the expiry date.",
    ]);
    const ready = {
      ...line,
      accepted: { cases: 2, pieces: 0 },
      batch: "B-1",
      expiry: "2027-03-01",
    };
    expect(lineProblems(ready)).toEqual([]);
    const rejected = { ...ready, rejected: { cases: 0, pieces: 3 } };
    expect(lineProblems(rejected)).toEqual([
      "Longganisa 500 g: choose why some were rejected.",
    ]);
    expect(
      lineProblems({
        ...rejected,
        rejectedReason: "DMG-HANDLING",
        reasonNeedsPhoto: true,
      }),
    ).toEqual(["Longganisa 500 g: take a photo of the rejected items."]);
  });

  it("needs a supplier, a delivery receipt number and at least one line", () => {
    expect(deliveryProblems(emptyHeader(), [])).toEqual([
      "Choose where the delivery is going.",
      "Enter the supplier.",
      "Enter the delivery receipt number.",
      "Scan or search for the products delivered.",
    ]);
  });

  it("builds one receipt body for 40 lines in pieces", () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      ...newLine(product({ id: `p${i}`, tracking: "none" })),
      accepted: { cases: i + 1, pieces: 6 },
    }));
    const body = toReceiptBody({ ...header, purchaseOrderRef: "PO-9" }, lines);
    expect(body.lines).toHaveLength(40);
    expect(body.lines[0]).toEqual({ productId: "p0", quantityBase: 54 });
    expect(body).toMatchObject({
      receivingLocationId: "depot",
      receiptType: "purchase_order",
      supplierName: "Mekeni Foods",
      deliveryReference: "DR-77821",
      purchaseOrderRef: "PO-9",
    });
  });

  it("sends batch, expiry and the rejected quantity with its reason", () => {
    const line = {
      ...newLine(product()),
      accepted: { cases: 1, pieces: 0 },
      rejected: { cases: 0, pieces: 2 },
      rejectedReason: "EXP",
      batch: " B-7 ",
      expiry: "2027-03-01",
    };
    const body = toReceiptBody(header, [line]);
    expect(body.receiptType).toBe("unplanned");
    expect(body.lines[0]).toMatchObject({
      quantityBase: 48,
      rejectedBase: 2,
      rejectedReasonCode: "EXP",
      lotNumber: "B-7",
    });
    expect(body.lines[0]?.expiresAt).toBe(
      new Date("2027-03-01T23:59:59+08:00").getTime(),
    );
  });
});
