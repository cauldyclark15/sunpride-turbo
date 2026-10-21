import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverrideFacts } from "./override-facts";
it("F-110 reviewer sees exact named quantity/money facts instead of internal source IDs or executable markup", () => {
  const source = "00000000-0000-4000-8000-000000000001";
  const html = renderToStaticMarkup(
    <OverrideFacts
      value={{
        version: 2,
        saleId: source,
        customerId: source,
        totalMinor: "8000",
        lines: [
          {
            productId: source,
            productCode: "SAMPLE-1",
            productName: "SAMPLE <img src=x>",
            uomCode: "CASE",
            quantityBase: "1500",
            quantityScale: "1000",
            unitPriceMinor: "10000",
            grossMinor: "10000",
            discountMinor: "2000",
            totalMinor: "8000",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("SAMPLE-1");
  expect(html).toContain("1.5");
  expect(html).toContain("CASE");
  expect(html).toContain("Reduction");
  expect(html).not.toContain(source);
  expect(html).not.toContain("<img");
  expect(
    renderToStaticMarkup(<OverrideFacts value={{ legacy: true }} />),
  ).toContain("Check the source transaction");
});
