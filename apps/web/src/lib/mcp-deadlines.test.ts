import { describe, expect, it } from "vitest";
import type { McpDeadlineState as ServerState } from "../../../../packages/backend/convex/coverage/calendar_rules";
import {
  capacityLabel,
  deadlineDate,
  deadlineStateLabel,
  needsSubmissionReminder,
  type McpDeadlineState,
} from "./mcp-deadlines";

// Compile-time parity with the server's state union, both directions.
const toServer = (state: McpDeadlineState): ServerState => state;
const fromServer = (state: ServerState): McpDeadlineState => state;

describe("MCP deadline labels", () => {
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
    expect(
      states.map((s) => deadlineStateLabel(fromServer(toServer(s)))),
    ).toEqual([
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
