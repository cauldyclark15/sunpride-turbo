import { describe, expect, it } from "vitest";
import { deadlinePlan, mcpDeadlineState, mcpDeadlines } from "./calendar_rules";
import { localDate } from "./validation";

describe("MCP calendar rules", () => {
  it("opens submission in the last 7 days of the previous month and approval by day 7", () => {
    expect(mcpDeadlines("2026-11")).toMatchObject({
      submissionOpensDate: "2026-10-25",
      submissionDueDate: "2026-10-31",
      approvalDueDate: "2026-11-07",
      submissionOpensAt: localDate("2026-10-25"),
      submissionDueAt: localDate("2026-11-01"),
      approvalDueAt: localDate("2026-11-08"),
    });
    expect(mcpDeadlines("2027-01")).toMatchObject({
      submissionOpensDate: "2026-12-25",
      submissionDueDate: "2026-12-31",
    });
    expect(mcpDeadlines("2028-03").submissionOpensDate).toBe("2028-02-23");
    expect(mcpDeadlines("2026-03").submissionOpensDate).toBe("2026-02-22");
    expect(() => mcpDeadlines("2026-13")).toThrow();
  });

  it("derives due, overdue and late states", () => {
    const d = mcpDeadlines("2026-11");
    const state = (plan: Parameters<typeof mcpDeadlineState>[1], now: number) =>
      mcpDeadlineState(d, plan, now);
    expect(state(null, d.submissionOpensAt - 1).state).toBe("not_open");
    expect(state(null, d.submissionOpensAt).state).toBe("due");
    expect(state({ status: "draft" }, d.submissionDueAt - 1).state).toBe("due");
    expect(state({ status: "draft" }, d.submissionDueAt).state).toBe("overdue");
    expect(
      state(
        { status: "submitted", submittedAt: d.submissionDueAt + 5 },
        d.approvalDueAt - 1,
      ),
    ).toEqual({
      state: "awaiting_approval",
      submittedLate: true,
      approvedLate: false,
    });
    expect(
      state({ status: "submitted", submittedAt: 1 }, d.approvalDueAt).state,
    ).toBe("approval_overdue");
    expect(
      state(
        { status: "active", submittedAt: 1, approvedAt: d.approvalDueAt - 1 },
        d.approvalDueAt + 99,
      ),
    ).toEqual({ state: "approved", submittedLate: false, approvedLate: false });
    expect(
      state(
        { status: "approved", submittedAt: 1, approvedAt: d.approvalDueAt },
        0,
      ).state,
    ).toBe("approved_late");
  });

  it("judges the month by its original MCP, not a revision", () => {
    const pick = deadlinePlan([
      { status: "draft" as const, version: 3, basedOnPlanId: "x" },
      { status: "superseded" as const, version: 1 },
      { status: "draft" as const, version: 2 },
    ]);
    expect(pick).toMatchObject({ version: 1 });
    expect(deadlinePlan([])).toBeNull();
  });
});
