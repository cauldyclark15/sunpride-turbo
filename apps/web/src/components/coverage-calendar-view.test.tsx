import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoverageCalendarView } from "./coverage-calendar-view";
vi.mock("convex/react", () => ({
  useQuery: () => ({
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
    expect(html).toContain("Week of 2026-09-28");
    expect(html).toContain("cancelled");
    expect(html).toContain("Admin");
    expect(html).toContain("provisional proposal");
    expect(html).toContain("Seller");
  });
});
