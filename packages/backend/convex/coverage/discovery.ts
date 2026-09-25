import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { resolveOutletScopeAt } from "../outlets/validation";
import {
  bounded,
  employeeAt,
  monthBounds,
  planAccess,
  planRows,
  MAX_PLAN_ROWS,
} from "./validation";

const status = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("approved"),
  v.literal("active"),
  v.literal("superseded"),
);
const row = v.object({
  planId: v.id("coveragePlans"),
  assigneeProfileId: v.id("profiles"),
  assigneeName: v.string(),
  version: v.number(),
  status,
  localMonth: v.string(),
  orgUnitId: v.id("orgUnits"),
});

async function scopeFor(ctx: QueryCtx) {
  const { profile } = await requireCapability(ctx, "mcp.read");
  const national = profile.role === "super_admin" || profile.role === "analyst";
  const units = national
    ? null
    : new Set(
        profile.orgUnitId
          ? await collectScopeUnitIds(ctx, profile.orgUnitId)
          : [],
      );
  return { profile, units };
}

/** Server-only predicate: callers must still authorize every projected outlet/row. */
export async function scopedPlanPage(
  ctx: QueryCtx,
  candidates: Doc<"coveragePlans">[],
): Promise<{ plan: Doc<"coveragePlans">; assigneeName: string }[]> {
  const { profile, units } = await scopeFor(ctx);
  const visible: { plan: Doc<"coveragePlans">; assigneeName: string }[] = [];
  for (const plan of candidates) {
    if (
      plan.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
      (units && !units.has(plan.orgUnitId)) ||
      (profile.role === "sales" && profile._id !== plan.assigneeProfileId)
    )
      continue;
    const assignee = await ctx.db.get(plan.assigneeProfileId);
    if (!assignee || assignee.status !== "active") continue;
    // A reassigned employee cannot expose an old plan through the old unit.
    let current: Awaited<ReturnType<typeof employeeAt>>;
    try {
      current = await employeeAt(ctx, plan.assigneeProfileId, Date.now());
    } catch (error) {
      if (
        error instanceof ConvexError &&
        /no effective employee assignment/.test(error.message)
      )
        continue;
      throw error;
    }
    if (units && !units.has(current.orgUnitId!)) continue;
    const { outlets, slots } = await planRows(ctx, plan._id);
    let visibleOutlets = true;
    for (const id of new Set<Id<"outlets">>([
      ...outlets.map((o) => o.outletId),
      ...slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
    ])) {
      const owner = await resolveOutletScopeAt(ctx, id, Date.now());
      if (units && !units.has(owner.orgUnitId)) {
        visibleOutlets = false;
        break;
      }
    }
    if (visibleOutlets) visible.push({ plan, assigneeName: assignee.name });
  }
  return visible;
}

export const list = query({
  args: {
    localMonth: v.string(),
    status: v.optional(status),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(row),
  handler: async (
    ctx,
    { localMonth, status: requestedStatus, paginationOpts },
  ) => {
    monthBounds(localMonth);
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 20
    )
      throw new ConvexError("Page size must be 1–20");
    await scopeFor(ctx);
    const plans = requestedStatus
      ? await ctx.db
          .query("coveragePlans")
          .withIndex("by_org_month_status", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("localMonth", localMonth)
              .eq("status", requestedStatus),
          )
          .paginate(paginationOpts)
      : await ctx.db
          .query("coveragePlans")
          .withIndex("by_org_month_status", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("localMonth", localMonth),
          )
          .paginate(paginationOpts);
    const visible = await scopedPlanPage(ctx, plans.page);
    return {
      page: visible.map(({ plan, assigneeName }) => ({
        planId: plan._id,
        assigneeProfileId: plan.assigneeProfileId,
        assigneeName,
        version: plan.version,
        status: plan.status,
        localMonth: plan.localMonth,
        orgUnitId: plan.orgUnitId,
      })),
      isDone: plans.isDone,
      continueCursor: plans.continueCursor,
    };
  },
});

async function actorName(ctx: QueryCtx, token?: string) {
  if (!token) return undefined;
  const subject = token.slice(token.indexOf("|") + 1);
  const person = await ctx.db
    .query("profiles")
    .withIndex("by_subject", (q) => q.eq("authSubject", subject))
    .unique();
  return person?.name || "Former user";
}

export const attribution = query({
  args: { planId: v.id("coveragePlans") },
  returns: v.object({
    preparedByName: v.string(),
    submittedByName: v.optional(v.string()),
    approvedByName: v.optional(v.string()),
    latestReturnReason: v.optional(v.string()),
    latestReturnAt: v.optional(v.number()),
    eventsActorNames: v.record(v.string(), v.string()),
  }),
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    await planAccess(ctx, plan, "mcp.read");
    const { outlets, slots } = await planRows(ctx, planId);
    for (const id of new Set<Id<"outlets">>([
      ...outlets.map((o) => o.outletId),
      ...slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
    ])) {
      const owner = await resolveOutletScopeAt(ctx, id, Date.now());
      await requireCapability(ctx, "mcp.read", owner.orgUnitId);
    }
    const events = await bounded(
      ctx.db
        .query("coverageAuditEvents")
        .withIndex("by_planId_and_createdAt", (q) => q.eq("planId", planId))
        .order("desc")
        .take(MAX_PLAN_ROWS + 1),
      "Plan audit history",
    );
    const latestReturn = events.find((e) => e.action === "plan.returned");
    const names = new Map<string, string>();
    for (const token of new Set(
      [
        plan.preparedBy,
        plan.submittedBy,
        plan.approvedBy,
        ...events.map((e) => e.actorSubject),
      ].filter((value): value is string => !!value),
    ))
      names.set(token, (await actorName(ctx, token))!);
    return {
      preparedByName: names.get(plan.preparedBy)!,
      submittedByName: plan.submittedBy
        ? names.get(plan.submittedBy)
        : undefined,
      approvedByName: plan.approvedBy ? names.get(plan.approvedBy) : undefined,
      latestReturnReason: latestReturn?.reason,
      latestReturnAt: latestReturn?.createdAt,
      eventsActorNames: Object.fromEntries(
        events.map((e) => [e._id, names.get(e.actorSubject)!]),
      ),
    };
  },
});
