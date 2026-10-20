import { expect, test } from "bun:test";
import { manifestHtml } from "../src/domains/presell/manifest.js";
test("F-303 isolated printable manifest escapes every supplied name and excludes the office shell", () => {
  const html = manifestHtml({
    label: "<script>run</script>",
    serviceDate: "2026-10-20",
    tripNumber: "SAMPLE-TRIP",
    truck: "SAMPLE-PLATE",
    driver: "Sample driver",
    status: "released",
    rows: [
      {
        sequence: 1,
        store: "<img onerror=evil()>",
        address: "Cebu & Mandaue",
        order: "SAMPLE-ORDER",
        deliveryDate: "2026-10-20",
        windowStart: null,
        bookingReference: null,
        lines: [
          {
            product_code: "FOOD",
            description: "Food",
            ordered_quantity: "2",
            uom: "CASE",
            expected_base: "48",
          },
        ],
      },
    ],
  });
  expect(html).toContain("&lt;script&gt;run&lt;/script&gt;");
  expect(html).not.toContain("<img onerror");
  expect(html).toContain("2 CASE");
  expect(html).toContain("48");
  expect(html).toContain("SAMPLE-PLATE");
  expect(html).toContain("Sample driver");
  expect(html).not.toContain("Delivery performance");
  expect(html).not.toContain("sample_data_rows");
});
