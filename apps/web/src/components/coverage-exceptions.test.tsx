import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
  useQuery: () => ({
    page: [
      {
        code: "territory_only",
        severity: "advisory",
        message: "No route",
        remediation: "Assign route",
        signedHistorical: false,
      },
      {
        code: "inactive_outlet",
        severity: "blocking",
        message: "Inactive",
        remediation: "Reactivate",
        signedHistorical: false,
      },
    ],
    isDone: true,
    continueCursor: "",
  }),
}));
import { CoverageExceptions, groupExceptions } from "./coverage-exceptions";
it("separates actionable blockers and provisional advisories", () => {
  expect(groupExceptions([])).toEqual({ blocking: [], advisory: [] });
  const html = renderToStaticMarkup(
    <CoverageExceptions planId={"plan" as never} />,
  );
  expect(html).toContain("No route");
  expect(html).toContain("Inactive");
  expect(html).toContain("Recheck before approval");
});
