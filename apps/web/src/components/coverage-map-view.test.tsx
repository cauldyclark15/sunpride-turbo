import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("convex/react", () => ({
  useQuery: () => ({
    territories: [
      {
        id: "raw-territory-id",
        code: "DEMO-T1",
        name: "Demo North Metro Territory",
      },
    ],
    routes: [{ id: "raw-route-id", code: "DEMO-R1", name: "Demo City Route" }],
    page: [
      {
        outletId: "o1",
        outletCode: "O1",
        outletName: "Pinned",
        pinStatus: "verified",
        latitude: 14.6,
        longitude: 121,
        inPlan: true,
        assigned: true,
        sequence: 1,
      },
      {
        outletId: "o2",
        outletCode: "O2",
        outletName: "Pending",
        pinStatus: "unmapped",
        inPlan: false,
        assigned: false,
      },
    ],
    isDone: true,
    continueCursor: "",
  }),
}));
import { CoverageMapView, plottedPins } from "./coverage-map-view";
it("plots only verified pins and always renders the table fallback", () => {
  expect(
    plottedPins([
      {
        outletId: "o2" as never,
        outletCode: "O2",
        outletName: "Pending",
        pinStatus: "unmapped",
        inPlan: false,
        assigned: false,
      },
    ]),
  ).toEqual([]);
  const html = renderToStaticMarkup(
    <CoverageMapView planId={"plan" as never} />,
  );
  expect(html).toContain('<table class="w-full text-left text-[13px]">');
  expect(html).toContain("Unmapped");
  expect(html).toContain("Pinned");
  expect(html).toContain("DEMO-T1 · Demo North Metro Territory");
  expect(html).toContain("DEMO-R1 · Demo City Route");
  expect(html).not.toContain("raw-territory-id");
  expect(html).not.toContain("raw-route-id");
});
