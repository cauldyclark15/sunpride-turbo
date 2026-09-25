import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
  useQuery: () => ({
    territories: [
      {
        id: "raw-territory-id",
        code: "DEMO-T1",
        name: "Demo North Metro Territory",
      },
    ],
    routes: [{ id: "raw-route-id", code: "DEMO-R1", name: "Demo City Route" }],
  }),
}));
import { CoverageExport } from "./coverage-export";

it("renders plan-scoped export pickers rather than raw ID fields", () => {
  const html = renderToStaticMarkup(
    <CoverageExport planId={"plan" as never} />,
  );
  expect(html).toContain("DEMO-T1 · Demo North Metro Territory");
  expect(html).toContain("DEMO-R1 · Demo City Route");
  expect(html).not.toContain("raw-territory-id");
  expect(html).not.toContain("raw-route-id");
  expect(html).not.toContain("Territory ID");
  expect(html).not.toContain("Route ID");
});
