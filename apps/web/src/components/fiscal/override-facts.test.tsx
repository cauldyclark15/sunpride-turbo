import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverrideFacts } from "./override-facts";
it("F-511 financial reviewer sees the frozen published quote and governed gift value, not a caller authority number", () => {
  const html = renderToStaticMarkup(
    <OverrideFacts
      value={{
        version: 5,
        kind: "commercial_discount",
        sourceNumber: "SAMPLE-MT",
        customerCode: "SAMPLE-C",
        subtotalCentavos: 10000,
        totalCentavos: 9800,
        giftValueCentavos: 0,
        lines: [
          {
            productName: "SAMPLE published item",
            quantity: 1,
            uom: "EA",
            unitPriceCentavos: 10000,
            totalCentavos: 9800,
          },
        ],
      }}
    />,
  );
  expect(html).toContain("SAMPLE published item");
  expect(html).toContain("current requester role, channel and value band");
  expect(html).toContain("governed free-goods value");
  expect(html).toContain("does not change a governed base price");
});
it("F-404 reviewer sees frozen exposure and the separate SAP decision requirement", () => {
  const html = renderToStaticMarkup(
    <OverrideFacts
      value={{
        version: 1,
        kind: "sap_credit_exception",
        customerCode: "SAMPLE-CREDIT",
        amountCentavos: 2000,
        limitCentavos: 1000,
        exposureCentavos: 900,
        projectedExposureCentavos: 2900,
        checkedAt: 0,
        source: "sample",
        reason: "SAMPLE delivery exception",
      }}
    />,
  );
  expect(html).toContain("SAMPLE-CREDIT");
  expect(html).toContain("SAMPLE mock SAP");
  expect(html).toContain("Finance approval alone does not permit");
  expect(html).toContain("SAP exposure at request");
});
it("F-124 stock override shows original and proposed physical facts without private keys", () => {
  const html = renderToStaticMarkup(
    <OverrideFacts
      value={{
        version: 4,
        kind: "stock",
        sourceId: "private-stock",
        sourceNumber: "ADJ-SAMPLE",
        totalMinor: "200",
        lines: [
          {
            productName: "SAMPLE stock item",
            locationName: "SAMPLE depot",
            uomCode: "EA",
            quantityScale: "1",
            expectedBase: "10",
            countedBase: "8",
            valueMinor: "200",
            productId: "private-product",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("SAMPLE stock item");
  expect(html).toContain("SAMPLE depot");
  expect(html).toContain("Before");
  expect(html).toContain("Proposed");
  expect(html).not.toContain("private-stock");
  expect(html).not.toContain("private-product");
});
it("F-124 price exception shows its governed before-price and preserves the SAP credit boundary", () => {
  const html = renderToStaticMarkup(
    <OverrideFacts
      value={{
        version: 3,
        kind: "price",
        saleId: "private-source",
        totalMinor: "20000",
        lines: [
          {
            productName: "SAMPLE priced item",
            productCode: "SAMPLE",
            uomCode: "EA",
            quantityBase: "2",
            quantityScale: "1",
            originalUnitPriceMinor: "12000",
            unitPriceMinor: "10000",
            grossMinor: "20000",
            discountMinor: "0",
            totalMinor: "20000",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("Original governed unit price");
  expect(html).toContain("SAMPLE priced item");
  expect(html).toContain("replace its live reservation");
  expect(html).not.toContain("private-source");
});
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
