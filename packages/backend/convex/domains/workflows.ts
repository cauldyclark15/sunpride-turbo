import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";

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
    await requireIdentity(ctx);
    return ctx.db
      .query("workflowInstances")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(100);
  },
});
