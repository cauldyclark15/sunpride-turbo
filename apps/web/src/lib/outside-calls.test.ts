import { describe, expect, it } from "vitest";
import {
  PRODUCTIVE_ACTIVITY_CODES,
  PRODUCTIVE_ACTIVITY_LABELS,
} from "../../../../packages/backend/convex/sfa/productive_call";
import {
  activityFieldsFromForm,
  encodeFieldsFromForm,
  linesSummary,
  manilaToday,
  OUTSIDE_CALL_ACTIVITY_LABELS,
  parsePoLines,
} from "./outside-calls";

const form = (values: Record<string, string | string[]>) => ({
  get: (name: string) => {
    const value = values[name];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  },
  getAll: (name: string) => {
    const value = values[name];
    return Array.isArray(value) ? value : value === undefined ? [] : [value];
  },
});

describe("outside-call PO form rules (CALL-09)", () => {
  it("mirrors the backend productive-activity labels exactly", () => {
    expect(Object.keys(OUTSIDE_CALL_ACTIVITY_LABELS)).toEqual([
      ...PRODUCTIVE_ACTIVITY_CODES,
    ]);
    expect(OUTSIDE_CALL_ACTIVITY_LABELS).toEqual(PRODUCTIVE_ACTIVITY_LABELS);
  });

  it("uses the Manila calendar day", () => {
    // 23:30 UTC on the 27th is 07:30 on the 28th in Manila.
    expect(manilaToday(Date.parse("2026-09-27T23:30:00Z"))).toBe("2026-09-28");
  });

  it("parses PO lines, ignoring blank rows", () => {
    expect(
      parsePoLines([
        { productId: "p1", quantity: "10" },
        { productId: "", quantity: " " },
        { productId: "p2", quantity: "2.5" },
      ]),
    ).toEqual([
      { productId: "p1", quantity: 10 },
      { productId: "p2", quantity: 2.5 },
    ]);
    expect(() => parsePoLines([{ productId: "", quantity: "" }])).toThrow(
      /at least one/,
    );
    expect(() => parsePoLines([{ productId: "p1", quantity: "0" }])).toThrow(
      /more than 0/,
    );
    expect(() => parsePoLines([{ productId: "p1", quantity: "abc" }])).toThrow(
      /more than 0/,
    );
    expect(() => parsePoLines([{ productId: "", quantity: "3" }])).toThrow(
      /Choose a product/,
    );
    expect(() =>
      parsePoLines([
        { productId: "p1", quantity: "1" },
        { productId: "p1", quantity: "2" },
      ]),
    ).toThrow(/once/);
  });

  it("reads the encode form and requires every field but the note", () => {
    const full = {
      outletId: "o1",
      salespersonProfileId: "s1",
      serviceDate: "2026-09-28",
      poNumber: " PO-1 ",
      receivedVia: "viber",
      note: " ",
    };
    expect(encodeFieldsFromForm(form(full))).toEqual({
      outletId: "o1",
      salespersonProfileId: "s1",
      serviceDate: "2026-09-28",
      poNumber: "PO-1",
      receivedVia: "viber",
    });
    expect(
      encodeFieldsFromForm(form({ ...full, note: "Buyer: Liza" })).note,
    ).toBe("Buyer: Liza");
    for (const [field, error] of [
      ["outletId", /store/],
      ["serviceDate", /PO date/],
      ["salespersonProfileId", /salesperson/],
      ["poNumber", /PO number/],
      ["receivedVia", /arrived/],
    ] as const)
      expect(() =>
        encodeFieldsFromForm(form({ ...full, [field]: "" })),
      ).toThrow(error);
  });

  it("reads the salesperson's activity form", () => {
    expect(
      activityFieldsFromForm(
        form({
          contact: "phone",
          codes: ["collection", "purchase_order", "gossip"],
          note: "",
        }),
      ),
    ).toEqual({ contact: "phone", codes: ["collection"] });
    expect(() => activityFieldsFromForm(form({ contact: "" }))).toThrow(
      /how you reached/,
    );
    expect(() => activityFieldsFromForm(form({ contact: "other" }))).toThrow(
      /how the store was reached/,
    );
  });

  it("summarizes lines briefly", () => {
    const line = (name: string) => ({
      productName: name,
      quantity: 2,
      uom: "CS",
    });
    expect(linesSummary([line("Juice")])).toBe("2 CS Juice");
    expect(linesSummary([line("A"), line("B"), line("C")])).toBe(
      "2 CS A, 2 CS B +1 more",
    );
  });
});
