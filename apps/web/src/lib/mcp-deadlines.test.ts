import { describe, expect, it } from "vitest";
import { deadlineState } from "../../../api/src/domains/coverage/deadlines.js";
import {
  capacityLabel,
  deadlineDate,
  deadlineStateLabel,
  needsSubmissionReminder,
  type McpDeadlineState,
} from "./mcp-deadlines";

describe("MCP deadline labels", () => {
  it("labels every deadline state emitted by the Bun API", () => {
    const deadlines = {
      localMonth: "2026-10",
      submissionOpensDate: "2026-09-24",
      submissionDueDate: "2026-09-30",
      approvalDueDate: "2026-10-07",
      submissionOpensAt: 10,
      submissionDueAt: 20,
      approvalDueAt: 30,
    };
    const emitted = [
      deadlineState(deadlines, null, 0).state,
      deadlineState(deadlines, null, 15).state,
      deadlineState(deadlines, null, 25).state,
      deadlineState(deadlines, { status: "submitted" }, 25).state,
      deadlineState(deadlines, { status: "submitted" }, 35).state,
      deadlineState(deadlines, { status: "approved", approved_at: 25 }, 35)
        .state,
      deadlineState(deadlines, { status: "approved", approved_at: 35 }, 35)
        .state,
    ];
    expect(emitted).toEqual([
      "not_open",
      "due",
      "overdue",
      "awaiting_approval",
      "approval_overdue",
      "approved",
      "approved_late",
    ]);
    for (const state of emitted)
      expect(deadlineStateLabel(state as McpDeadlineState)).toBeDefined();
  });
  it("labels every state with a tone", () => {
    const states: McpDeadlineState[] = [
      "not_open",
      "due",
      "overdue",
      "awaiting_approval",
      "approval_overdue",
      "approved",
      "approved_late",
    ];
    expect(states.map((s) => deadlineStateLabel(s))).toEqual([
      { label: "Not yet due", tone: "neutral" },
      { label: "Due", tone: "warning" },
      { label: "Overdue", tone: "danger" },
      { label: "Awaiting approval", tone: "warning" },
      { label: "Approval late", tone: "danger" },
      { label: "Approved", tone: "success" },
      { label: "Approved late", tone: "warning" },
    ]);
    expect(states.filter(needsSubmissionReminder)).toEqual([
      "not_open",
      "due",
      "overdue",
    ]);
  });

  it("formats Manila dates without host timezone drift and names capacities", () => {
    expect(deadlineDate("2026-10-31")).toBe("31 Oct 2026");
    expect(capacityLabel("backup")).toBe("Backup approver (supervisor away)");
    expect(capacityLabel("supervisor")).toBe("Direct supervisor");
    expect(capacityLabel("scope_approver")).toContain("no supervisor recorded");
  });
});
