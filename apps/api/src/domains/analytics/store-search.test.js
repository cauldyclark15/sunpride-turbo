import { describe, expect, it } from "bun:test";
import { compactCode, storeMatches } from "./store-search.js";

const row = {
  code: "SMP-00069",
  customerCode: "CUST-0042",
  name: "Mercado Sari-Sari",
  territory: "Cebu North",
  channel: "general_trade",
  address: "12 Rizal Ave, Lahug",
};

describe("store search", () => {
  it("finds a store by its code typed the usual ways", () => {
    for (const q of [
      "SMP-00069",
      "smp-00069",
      "SMP 00069",
      "SMP00069",
      "smp-69",
      "SMP\u201100069",
      "SMP-OOO69",
      " SMP-00069 ",
    ])
      expect(storeMatches(row, q)).toBe(true);
  });
  it("finds by customer code, name, area and address", () => {
    for (const q of [
      "CUST-42",
      "mercado",
      "cebu north",
      "lahug",
      "mercado lahug",
    ])
      expect(storeMatches(row, q)).toBe(true);
  });
  it("does not match other codes or words", () => {
    for (const q of ["SMP-00070", "SMP-690", "makati", "mercado makati"])
      expect(storeMatches(row, q)).toBe(false);
  });
  it("compacts codes", () => {
    expect(compactCode("SMP-00069")).toBe("smp69");
    expect(compactCode("smp oo69")).toBe("smp69");
  });
});
