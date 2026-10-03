import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { at } from "../territories/route_validation";
import { MAX_PLAN_ROWS, bounded, employeeAt } from "./validation";

type Ctx = QueryCtx | MutationCtx;
export type ApprovalCapacity = "supervisor" | "backup" | "scope_approver";
export type BackupRule = "recorded_manager" | "scope_above" | "none";

/** Effective assignment or null; unlike employeeAt it never throws for a missing row. */
async function assignmentAt(
  ctx: Ctx,
  profileId: Id<"profiles">,
  instant: number,
) {
  const rows = await bounded(
    ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", profileId),
      )
      .take(MAX_PLAN_ROWS + 1),
    "Employee assignment history",
  );
  return at(rows, instant);
}

/** Away periods never overlap, so the latest one starting at or before the instant decides. */
export async function awayPeriodAt(
  ctx: Ctx,
  profileId: Id<"profiles">,
  instant: number,
) {
  const rows = await ctx.db
    .query("supervisorAwayPeriods")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId).lte("effectiveFrom", instant),
    )
    .order("desc")
    .take(20);
  return rows.find((row) => row.effectiveTo > instant) ?? null;
}

export type ApprovalRoute = {
  supervisorId?: Id<"profiles">;
  supervisorUnitId?: Id<"orgUnits">;
  supervisorAvailable: boolean;
  awayPeriod: Doc<"supervisorAwayPeriods"> | null;
  backupId?: Id<"profiles">;
  backupRule: BackupRule;
};

/**
 * CALL-06 routing: the assignee's direct supervisor (effective employee assignment)
 * approves. While that supervisor is away (or no longer active) the supervisor's own
 * recorded supervisor is the backup; without one, an MCP approver whose scope sits
 * above the supervisor's unit is. No recorded supervisor keeps the scoped-approver rule.
 */
export async function approvalRoute(
  ctx: Ctx,
  plan: Doc<"coveragePlans">,
  instant: number,
): Promise<ApprovalRoute> {
  const assignee = await employeeAt(ctx, plan.assigneeProfileId, instant);
  const supervisorId = assignee.supervisorId;
  if (!supervisorId)
    return {
      supervisorAvailable: false,
      awayPeriod: null,
      backupRule: "none",
    };
  const supervisor = await ctx.db.get(supervisorId);
  const supervisorAssignment = await assignmentAt(ctx, supervisorId, instant);
  const awayPeriod = await awayPeriodAt(ctx, supervisorId, instant);
  const backupId = supervisorAssignment?.supervisorId;
  return {
    supervisorId,
    supervisorUnitId:
      supervisorAssignment?.orgUnitId ?? supervisor?.orgUnitId ?? undefined,
    supervisorAvailable: supervisor?.status === "active" && !awayPeriod,
    awayPeriod,
    backupId,
    backupRule: backupId ? "recorded_manager" : "scope_above",
  };
}

/**
 * Throws unless the approver may decide this MCP right now; returns the capacity to record.
 * Self-approval and preparer/submitter independence are checked by the caller.
 */
export async function approvalCapacity(
  ctx: Ctx,
  plan: Doc<"coveragePlans">,
  approver: Doc<"profiles">,
  instant: number,
): Promise<{
  capacity: ApprovalCapacity;
  onBehalfOf?: Id<"profiles">;
  route: ApprovalRoute;
}> {
  const route = await approvalRoute(ctx, plan, instant);
  if (!route.supervisorId) return { capacity: "scope_approver", route };
  if (approver._id === route.supervisorId)
    return { capacity: "supervisor", route };
  if (route.supervisorAvailable)
    throw new ConvexError(
      "The direct supervisor approves this MCP; backup approval applies only while the supervisor is away",
    );
  if (route.backupRule === "recorded_manager") {
    if (approver._id !== route.backupId)
      throw new ConvexError(
        "While the supervisor is away, only the supervisor's manager approves this MCP",
      );
  } else {
    if (route.supervisorUnitId) {
      await requireCapability(ctx, "mcp.approve", route.supervisorUnitId);
      if (approver.orgUnitId === route.supervisorUnitId)
        throw new ConvexError(
          "Backup approval needs an approver above the supervisor's unit",
        );
    }
  }
  return { capacity: "backup", onBehalfOf: route.supervisorId, route };
}
