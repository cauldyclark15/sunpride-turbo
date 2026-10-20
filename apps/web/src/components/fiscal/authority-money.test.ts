import { expect, it } from "vitest";
import { authorityMinor, authorityPeso } from "./authority-money";
it("F-511 peso authority entries retain exact centavos", () => {
  expect(authorityMinor("0.01")).toBe("1");
  expect(authorityMinor("1.01")).toBe("101");
  expect(authorityMinor("999999999.99")).toBe("99999999999");
  expect(authorityPeso("101")).toBe("1.01");
  expect(authorityPeso("500")).toBe("5.00");
  for (const invalid of ["-1", "1.001", "1e3", "", "abc"])
    expect(() => authorityMinor(invalid)).toThrow();
});
