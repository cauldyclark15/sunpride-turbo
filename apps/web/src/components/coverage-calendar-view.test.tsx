import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoverageCalendarView } from "./coverage-calendar-view";
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
        slotKey: "visit",
        serviceDate: "2026-09-28",
        kind: "outlet_visit",
        outletCode: "O1",
        name: "Outlet",
        sequence: 1,
        planStatus: "active",
        visitStatus: "cancelled",
        durationMinutes: 20,
      },
      {
        slotKey: "admin",
        serviceDate: "2026-09-30",
        kind: "non_visit",
        name: "Admin",
        sequence: 2,
        planStatus: "active",
        durationMinutes: 60,
      },
    ],
    isDone: true,
    continueCursor: "2",
  }),
}));
describe("calendar view", () => {
  it("labels signed/generated distinction, cancelled visit, non-visit and Manila week", () => {
    const html = renderToStaticMarkup(
      <CoverageCalendarView planId={"plan" as never} assigneeName="Seller" />,
    );
    expect(html).toContain("Store visit");
    expect(html).toContain("Cancelled");
    expect(html).toContain("Non-visit activity");
    expect(html).not.toContain("outlet_visit");
    expect(html).not.toContain("non_visit");
    expect(html).toContain("Week of 2026-09-28");
    expect(html).toContain("cancelled");
    expect(html).toContain("Admin");
    expect(html).toContain("provisional proposal");
    expect(html).toContain("Seller");
    expect(html).toContain("DEMO-T1 · Demo North Metro Territory");
    expect(html).toContain("DEMO-R1 · Demo City Route");
    expect(html).not.toContain("raw-territory-id");
    expect(html).not.toContain("raw-route-id");
  });
});
