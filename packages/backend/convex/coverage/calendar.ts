import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import { approvalCapacity, approvalRoute } from "./approval_route";
import { deadlinePlan, mcpDeadlineState, mcpDeadlines } from "./calendar_rules";
import { scopeFor } from "./discovery";
import {
  MAX_PLAN_ROWS,
  bounded,
  employeeAt,
  manilaDate,
  monthBounds,
  planAccess,
} from "./validation";

const DAY = 86_400_000;
const state = v.union(
  v.literal("not_open"),
  v.literal("due"),
  v.literal("overdue"),
  v.literal("awaiting_approval"),
  v.literal("approval_overdue"),
  v.literal("approved"),
  v.literal("approved_late"),
);
const planStatus = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("approved"),
  v.literal("active"),
  v.literal("superseded"),
);
const capacity = v.union(
  v.literal("supervisor"),
  v.literal("backup"),
  v.literal("scope_approver"),
);
const deadlines = v.object({
  localMonth: v.string(),
  submissionOpensDate: v.string(),
  submissionDueDate: v.string(),
  approvalDueDate: v.string(),
  submissionOpensAt: v.number(),
  submissionDueAt: v.number(),
  approvalDueAt: v.number(),
});
const personRow = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  orgUnitId: v.id("orgUnits"),
  supervisorName: v.optional(v.string()),
  planId: v.optional(v.id("coveragePlans")),
  version: v.optional(v.number()),
  planStatus: v.optional(planStatus),
  submittedAt: v.optional(v.number()),
  approvedAt: v.optional(v.number()),
  approvalCapacity: v.optional(capacity),
  state,
  submittedLate: v.boolean(),
  approvedLate: v.boolean(),
});

function checkAsOf(asOf: number) {
  if (!Number.isFinite(asOf) || asOf <= 0)
    throw new ConvexError("Invalid asOf");
}

async function personStatus(
  ctx: QueryCtx,
  person: Doc<"profiles">,
  orgUnitId: Id<"orgUnits">,
  supervisorId: Id<"profiles"> | undefined,
  localMonth: string,
  asOf: number,
) {
  const plans = await bounded(
    ctx.db
      .query("coveragePlans")
      .withIndex("by_org_assignee_month_version", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("assigneeProfileId", person._id)
          .eq("localMonth", localMonth),
      )
      .take(MAX_PLAN_ROWS + 1),
    "Plan version history",
  );
  const plan = deadlinePlan(plans);
  const timing = mcpDeadlineState(mcpDeadlines(localMonth), plan, asOf);
  const supervisor = supervisorId ? await ctx.db.get(supervisorId) : null;
  return {
    profileId: person._id,
    name: person.name,
    orgUnitId,
    supervisorName: supervisor?.name,
    planId: plan?._id,
    version: plan?.version,
    planStatus: plan?.status,
    submittedAt: plan?.submittedAt,
    approvedAt: plan?.approvedAt,
    approvalCapacity: plan?.approvalCapacity,
    ...timing,
  };
}

/**
 * MCP deadline status per field salesperson for a month, scoped like plan discovery.
 * Rows without a submitted plan are the reminder list. A filtered page may be empty
 * while `isDone` is false; keep paging.
 */
export const status = query({
  args: {
    localMonth: v.string(),
    asOf: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    deadlines,
    page: v.array(personRow),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { localMonth, asOf, paginationOpts }) => {
    monthBounds(localMonth);
    checkAsOf(asOf);
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 50
    )
      throw new ConvexError("Page size must be 1–50");
    const window = mcpDeadlines(localMonth);
    const { profile, units } = await scopeFor(ctx);
    const visible = async (person: Doc<"profiles">) => {
      if (person.status !== "active") return null;
      let assignment: Awaited<ReturnType<typeof employeeAt>>;
      try {
        assignment = await employeeAt(ctx, person._id, asOf);
      } catch (error) {
        if (error instanceof ConvexError) return null;
        throw error;
      }
      if (units && !units.has(assignment.orgUnitId!)) return null;
      return personStatus(
        ctx,
        person,
        assignment.orgUnitId!,
        assignment.supervisorId,
        localMonth,
        asOf,
      );
    };
    if (profile.role === "sales") {
      const own = await visible(profile);
      return {
        deadlines: window,
        page: own ? [own] : [],
        isDone: true,
        continueCursor: "",
      };
    }
    const people = await ctx.db
      .query("profiles")
      .withIndex("by_role", (q) => q.eq("role", "sales"))
      .paginate(paginationOpts);
    const page = [];
    for (const person of people.page) {
      const row = await visible(person);
      if (row) page.push(row);
    }
    return {
      deadlines: window,
      page,
      isDone: people.isDone,
      continueCursor: people.continueCursor,
    };
  },
});

/** Who approves this MCP right now, whether the viewer may, and its deadline state. */
export const approvalView = query({
  args: { planId: v.id("coveragePlans"), asOf: v.number() },
  returns: v.object({
    supervisorName: v.optional(v.string()),
    supervisorAway: v.boolean(),
    awayUntilDate: v.optional(v.string()),
    backupName: v.optional(v.string()),
    backupRule: v.union(
      v.literal("recorded_manager"),
      v.literal("scope_above"),
      v.literal("none"),
    ),
    viewerCapacity: v.optional(capacity),
    viewerBlockedReason: v.optional(v.string()),
    viewerIsBackupManager: v.boolean(),
    supervisorProfileId: v.optional(v.id("profiles")),
    approvedCapacity: v.optional(capacity),
    approverName: v.optional(v.string()),
    onBehalfOfName: v.optional(v.string()),
    deadlines,
    deadlineState: v.optional(state),
    submittedLate: v.boolean(),
    approvedLate: v.boolean(),
  }),
  handler: async (ctx, { planId, asOf }) => {
    checkAsOf(asOf);
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    const access = await planAccess(ctx, plan, "mcp.read");
    const route = await approvalRoute(ctx, plan, asOf);
    const name = async (id?: Id<"profiles">) =>
      id ? ((await ctx.db.get(id))?.name ?? "Former user") : undefined;
    let viewerCapacity: Doc<"coveragePlans">["approvalCapacity"];
    let viewerBlockedReason: string | undefined;
    if (
      access.profile.role !== "super_admin" &&
      !capabilityRoles("mcp.approve").includes(access.profile.role as AppRole)
    )
      viewerBlockedReason = "No MCP approval permission";
    else if (access.profile._id === plan.assigneeProfileId)
      viewerBlockedReason = "Independent approver required";
    else
      try {
        viewerCapacity = (
          await approvalCapacity(ctx, plan, access.profile, asOf)
        ).capacity;
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error;
        viewerBlockedReason = String(error.data);
      }
    const window = mcpDeadlines(plan.localMonth);
    const timing = mcpDeadlineState(window, plan, asOf);
    return {
      supervisorName: await name(route.supervisorId),
      supervisorAway: !!route.supervisorId && !route.supervisorAvailable,
      awayUntilDate: route.awayPeriod
        ? manilaDate(route.awayPeriod.effectiveTo - DAY)
        : undefined,
      backupName: await name(route.backupId),
      backupRule: route.backupRule,
      viewerCapacity,
      viewerBlockedReason,
      viewerIsBackupManager:
        !!route.backupId && route.backupId === access.profile._id,
      supervisorProfileId: route.supervisorId,
      approvedCapacity: plan.approvalCapacity,
      approverName: await name(plan.approverProfileId),
      onBehalfOfName: await name(plan.approvedOnBehalfOfProfileId),
      deadlines: window,
      // Revisions are approved mid-month by design; only the original carries deadlines.
      deadlineState: plan.basedOnPlanId ? undefined : timing.state,
      submittedLate: !plan.basedOnPlanId && timing.submittedLate,
      approvedLate: !plan.basedOnPlanId && timing.approvedLate,
    };
  },
});
