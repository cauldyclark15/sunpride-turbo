import { expect, it } from "vitest";
import { authorityMinor, authorityPeso, fiscalMoney } from "./authority-money";
it("F-511 peso authority entries retain exact centavos", () => {
  expect(authorityMinor("0.01")).toBe("1");
  expect(authorityMinor("1.01")).toBe("101");
  expect(authorityMinor("999999999.99")).toBe("99999999999");
  expect(authorityPeso("101")).toBe("1.01");
  expect(authorityPeso("500")).toBe("5.00");
  for (const invalid of ["-1", "1.001", "1e3", "", "abc"])
    expect(() => authorityMinor(invalid)).toThrow();
});
it("F-108 F-511 displayed money keeps exact centavos and never turns missing facts into zero", () => {
  expect(fiscalMoney("1")).toBe("₱0.01");
  expect(fiscalMoney("10001")).toBe("₱100.01");
  expect(fiscalMoney("-1")).toBe("−₱0.01");
  expect(fiscalMoney("9223372036854775807")).toBe("₱92,233,720,368,547,758.07");
  for (const missing of [
    null,
    undefined,
    "",
    " ",
    "bad",
    "1.23",
    Number.MAX_SAFE_INTEGER + 1,
    {},
    [],
  ])
    expect(fiscalMoney(missing)).toBe("—");
});
