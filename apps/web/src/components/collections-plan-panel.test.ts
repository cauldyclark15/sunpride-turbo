import { describe, expect, it } from "vitest";
import { keptRate, pesos, suggestedStops } from "./collections-plan-panel";

describe("F-613 collections plan", () => {
  it("F-613 kept rate is unknown until a promise is settled", () => {
    expect(keptRate(0, 0)).toBeNull();
    expect(keptRate(3, 1)).toBe(75);
  });
  it("F-613 parses pesos to centavos and refuses zero or junk", () => {
    expect(pesos("₱1,250.50")).toBe(125_050);
    expect(pesos("0")).toBeNull();
    expect(pesos("12.345")).toBeNull();
  });
  it("F-613 suggests one stop per customer in priority order", () => {
    const a = (kind: string, customerCode: string) => ({
      kind,
      customerCode,
      amountMinor: 1,
      on: "2026-10-21",
      id: kind + customerCode,
      next: "",
    });
    expect(
      suggestedStops([
        a("cheque_replacement", "C1"),
        a("promise_overdue", "C1"),
        a("overdue_balance", "C2"),
      ]).map((s) => [s.customerCode, s.reason]),
    ).toEqual([
      ["C1", "cheque_replacement"],
      ["C2", "overdue_balance"],
    ]);
  });
});
