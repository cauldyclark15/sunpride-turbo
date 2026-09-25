import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CoverageWorkloadView } from "./coverage-workload-view";
vi.mock("convex/react", () => ({
  useQuery: () => ({
    page: [
      {
        assigneeProfileId: "seller",
        assigneeName: "Seller",
        selection: "active v2",
        routeCodes: [],
        workingDays: ["2026-09-28", "2026-09-29", "2026-09-30"],
        visitCount: 18,
        durationMinutes: 360,
        dailyCallsTarget: 5,
        variance: 3,
      },
    ],
    isDone: true,
  }),
}));
it("shows only selected version's load and advisory target variance", () => {
  const html = renderToStaticMarkup(
    <CoverageWorkloadView localMonth="2026-09" />,
  );
  expect(html).toContain("active v2");
  expect(html).toContain("18 calls");
  expect(html).toContain("Over target (3)");
  expect(html).toContain("No route");
});
