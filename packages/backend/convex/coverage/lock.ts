import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MAX_PLAN_ROWS } from "./validation";

/** Protect the entire signed plan interval, not only the dates on which it has slots. */
export async function assertNotLockedByApprovedPlan(
  ctx: MutationCtx,
  args: {
    outletIds: Id<"outlets">[];
    routeIds: Id<"routes">[];
    from: number;
    to?: number;
  },
) {
  if (
    !Number.isFinite(args.from) ||
    (args.to !== undefined &&
      (!Number.isFinite(args.to) || args.to < args.from))
  )
    throw new ConvexError("Invalid lock interval");
  const planIds = new Set<Id<"coveragePlans">>();
  for (const outletId of new Set(args.outletIds)) {
    const slots = await ctx.db
      .query("coveragePlanSlots")
      .withIndex("by_outletId_and_serviceDate", (q) =>
        q.eq("outletId", outletId),
      )
      .take(MAX_PLAN_ROWS + 1);
    const outlets = await ctx.db
      .query("coveragePlanOutlets")
      .withIndex("by_outletId_and_planId", (q) => q.eq("outletId", outletId))
      .take(MAX_PLAN_ROWS + 1);
    if (slots.length > MAX_PLAN_ROWS || outlets.length > MAX_PLAN_ROWS)
      throw new ConvexError("Coverage lock lookup exceeds limit");
    for (const row of [...slots, ...outlets]) planIds.add(row.planId);
  }
  for (const routeId of new Set(args.routeIds)) {
    const slots = await ctx.db
      .query("coveragePlanSlots")
      .withIndex("by_routeId_and_serviceDate", (q) => q.eq("routeId", routeId))
      .take(MAX_PLAN_ROWS + 1);
    if (slots.length > MAX_PLAN_ROWS)
      throw new ConvexError("Coverage lock lookup exceeds limit");
    for (const row of slots) planIds.add(row.planId);
  }
  if (planIds.size > MAX_PLAN_ROWS)
    throw new ConvexError("Coverage lock lookup exceeds limit");
  for (const id of planIds) {
    const plan = await ctx.db.get(id);
    if (!plan || !["approved", "active", "superseded"].includes(plan.status))
      continue;
    const end = Math.min(plan.effectiveTo, plan.activeThrough ?? Infinity);
    if (args.from < end && plan.effectiveFrom < (args.to ?? Infinity))
      throw new ConvexError("Revise the approved coverage plan first");
  }
}
