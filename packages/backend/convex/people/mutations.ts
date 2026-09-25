import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { assignableRoleValidator } from "../lib/roles";
import { writeAssignment } from "./validation";

export const assign = mutation({
  args: {
    profileId: v.id("profiles"),
    orgUnitId: v.id("orgUnits"),
    role: assignableRoleValidator,
    positionId: v.optional(v.id("positions")),
    supervisorId: v.optional(v.id("profiles")),
    employeeCode: v.optional(v.string()),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.profileId);
    if (!target) throw new ConvexError("Profile not found");
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Reason required");
    await writeAssignment(ctx, target, args, reason);
    return null;
  },
});
