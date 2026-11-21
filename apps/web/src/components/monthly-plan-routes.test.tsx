import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  DailyPlanRoutes,
  VisitFrequencyCheck,
  WeeklyPlanReview,
  planningFrequencyGaps,
} from "./monthly-plan-routes";
import type { Detail, WeeklyReview } from "./coverage-model";

const state = vi.hoisted(() => ({
  week: undefined as WeeklyReview | undefined,
}));
vi.mock("./coverage-data", () => ({
  useCoverageQuery: () => state.week,
  useCoverageMutation: () => vi.fn(),
}));
beforeEach(() => {
  state.week = {
    weekStart: "2030-11-11",
    weekEnd: "2030-11-17",
    dueDate: "2030-11-09",
    dueAt: 0,
    reminder: true,
    overdue: false,
    plans: [
      {
        planId: "p",
        month: "2030-11",
        version: 1,
        status: "active",
        fromDate: "2030-11-01",
        toDate: "2030-11-30",
        reviewed: false,
      },
    ],
  };
});
const detail = {
  frequencyRequirements: [
    {
      outletId: "a",
      name: "Customer A",
      planned: 2,
      expected: 4,
      requirement: "4 times a month",
    },
    {
      outletId: "b",
      name: "Omitted customer",
      planned: 0,
      expected: 1,
      requirement: "Monthly",
    },
  ],
  dailyRoutes: [{ _id: "r", code: "001", serviceDate: "2030-11-11" }],
  slots: [
    {
      slotKey: "a",
      serviceDate: "2030-11-11",
      kind: "outlet_visit",
      outletId: "a",
      sequence: 2,
      approvedSnapshot: { outletName: "Customer A" },
    },
    {
      slotKey: "c",
      serviceDate: "2030-11-11",
      kind: "outlet_visit",
      outletId: "c",
      sequence: 1,
      approvedSnapshot: { outletName: "Customer C" },
    },
  ],
} as Detail;
it("updates the office shortfall while editing, includes omitted customers and preserves the retained month prefix", () => {
  expect(planningFrequencyGaps(detail, detail.slots)[0]?.planned).toBe(2);
  const added = ["2030-11-12", "2030-11-13"].map((serviceDate) => ({
    ...detail.slots[0]!,
    serviceDate,
  }));
  const result = planningFrequencyGaps(detail, [...detail.slots, ...added]);
  expect(result.map((r) => r.name)).toEqual(["Omitted customer"]);
  expect(planningFrequencyGaps(detail, [])[0]?.planned).toBe(1);
  // Duplicate activity slots on one date cannot inflate visit frequency.
  expect(
    planningFrequencyGaps(detail, [...detail.slots, detail.slots[0]!])[0]
      ?.planned,
  ).toBe(2);
});
it("shows dated IDs and signed customer names in stop order", () => {
  const html = renderToStaticMarkup(<DailyPlanRoutes detail={detail} />);
  expect(html).toContain("Route 001");
  expect(html).toContain("2030-11-11");
  expect(html.indexOf("Customer C")).toBeLessThan(html.indexOf("Customer A"));
  expect(html).not.toContain("undefined");
});
it("reminds before Saturday, links versions and offers keep or re-approved weekly changes to the salesman", () => {
  const html = renderToStaticMarkup(
    <WeeklyPlanReview personId="s" isSelf onOpen={() => {}} />,
  );
  expect(html).toContain("before Saturday ends");
  expect(html).toContain("2030-11-09");
  expect(html).toContain("Keep these routes");
  expect(html).toContain("Adjust coming week");
  const manager = renderToStaticMarkup(
    <WeeklyPlanReview personId="s" isSelf={false} onOpen={() => {}} />,
  );
  expect(manager).not.toContain("Keep these routes");
});
it("pending revisions cannot be confirmed as reviewed and approved previous routes are explained", () => {
  state.week!.plans.push({
    ...state.week!.plans[0]!,
    planId: "r",
    version: 2,
    status: "submitted",
  });
  const html = renderToStaticMarkup(
    <WeeklyPlanReview personId="s" isSelf onOpen={() => {}} />,
  );
  expect(html).toContain("last approved routes stay in place");
  expect(html).toMatch(/disabled=""[^>]*>Keep these routes/);
});
it("a confirmed week stops its reminders, but uncovered dates prevent a false whole-week success", () => {
  state.week!.plans[0]!.reviewed = true;
  state.week!.overdue = true;
  const done = renderToStaticMarkup(
    <WeeklyPlanReview personId="s" isSelf onOpen={() => {}} />,
  );
  expect(done).toContain("routes have been reviewed");
  expect(done).not.toContain("Weekly review overdue");
  state.week!.missingDates = ["2030-11-15"];
  const gap = renderToStaticMarkup(
    <WeeklyPlanReview personId="s" isSelf onOpen={() => {}} />,
  );
  expect(gap).toContain("still missing for");
  expect(gap).not.toContain("routes have been reviewed");
});
it("Sunday overdue and no approved plan are visible without a false success", () => {
  state.week = { ...state.week!, overdue: true, plans: [] };
  const html = renderToStaticMarkup(
    <WeeklyPlanReview personId="s" isSelf onOpen={() => {}} />,
  );
  expect(html).toContain("Weekly review overdue");
  expect(html).toContain("No approved plan");
  expect(html).not.toContain("Reviewed</span>");
});

it("SP-0224 shows the approver every customer's required vs planned visits and each dated route's stop count", () => {
  const check = renderToStaticMarkup(<VisitFrequencyCheck detail={detail} />);
  expect(check).toContain("2 of 2 customers get fewer visits than required");
  expect(check).toMatch(
    /Customer A<\/td><td[^>]*>4<\/td><td[^>]*>2<\/td><td[^>]*>2</,
  );
  expect(check.indexOf("Customer A")).toBeLessThan(
    check.indexOf("Omitted customer"),
  );
  expect(
    renderToStaticMarkup(
      <VisitFrequencyCheck detail={{ ...detail, frequencyRequirements: [] }} />,
    ),
  ).toBe("");
  const routes = renderToStaticMarkup(<DailyPlanRoutes detail={detail} />);
  expect(routes).toMatch(/Route 001<\/td><td>2030-11-11<\/td><td[^>]*>\d+</);
});
