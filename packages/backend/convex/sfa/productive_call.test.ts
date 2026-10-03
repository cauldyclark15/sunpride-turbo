import { describe, expect, it } from "vitest";
import {
  evaluateProductiveCall,
  NO_SALES_DUE_TO_INVENTORY,
  PRODUCTIVE_ACTIVITY_CODES,
  productiveCodesFromVisitRecords,
  summarizeCalls,
} from "./productive_call";

const closed = { inRoutePlan: true, state: "completed" } as const;

describe("productive call rule (call 2026-10-02)", () => {
  it("lists exactly the eight activities Sir Francis named", () => {
    expect([...PRODUCTIVE_ACTIVITY_CODES]).toEqual([
      "purchase_order",
      "merchandising",
      "inventory_retrieval",
      "suggested_order",
      "negotiation",
      "bad_order_pickup",
      "collection",
      "meeting",
    ]);
  });

  it("makes a call productive with any ONE listed activity, not a full checklist", () => {
    for (const code of PRODUCTIVE_ACTIVITY_CODES) {
      const result = evaluateProductiveCall({
        ...closed,
        rule: "any_listed_activity",
        codes: [code],
      });
      expect(result.status).toBe("productive");
      expect(result.isCall).toBe(true);
      expect(result.matchedCodes).toEqual([code]);
    }
  });

  it("counts a visited store with no activity as a nonproductive call", () => {
    const result = evaluateProductiveCall({
      ...closed,
      rule: "any_listed_activity",
      codes: ["note", "unknown_code"],
    });
    expect(result).toMatchObject({ status: "nonproductive", isCall: true });
  });

  it("does not count off-plan, unvisited or still-open visits as calls", () => {
    const base = { rule: "any_listed_activity" as const, codes: ["meeting"] };
    expect(
      evaluateProductiveCall({
        ...base,
        inRoutePlan: false,
        state: "completed",
      }),
    ).toMatchObject({ status: "off_plan", isCall: false });
    for (const state of ["missed", "skipped", "planned", "rescheduled"])
      expect(
        evaluateProductiveCall({ ...base, inRoutePlan: true, state }),
      ).toMatchObject({ status: "not_visited", isCall: false });
    for (const state of ["arrived", "checked-in", "in-progress"])
      expect(
        evaluateProductiveCall({ ...base, inRoutePlan: true, state }),
      ).toMatchObject({ status: "open", isCall: false });
    expect(
      evaluateProductiveCall({
        ...base,
        inRoutePlan: true,
        state: "checked-out",
      }),
    ).toMatchObject({ status: "productive", isCall: true });
  });

  it("lets a truck seller's merchandising count only with the no-sales-due-to-inventory marker", () => {
    const without = evaluateProductiveCall({
      ...closed,
      rule: "truck_seller",
      codes: ["merchandising"],
    });
    expect(without.status).toBe("nonproductive");
    const withMarker = evaluateProductiveCall({
      ...closed,
      rule: "truck_seller",
      codes: ["merchandising"],
      noSalesDueToInventory: true,
    });
    expect(withMarker).toMatchObject({
      status: "productive",
      matchedCodes: ["merchandising"],
    });
    // The marker alone is never productive; a sale is productive either way.
    expect(
      evaluateProductiveCall({
        ...closed,
        rule: "truck_seller",
        codes: [],
        noSalesDueToInventory: true,
      }).status,
    ).toBe("nonproductive");
    expect(
      evaluateProductiveCall({
        ...closed,
        rule: "truck_seller",
        codes: ["purchase_order", "merchandising"],
      }).matchedCodes,
    ).toEqual(["purchase_order"]);
  });

  it("maps today's recorded visit data onto the client's codes", () => {
    expect(
      productiveCodesFromVisitRecords({
        activityKinds: [
          "order_intent",
          "price_check",
          "inventory_check",
          "note",
        ],
        collectionCount: 1,
        reasonCode: ` ${NO_SALES_DUE_TO_INVENTORY.toUpperCase()} `,
      }),
    ).toEqual({
      codes: [
        "purchase_order",
        "merchandising",
        "inventory_retrieval",
        "collection",
      ],
      noSalesDueToInventory: true,
    });
    expect(
      productiveCodesFromVisitRecords({
        activityKinds: ["promotion", "note"],
        collectionCount: 0,
      }),
    ).toEqual({ codes: [], noSalesDueToInventory: false });
  });

  it("summarizes calls and the productive percentage", () => {
    const productive = evaluateProductiveCall({
      ...closed,
      rule: "any_listed_activity",
      codes: ["collection"],
    });
    const nonproductive = evaluateProductiveCall({
      ...closed,
      rule: "any_listed_activity",
      codes: [],
    });
    const offPlan = evaluateProductiveCall({
      rule: "any_listed_activity",
      inRoutePlan: false,
      state: "completed",
      codes: ["collection"],
    });
    expect(
      summarizeCalls([productive, productive, nonproductive, offPlan]),
    ).toEqual({ calls: 3, productiveCalls: 2, productivePct: 66 });
    expect(summarizeCalls([])).toEqual({
      calls: 0,
      productiveCalls: 0,
      productivePct: null,
    });
  });
});
