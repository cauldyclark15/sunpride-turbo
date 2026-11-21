import { describe, expect, it } from "vitest";
import { countOf, platformLabel } from "../lib/format";
import { frequencyGapSummary } from "./coverage-planner";
import {
  actualLabel,
  codeLabel,
  planActualCsv,
  reasonLabel,
  visitActivitiesLabel,
} from "./plan-actual/model";

describe("QA retest polish (plain words, no raw codes)", () => {
  it("counts read naturally", () => {
    expect(countOf(1, "call")).toBe("1 call");
    expect(countOf(3, "call")).toBe("3 calls");
    expect(countOf(1, "activity", "activities")).toBe("1 activity");
    expect(countOf(0, "stop")).toBe("0 stops");
  });
  it("platform names are capitalised", () => {
    expect(platformLabel("android")).toBe("Android");
    expect(platformLabel("ios")).toBe("iOS");
  });
  it("the frequency shortfall is one summary line", () => {
    expect(frequencyGapSummary(74)).toBe("74 customers below the required visits");
    expect(frequencyGapSummary(1)).toBe("1 customer below the required visits");
  });
  it("plan vs actual shows labels, not stored codes", () => {
    expect(reasonLabel("no_sales_due_to_inventory")).toBe(
      "No sale: store has enough stock",
    );
    expect(visitActivitiesLabel(["order_intent", "price_check"])).toBe(
      "Order, Price check",
    );
    expect(reasonLabel("Store closed early")).toBe("Store closed early");
    expect(codeLabel("location")).toBe("Location");
    expect(codeLabel("completed")).toBe("Completed");
    expect(
      actualLabel({ state: "completed", review: "pending_review" } as never),
    ).toBe("Completed · Pending review");
  });
  it("the plan vs actual CSV has no raw codes", () => {
    const csv = planActualCsv({
      from: "2026-11-01",
      to: "2026-11-02",
      totals: {},
      summary: { followedPct: null },
      days: [
        {
          totals: {},
          stops: [
            {
              person: "Ana",
              date: "2026-11-01",
              territoryType: "location",
              status: "completed",
              planned: true,
              activities: [],
              visits: [
                {
                  state: "completed",
                  review: null,
                  activities: ["order_intent"],
                  reason: "no_sales_due_to_inventory",
                  checkedInAt: null,
                  checkedOutAt: null,
                },
              ],
            },
          ],
        },
      ],
    } as never);
    expect(csv).not.toMatch(/order_intent|no_sales_due_to_inventory|"location"|"completed"/);
    expect(csv).toContain("Order");
  });
});
