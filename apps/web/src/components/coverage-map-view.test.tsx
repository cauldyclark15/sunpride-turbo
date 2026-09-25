import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("convex/react", () => ({
  useQuery: () => ({
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
  expect(html).toContain("Outlet list (available even if tiles fail)");
  expect(html).toContain("Unmapped (no verified pin)");
  expect(html).toContain("Pinned");
});
