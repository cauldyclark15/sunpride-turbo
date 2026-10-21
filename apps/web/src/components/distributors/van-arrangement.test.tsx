import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VanArrangement, type PartnerVanData } from "./van-arrangement";
it("F-408 office configures an existing consignment van, while partner readers see only their arrangement and shared trip", () => {
  const data: PartnerVanData = {
    ready: true,
    message: "Use the existing Van/Store app.",
    stockOwnership: "Sunpride-owned consignment",
    vans: [],
    arrangements: [
      {
        id: "arrangement",
        name: "Sample van",
        reference: "SAMPLE contract",
        source: "sample",
      },
    ],
    operators: [{ id: "operator", name: "Sample operator" }],
    vehicleOptions: [{ id: "vehicle", code: "SAMPLE", name: "Sample van" }],
    trips: [
      {
        id: "trip",
        trip_number: "SAMPLE-TRIP",
        service_date: "2026-10-21",
        status: "active",
      },
    ],
    tripsTruncated: false,
  };
  const office = renderToStaticMarkup(
    <VanArrangement data={data} office command={async () => ({})} />,
  );
  expect(office).toContain("Configure an existing company vehicle");
  expect(office).toContain("Sample arrangement");
  expect(office).toContain("SAMPLE-TRIP");
  expect(office).toContain("independent office settlement approvals");
  const portal = renderToStaticMarkup(
    <VanArrangement data={data} office={false} command={async () => ({})} />,
  );
  expect(portal).not.toContain("Save consignment arrangement");
  expect(portal).toContain("Sample operator");
});
