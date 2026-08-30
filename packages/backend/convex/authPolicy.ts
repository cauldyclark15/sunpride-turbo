import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import {
  isBootstrapSuperAdminEmail,
  normalizeEmail,
} from "./lib/access";

export const isEmailAllowed = internalQuery({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (isBootstrapSuperAdminEmail(email)) return true;
    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    return invitation !== null && invitation.status !== "revoked";
  },
});
