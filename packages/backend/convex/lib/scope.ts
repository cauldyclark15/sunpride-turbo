import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireActiveProfile } from "./auth";

/**
 * Organizational scope helpers (ADR-005).
 *
 * `requireScopedRole` is the gate for NEW endpoints; existing endpoints keep the flat
 * `requireRole` checks until their domain is next modified. Scope is resolved from the
 * authenticated profile on the server and can never be widened by client input.
 */

const MAX_SCOPE_UNITS = 500;

export async function collectScopeUnitIds(
  ctx: QueryCtx | MutationCtx,
  rootUnitId: Id<"orgUnits">,
): Promise<Id<"orgUnits">[]> {
  const ids: Id<"orgUnits">[] = [rootUnitId];
  const queue: Id<"orgUnits">[] = [rootUnitId];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    const children = await ctx.db
      .query("orgUnits")
      .withIndex("by_organizationId_and_parentId", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("parentId", parent),
      )
      .take(MAX_SCOPE_UNITS);
    for (const child of children) {
      if (child.status !== "active") continue;
      ids.push(child._id);
      queue.push(child._id);
    }
    if (ids.length > MAX_SCOPE_UNITS)
      throw new ConvexError(
        "Organizational scope exceeds the supported hierarchy size",
      );
  }
  return ids;
}

/** Role + organizational scope gate. See ADR-005 and tracker CVX-023. */
export async function requireScopedRole(
  ctx: QueryCtx | MutationCtx,
  allowed: readonly string[],
  targetUnitId?: Id<"orgUnits">,
) {
  const { identity, profile } = await requireActiveProfile(ctx);
  if (profile.role !== "super_admin" && !allowed.includes(profile.role))
    throw new ConvexError("Insufficient permission");
  if (!targetUnitId || profile.role === "super_admin")
    return { identity, profile };
  if (!profile.orgUnitId)
    throw new ConvexError("Your access has no organizational scope");
  const scope = await collectScopeUnitIds(ctx, profile.orgUnitId);
  if (!scope.includes(targetUnitId))
    throw new ConvexError(
      "Requested scope is outside your organizational scope",
    );
  return { identity, profile };
}

/**
 * Diagnostic entry point for the scope contract, exercised by `scope.test.ts` and usable
 * from the CLI. Import endpoints call `requireScopedRole` directly.
 */
export const assertScopeAccess = internalMutation({
  args: {
    roles: v.array(v.string()),
    targetUnitId: v.optional(v.id("orgUnits")),
  },
  returns: v.object({
    orgUnitId: v.union(v.id("orgUnits"), v.null()),
    role: v.string(),
  }),
  handler: async (ctx, args) => {
    const { profile } = await requireScopedRole(
      ctx,
      args.roles,
      args.targetUnitId,
    );
    return { orgUnitId: profile.orgUnitId ?? null, role: profile.role };
  },
});
