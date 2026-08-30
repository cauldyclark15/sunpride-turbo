import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function requireAuthenticatedIdentity(
  ctx: QueryCtx | MutationCtx,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Authentication required");
  return identity;
}

export async function requireActiveProfile(ctx: QueryCtx | MutationCtx) {
  const identity = await requireAuthenticatedIdentity(ctx);
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_subject", (q) =>
      q.eq("authSubject", identity.tokenIdentifier),
    )
    .unique();
  if (!profile || profile.status !== "active")
    throw new ConvexError("Your Sunpride access has not been provisioned");
  return { identity, profile };
}

export async function requireIdentity(ctx: QueryCtx | MutationCtx) {
  const { identity } = await requireActiveProfile(ctx);
  return identity;
}

export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  allowed: readonly string[],
) {
  const { identity, profile } = await requireActiveProfile(ctx);
  if (profile.role !== "super_admin" && !allowed.includes(profile.role))
    throw new ConvexError("Insufficient permission");
  return { identity, profile };
}
