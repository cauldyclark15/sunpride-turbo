import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DispatchSummary,
  DriverManifest,
  deliveryNextAction,
  deliveryPercent,
  type DispatchData,
  type DeliveryRow,
} from "./dispatch-board";
const counts = { drops: 10, proofs: 8, withinSla: 7, exceptions: 2 };
const row: DeliveryRow = {
  id: "internal",
  order_number: "SAMPLE-42",
  order_status: "approved",
  outlet_id: "internal-store",
  outlet_name: "Cebu Market",
  requested_delivery_date: "2026-10-22",
  confirmed_delivery_date: null,
  handoff_id: null,
  handoff_status: null,
  source: null,
  drop_id: null,
  run_id: null,
  sequence: null,
  delivery_status: null,
  proof_id: null,
  within_sla: null,
  run_label: null,
  truck: null,
};
describe("F-301 F-303 F-304 dispatch presentation", () => {
  it("F-303 reconciles ePOD denominator, policy target, prior weekday and trend", () => {
    const data: DispatchData = {
      date: "2026-10-22",
      targetPercent: 98,
      current: counts,
      prior: counts,
      priorDate: "2026-10-15",
      trend: [{ ...counts, date: "2026-10-22" }],
      rows: [],
      runs: [],
    };
    const html = renderToStaticMarkup(<DispatchSummary data={data} />);
    expect(html).toContain("80%");
    expect(html).toContain("98%");
    expect(html).toContain("7 / 10");
    expect(html).toContain("8 / 10 signed");
    expect(html).toContain("Oct 15, 2026");
  });
  it("F-303 empty days are unknown rather than a perfect zero-denominator result", () => {
    expect(deliveryPercent({ ...counts, drops: 0, proofs: 0 })).toBeNull();
  });
  it("F-302 F-304 tells the dispatcher the next action without internal status codes", () => {
    expect(deliveryNextAction(row)).toBe("Confirm the delivery day");
    expect(
      deliveryNextAction({ ...row, order_status: "pending_approval" }),
    ).toContain("Approve");
    expect(
      deliveryNextAction({ ...row, delivery_status: "variance" }),
    ).toContain("SAP correction request");
    expect(
      deliveryNextAction({
        ...row,
        confirmed_delivery_date: "2026-10-22",
        handoff_status: "failed",
      }),
    ).toContain("retry");
  });
  it("F-303 prints source-frozen quantities and booking facts, escaping customer content", () => {
    const html = renderToStaticMarkup(
      <DriverManifest
        data={{
          label: "Sample run",
          serviceDate: "2026-10-22",
          tripNumber: "TRIP-1",
          status: "released",
          rows: [
            {
              sequence: 1,
              store: "<script>Buyer</script>",
              address: "Cebu",
              order: "SAMPLE-42",
              deliveryDate: "2026-10-22",
              windowStart: null,
              windowEnd: null,
              bookingReference: "BOOK-1",
              lines: [
                {
                  product_code: "FOOD",
                  description: "Canned food",
                  ordered_quantity: "2",
                  uom: "CASE",
                  expected_base: "48",
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(html).toContain("2 CASE (48 base pieces)");
    expect(html).toContain("BOOK-1");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>Buyer");
  });
});
