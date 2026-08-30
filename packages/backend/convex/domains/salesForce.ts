import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";

const visit = v.object({
  _id: v.id("visits"),
  _creationTime: v.number(),
  salespersonSubject: v.string(),
  customerCode: v.string(),
  scheduledAt: v.number(),
  completedAt: v.optional(v.number()),
  notes: v.optional(v.string()),
  status: v.union(
    v.literal("planned"),
    v.literal("completed"),
    v.literal("cancelled"),
  ),
});
export const myVisits = query({
  args: {},
  returns: v.array(visit),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    return ctx.db
      .query("visits")
      .withIndex("by_salesperson_time", (q) =>
        q.eq("salespersonSubject", identity.tokenIdentifier),
      )
      .order("desc")
      .take(100);
  },
});
