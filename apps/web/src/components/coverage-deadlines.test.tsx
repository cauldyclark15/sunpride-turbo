import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, expect, it, vi } from "vitest";
import { CoverageDeadlines } from "./coverage-deadlines";

const state = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  away: [] as unknown[],
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    if (name === "coverage/away:list") return state.away;
    if (name !== "coverage/calendar:status") return undefined;
    return {
      deadlines: {
        localMonth: "2026-11",
        submissionOpensDate: "2026-10-25",
        submissionDueDate: "2026-10-31",
        approvalDueDate: "2026-11-07",
        submissionOpensAt: 0,
        submissionDueAt: 0,
        approvalDueAt: 0,
      },
      page: [
        {
          profileId: "a",
          name: "Ana Seller",
          orgUnitId: "u",
          supervisorName: "Manager",
          state: "overdue",
          submittedLate: false,
          approvedLate: false,
        },
        {
          profileId: "b",
          name: "Ben Draft",
          orgUnitId: "u",
          planStatus: "draft",
          version: 1,
          state: "due",
          submittedLate: false,
          approvedLate: false,
        },
        {
          profileId: "c",
          name: "Cy Waiting",
          orgUnitId: "u",
          planStatus: "submitted",
          version: 2,
          supervisorName: "Manager",
          state: "approval_overdue",
          submittedLate: true,
          approvedLate: false,
        },
        {
          profileId: "d",
          name: "Di Done",
          orgUnitId: "u",
          planStatus: "approved",
          version: 1,
          approvalCapacity: "backup",
          state: "approved_late",
          submittedLate: false,
          approvedLate: true,
        },
      ],
      isDone: false,
      continueCursor: "next",
    };
  },
  useMutation: () => vi.fn(),
}));

beforeEach(() => {
  state.calls = [];
  state.away = [];
});

it("shows the MCP calendar, the reminder list and late approvals", () => {
  const html = renderToStaticMarkup(
    <CoverageDeadlines
      localMonth="2026-11"
      profileId={"me" as never}
      canApprove={false}
    />,
  );
  expect(html).toContain("Master Coverage Plan (MCP) deadlines · 2026-11");
  expect(html).toContain("Submit between 25 Oct 2026 and 31 Oct 2026");
  expect(html).toContain("approves by 7 Nov 2026");
  const reminders = html.slice(
    html.indexOf('aria-label="MCP reminders"'),
    html.indexOf("Awaiting approval"),
  );
  expect(reminders).toContain("Ana Seller");
  expect(reminders).toContain("No MCP started · supervisor Manager");
  expect(reminders).toContain("Overdue");
  expect(reminders).toContain("Ben Draft");
  expect(reminders).toContain("Draft v1 · supervisor not recorded");
  expect(reminders).not.toContain("Cy Waiting");
  expect(html).toContain("v2 · supervisor Manager · submitted late");
  expect(html).toContain("Approval late");
  expect(html).toContain("Backup approver (supervisor away)");
  expect(html).toContain("Approved late");
  expect(html).toContain("MCP people pages");
  expect(html).not.toContain("My away periods");
  const status = state.calls.find((c) => c.name === "coverage/calendar:status");
  expect(status?.args).toMatchObject({
    localMonth: "2026-11",
    paginationOpts: { numItems: 50, cursor: null },
  });
});

it("lets an MCP approver record their own away periods", () => {
  state.away = [
    {
      _id: "away-1",
      effectiveFrom: Date.parse("2026-10-31T16:00:00Z"),
      effectiveTo: Date.parse("2026-11-03T16:00:00Z"),
      reason: "Annual leave",
    },
  ];
  const html = renderToStaticMarkup(
    <CoverageDeadlines
      localMonth="2026-11"
      profileId={"me" as never}
      canApprove
    />,
  );
  expect(html).toContain("My away periods");
  expect(html).toContain("1 Nov 2026 – 3 Nov 2026");
  expect(html).toContain("Annual leave");
  expect(html).toContain("Record away period");
  expect(
    state.calls.find((c) => c.name === "coverage/away:list")?.args,
  ).toMatchObject({ profileId: "me" });
});
