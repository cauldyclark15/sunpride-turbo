import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CoveragePlansListView,
  CoverageSummaryView,
  CoverageStandardsReview,
  monthLabel,
} from "./coverage-summary";
import type { Summary } from "./coverage-model";
vi.mock("./coverage-data", () => ({ useCoverageQuery: vi.fn() }));
const data: Summary = {
  month: "2026-10",
  asOf: 1,
  deadlines: {
    localMonth: "2026-10",
    submissionOpensDate: "2026-09-24",
    submissionDueDate: "2026-09-30",
    approvalDueDate: "2026-10-07",
    submissionOpensAt: 1,
    submissionDueAt: 2,
    approvalDueAt: 3,
  },
  counts: { not_started: 1, draft: 1, submitted: 1, approved: 1, active: 1 },
  lateCount: 2,
  awaitingMine: 1,
  target: 5,
  ready: 2,
  priorReady: 3,
  priorMonth: "2026-09",
  trend: [
    { month: "2026-09", ready: 3, target: 5 },
    { month: "2026-10", ready: 2, target: 5 },
  ],
  rows: [
    {
      profileId: "private-profile-id",
      name: "Alex",
      orgUnitId: "private-unit-id",
      state: "approval_overdue",
      submittedLate: false,
      approvedLate: false,
      status: "submitted",
      awaitsMyApproval: true,
      action: { label: "Review plan", profileId: "private-profile-id" },
    },
  ],
};
describe("manager-first coverage", () => {
  const list = (d: Summary, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <CoveragePlansListView
        data={d}
        q=""
        status={null}
        page={1}
        onSearch={() => {}}
        onFilter={() => {}}
        onPage={() => {}}
        onOpen={() => {}}
        onAdd={() => {}}
        {...extra}
      />,
    );
  it("read-only people can view an existing plan but cannot add a missing one", () => {
    const missing = {
      ...data,
      rows: [
        {
          ...data.rows[0]!,
          status: "not_started",
          awaitsMyApproval: false,
          action: { label: "Start plan", profileId: "person" },
        },
      ],
    };
    expect(list(missing)).not.toContain("Add plan");
    const html = list(missing, { canPlan: true });
    expect(html).toContain("Add plan");
    expect(html).not.toContain("Start plan");
  });
  it("plans list: Add plan top-right, status chips, Review for my queue, no ids", () => {
    const html = list(data, { canPlan: true });
    expect(html.indexOf("Add plan")).toBeLessThan(html.indexOf("Alex"));
    expect(html).toContain("Not started");
    expect(html).toContain(">Review<");
    expect(html).toContain("Approval late");
    expect(html).not.toContain("private-profile-id");
    expect(html).not.toContain("not_started");
    expect(html).not.toContain("Coverage commitments");
  });
  it("plans list search narrows by person", () => {
    const two = {
      ...data,
      rows: [data.rows[0]!, { ...data.rows[0]!, profileId: "p2", name: "Bea" }],
    };
    const html = list(two, { q: "bea" });
    expect(html).toContain("Bea");
    expect(html).not.toContain("Alex");
  });
  it("overview shows readiness with plain months, no ISO", () => {
    const html = renderToStaticMarkup(<CoverageSummaryView data={data} />);
    expect(html).toContain("2 of 5");
    expect(html).toContain("ready for Oct 2026");
    expect(html).toContain("3 ready in Sep 2026");
    expect(html).toContain("1 waiting for my approval");
    expect(html).toContain("Monthly readiness trend");
    expect(html).not.toMatch(/\d{4}-\d{2}/);
    expect(monthLabel("2026-11")).toBe("Nov 2026");
  });
  it("distinguishes missing setup from zero coverage", () => {
    expect(list({ ...data, rows: [] })).toContain("Assign people in Setup");
  });
  it("reviews calls versus governed standard, routes, frequency and received execution", () => {
    const html = renderToStaticMarkup(
      <CoverageStandardsReview
        review={{
          planned: 2,
          visited: 1,
          productive: 0,
          standardSource: "Client memo",
          daily: [{ date: "2026-10-20", calls: 2, target: 5 }],
          routes: [{ code: "Cebu north", stores: 2 }],
          frequencyGaps: [
            {
              outletId: "private-store-id",
              name: "Corner shop",
              planned: 1,
              expected: 4,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("2 calls / 5 standard");
    expect(html).toContain("below standard");
    expect(html).toContain("Cebu north");
    expect(html).toContain("Corner shop: 1 planned / 4");
    expect(html).toContain("1 visited");
    expect(html).not.toContain("private-store-id");
  });
});
