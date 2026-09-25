import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({ useQuery: query }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  let index = 0;
  return {
    ...actual,
    useState: (initial: unknown) => {
      const values = ["week", "raw-territory-id", "raw-route-id", "", null];
      return [values[index++] ?? initial, () => {}];
    },
  };
});
import { CoverageCalendarView } from "./coverage-calendar-view";

it("sends selected IDs to the scoped calendar query while HTML exposes only labels", () => {
  query.mockReturnValue({
    page: [],
    isDone: true,
    territories: [{ id: "raw-territory-id", code: "DEMO-T1", name: "North" }],
    routes: [{ id: "raw-route-id", code: "DEMO-R1", name: "City" }],
  });
  const html = renderToStaticMarkup(
    <CoverageCalendarView planId={"plan" as never} assigneeName="Seller" />,
  );
  expect(query.mock.calls[0]![1]).toMatchObject({
    planId: "plan",
    territoryId: "raw-territory-id",
    routeId: "raw-route-id",
  });
  expect(query.mock.calls[1]![1]).toEqual({ planId: "plan" });
  expect(html).toContain("DEMO-T1 · North");
  expect(html).toContain("DEMO-R1 · City");
  expect(html).not.toContain("raw-territory-id");
  expect(html).not.toContain("raw-route-id");
});
