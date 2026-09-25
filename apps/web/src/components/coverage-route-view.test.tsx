import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CoverageRouteView } from "./coverage-route-view";
vi.mock("convex/react", () => ({
  useQuery: () => ({
    page: [
      {
        territoryCode: "T",
        routeCode: "No route",
        coveredCount: 1,
        uncoveredCount: 1,
        slotCount: 3,
        visitCount: 3,
        outlets: [
          { outletCode: "O1", name: "One", frequency: "weekly", covered: true },
          { outletCode: "O2", name: "Two", covered: false },
        ],
      },
    ],
    isDone: true,
  }),
}));
it("shows eligible uncovered outlets and no-route bucket", () => {
  const html = renderToStaticMarkup(
    <CoverageRouteView planId={"plan" as never} />,
  );
  expect(html).toContain("No route");
  expect(html).toContain("1 uncovered");
  expect(html).toContain("O2");
  expect(html).toContain("Uncovered");
});
