import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { BOOTSTRAP_SUPER_ADMIN_EMAIL } from "./lib/access";

export const bootstrapSuperAdmin = internalMutation({
  args: {},
  returns: v.object({
    email: v.string(),
    invitationCreated: v.boolean(),
    profilePromoted: v.boolean(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) =>
        q.eq("email", BOOTSTRAP_SUPER_ADMIN_EMAIL),
      )
      .unique();

    if (invitation) {
      await ctx.db.patch(invitation._id, {
        role: "super_admin",
        status: invitation.status === "accepted" ? "accepted" : "pending",
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("accessInvitations", {
        email: BOOTSTRAP_SUPER_ADMIN_EMAIL,
        role: "super_admin",
        status: "pending",
        invitedBy: "system:bootstrap",
        invitedAt: now,
        updatedAt: now,
      });
    }

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) =>
        q.eq("email", BOOTSTRAP_SUPER_ADMIN_EMAIL),
      )
      .unique();
    if (profile)
      await ctx.db.patch(profile._id, {
        role: "super_admin",
        status: "active",
        updatedAt: now,
      });

    return {
      email: BOOTSTRAP_SUPER_ADMIN_EMAIL,
      invitationCreated: invitation === null,
      profilePromoted: profile !== null,
    };
  },
});
