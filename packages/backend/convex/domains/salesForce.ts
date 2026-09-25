import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";

// Frozen for growth (tracker CVX-002). New SFA capability belongs in dedicated
// packages/backend/convex/<domain>/ modules — coverage, visits, customers, vanSales,
// mobile, analytics — never here. This file keeps only the legacy visit projection and
// is deleted when the coverage and visit domains replace it.

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
