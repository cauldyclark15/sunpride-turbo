import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  ORG_ROOT_UNIT_CODE,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import { requireActiveProfile } from "./auth";
import { topology } from "../org/validation";

/**
 * Organizational scope helpers (ADR-005).
 *
 * `requireScopedRole` is the gate for NEW endpoints; existing endpoints keep the flat
 * `requireRole` checks until their domain is next modified. Scope is resolved from the
 * authenticated profile on the server and can never be widened by client input.
 */

// As-of topology is capped in org/validation.ts.

/** The active national root, if seeded. Never treat an arbitrary parentless unit as root. */
export async function rootOrgUnitId(ctx: QueryCtx | MutationCtx) {
  const root = await ctx.db
    .query("orgUnits")
    .withIndex("by_organizationId_and_code", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("code", ORG_ROOT_UNIT_CODE),
    )
    .unique();
  return root?.status === "active" && !root.parentId ? root._id : null;
}

/** Gate national data without accepting a client-selected target unit. */
export async function requireNationalScope(
  ctx: QueryCtx | MutationCtx,
  allowed: readonly string[],
) {
  const { identity, profile } = await requireActiveProfile(ctx);
  if (profile.role !== "super_admin" && !allowed.includes(profile.role))
    throw new ConvexError("Insufficient permission");
  if (profile.role === "super_admin") return { identity, profile };
  if (!profile.orgUnitId)
    throw new ConvexError("Your access has no organizational scope");
  const rootId = await rootOrgUnitId(ctx);
  if (!rootId || profile.orgUnitId !== rootId)
    throw new ConvexError(
      "Requested scope is outside your organizational scope",
    );
  return { identity, profile };
}

export async function collectScopeUnitIds(
  ctx: QueryCtx | MutationCtx,
  rootUnitId: Id<"orgUnits">,
): Promise<Id<"orgUnits">[]> {
  const tree = await topology(ctx, Date.now());
  if (!tree.some((unit) => unit._id === rootUnitId))
    throw new ConvexError("Your access has no organizational scope");
  const ids: Id<"orgUnits">[] = [rootUnitId];
  for (let i = 0; i < ids.length; i++) {
    for (const child of tree)
      if (child.parentId === ids[i]) ids.push(child._id);
  }
  return ids;
}

/** Role + organizational scope gate. Omitting targetUnitId checks the role ONLY;
 * never use that mode to guard national data. See ADR-005 and tracker CVX-023. */
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
