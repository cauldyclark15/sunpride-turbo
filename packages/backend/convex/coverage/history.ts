import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import schema from "../schema";
import { planAccess } from "./validation";

export const list = query({
  args: {
    planId: v.id("coveragePlans"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(schema.doc("coverageAuditEvents")),
  handler: async (ctx, { planId, paginationOpts }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    await planAccess(ctx, plan, "mcp.read");
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 100
    )
      throw new ConvexError("Page size must be 1–100");
    return ctx.db
      .query("coverageAuditEvents")
      .withIndex("by_planId_and_createdAt", (q) => q.eq("planId", planId))
      .order("desc")
      .paginate(paginationOpts);
  },
});
