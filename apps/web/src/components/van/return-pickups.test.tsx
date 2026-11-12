import { it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PickupFacts } from "./return-pickups";
vi.mock("../../lib/api", () => ({ useApi: vi.fn(), apiFetch: vi.fn() }));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: () => false }),
}));
it("F-113 shows pickup custody, the captured batch and customer acknowledgement without asserting financial credit", () => {
  const html = renderToStaticMarkup(
    <PickupFacts
      item={{
        id: "private",
        returnNumber: "SAMPLE-PICKUP",
        customerName: "Renamed",
        capture: {
          customerName: "SAMPLE original buyer",
          lines: [
            {
              product: { name: "SAMPLE item" },
              uomQuantity: "1",
              uomCode: "EA",
              reasonLabel: "Quality",
              lotNumber: "SAMPLE-BATCH",
              disposition: "bad_stock",
            },
          ],
          customerAcknowledgement: {
            name: "SAMPLE customer",
            strokes: [
              [
                [1, 1],
                [2, 2],
              ],
            ],
          },
        },
        decisions: [],
      }}
    />,
  );
  expect(html).toContain("not sellable stock");
  expect(html).toContain("SAMPLE-BATCH");
  expect(html).toContain("SAMPLE original buyer");
  expect(html).toContain("Captured customer signature");
  expect(html).not.toContain("Renamed");
});
it("VAN-061 a store disposal held for office approval without a batch never shows 'Batch undefined'", () => {
  const html = renderToStaticMarkup(
    <PickupFacts
      item={{
        id: "private",
        returnNumber: "SAMPLE-PICKUP-2",
        customerName: "SAMPLE buyer",
        capture: {
          lines: [
            {
              product: { name: "SAMPLE item" },
              uomQuantity: "1",
              uomCode: "PC",
              reasonLabel: "Damaged",
              disposition: "disposed_at_outlet",
            },
          ],
        },
        decisions: [],
      }}
    />,
  );
  expect(html).toContain("disposed at outlet");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("Batch");
});
