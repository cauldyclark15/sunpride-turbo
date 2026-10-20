import { describe, expect, it } from "vitest";
import {
  formatAmount,
  parseAmount,
  reconciliation,
} from "./target-cascade-panel";

describe("F-615 target cascade panel", () => {
  it("F-615 parses each measure in the unit people type", () => {
    expect(parseAmount("sales_value", "₱1,250,000.50")).toBe(125_000_050);
    expect(parseAmount("msl_compliance", "85%")).toBe(8500);
    expect(parseAmount("msl_compliance", "101")).toBeNull();
    expect(parseAmount("calls", "300")).toBe(300);
    expect(parseAmount("calls", "300.5")).toBeNull();
    expect(parseAmount("volume", "-4")).toBeNull();
  });
  it("F-615 reconciliation names the gap and never sums rates", () => {
    const l = (amount: number) => ({
      key: String(amount),
      label: "x",
      basis: null,
      amount,
    });
    expect(reconciliation("calls", true, 100, [l(60), l(40)]).ok).toBe(true);
    expect(reconciliation("calls", true, 100, [l(60), l(30)]).text).toBe(
      "Children are 10 short of the parent.",
    );
    expect(reconciliation("calls", true, 100, [l(60), l(50)]).text).toBe(
      "Children are 10 over the parent.",
    );
    expect(
      reconciliation("msl_compliance", false, 8500, [l(8500), l(9000)]).ok,
    ).toBe(true);
    expect(reconciliation("msl_compliance", false, 8500, [l(10001)]).ok).toBe(
      false,
    );
  });
  it("F-615 a peso gap is stated in pesos, not centavos", () => {
    const l = (amount: number) => ({
      key: String(amount),
      label: "x",
      basis: null,
      amount,
    });
    const r = reconciliation("sales_value", true, 1_200_000_000, [
      l(600_100_000),
      l(600_000_000),
    ]);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("1,000.00");
    expect(r.text).toContain("over");
  });
  it("F-615 formats amounts in the measure's unit", () => {
    expect(formatAmount("msl_compliance", 8500)).toBe("85.0%");
    expect(formatAmount("calls", 1200)).toBe("1,200");
    expect(formatAmount("calls", null)).toBe("—");
  });
});
