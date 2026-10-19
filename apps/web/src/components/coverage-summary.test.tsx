import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CoverageSummaryView,
  CoverageStandardsReview,
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
  it("read-only people can view an existing plan but cannot start a missing one", () => {
    const missing = {
      ...data,
      rows: [
        {
          ...data.rows[0]!,
          status: "not_started",
          action: { label: "Start plan", profileId: "person" },
        },
      ],
    };
    expect(
      renderToStaticMarkup(
        <CoverageSummaryView data={missing} onOpen={() => {}} />,
      ),
    ).not.toContain("Start plan");
    expect(
      renderToStaticMarkup(
        <CoverageSummaryView data={missing} onOpen={() => {}} canPlan />,
      ),
    ).toContain("Start plan");
  });
  it("shows readiness versus target and prior, overdue work, my queue and trend", () => {
    const html = renderToStaticMarkup(
      <CoverageSummaryView data={data} onOpen={() => {}} />,
    );
    expect(html).toContain("2 of 5");
    expect(html).toContain("3 ready in 2026-09");
    expect(html).toContain("1 waiting for my approval");
    expect(html).toContain("2 overdue");
    expect(html).toContain("Monthly readiness trend");
  });
  it("offers a next action and named drill without exposing identifiers", () => {
    const html = renderToStaticMarkup(
      <CoverageSummaryView data={data} onOpen={() => {}} />,
    );
    expect(html).toContain("Alex");
    expect(html).toContain("Review plan");
    expect(html).toContain("Approval late");
    expect(html).not.toContain("private-profile-id");
    expect(html).not.toContain("not_started");
  });
  it("distinguishes missing setup from zero coverage", () => {
    const html = renderToStaticMarkup(
      <CoverageSummaryView data={{ ...data, rows: [] }} onOpen={() => {}} />,
    );
    expect(html).toContain("Assign people in Setup");
    expect(html).toContain("not zero coverage");
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
