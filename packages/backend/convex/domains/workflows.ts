import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { orderAccessible } from "./orders";

const workflow = v.object({
  _id: v.id("workflowInstances"),
  _creationTime: v.number(),
  entityType: v.string(),
  entityId: v.string(),
  workflowType: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("approved"),
    v.literal("rejected"),
  ),
  currentStep: v.number(),
  requestedBy: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export const pending = query({
  args: {},
  returns: v.array(workflow),
  handler: async (ctx) => {
    const { identity, profile } = await requireCapability(ctx, "order.approve");
    const rows = await ctx.db
      .query("workflowInstances")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(100);
    const visible = [];
    for (const row of rows) {
      // Only order approvals have a resolvable stored scope in the legacy workflow table.
      if (row.entityType !== "order") continue;
      const orderId = ctx.db.normalizeId("orders", row.entityId);
      if (!orderId) continue;
      const order = await ctx.db.get(orderId);
      if (
        order &&
        order.status === "pending_approval" &&
        order.salespersonSubject !== identity.tokenIdentifier &&
        (await orderAccessible(ctx, order, profile, identity.tokenIdentifier))
      )
        visible.push(row);
    }
    return visible;
  },
});
