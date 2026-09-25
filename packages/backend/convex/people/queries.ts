import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import schema from "../schema";

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("profiles")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "people.read");
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 100)
      throw new ConvexError("Page size must be 1–100");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : profile.orgUnitId
          ? new Set(await collectScopeUnitIds(ctx, profile.orgUnitId))
          : new Set();
    const result = await ctx.db.query("profiles").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.filter(
        (p) => !scope || (p.orgUnitId && scope.has(p.orgUnitId)),
      ),
    };
  },
});

export const history = query({
  args: { profileId: v.id("profiles") },
  returns: v.array(schema.doc("employeeAssignments")),
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.profileId);
    if (!target) throw new ConvexError("Profile not found");
    if (target.orgUnitId)
      await requireCapability(ctx, "people.read", target.orgUnitId);
    else {
      const { profile } = await requireCapability(ctx, "people.read");
      if (profile.role !== "super_admin")
        throw new ConvexError(
          "Requested scope is outside your organizational scope",
        );
    }
    return ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", target._id),
      )
      .take(500);
  },
});
