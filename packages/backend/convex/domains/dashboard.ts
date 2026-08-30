import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";

export const summary = query({
  args: {},
  returns: v.object({
    productCount: v.number(),
    customerCount: v.number(),
    lowStockCount: v.number(),
    openOrderCount: v.number(),
    pendingApprovalCount: v.number(),
    salesToday: v.number(),
    updatedAt: v.number(),
  }),
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const metrics = await ctx.db
      .query("metrics")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    return metrics
      ? {
          productCount: metrics.productCount,
          customerCount: metrics.customerCount,
          lowStockCount: metrics.lowStockCount,
          openOrderCount: metrics.openOrderCount,
          pendingApprovalCount: metrics.pendingApprovalCount,
          salesToday: metrics.salesToday,
          updatedAt: metrics.updatedAt,
        }
      : {
          productCount: 0,
          customerCount: 0,
          lowStockCount: 0,
          openOrderCount: 0,
          pendingApprovalCount: 0,
          salesToday: 0,
          updatedAt: 0,
        };
  },
});
