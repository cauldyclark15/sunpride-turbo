import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { rootOrgUnitId } from "../lib/scope";

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
    restricted: v.boolean(),
  }),
  handler: async (ctx) => {
    const { profile } = await requireCapability(ctx, "report.read");
    const rootId = await rootOrgUnitId(ctx);
    const restricted =
      profile.role !== "super_admin" &&
      profile.role !== "analyst" &&
      (!rootId || profile.orgUnitId !== rootId);
    if (restricted)
      return {
        productCount: 0,
        customerCount: 0,
        lowStockCount: 0,
        openOrderCount: 0,
        pendingApprovalCount: 0,
        salesToday: 0,
        updatedAt: 0,
        restricted: true,
      };
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
          restricted: false,
        }
      : {
          productCount: 0,
          customerCount: 0,
          lowStockCount: 0,
          openOrderCount: 0,
          pendingApprovalCount: 0,
          salesToday: 0,
          updatedAt: 0,
          restricted: false,
        };
  },
});
