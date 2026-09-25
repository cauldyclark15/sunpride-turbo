import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, query } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { topology } from "../org/validation";
import { requireActiveProfile } from "./auth";
import { collectScopeUnitIds } from "./scope";
import type { AppRole } from "./roles";

/**
 * Capability gate (ADR-009).
 *
 * Endpoints ask for a CAPABILITY, never for a job title or a bare role string. The table
 * below is the whole permission surface; adding a new client title changes `positions`, not
 * this file.
 *
 * Roles listed in `CROSS_SCOPE_ROLES` read the whole organization: `super_admin` by design,
 * `analyst` because the memo CCs Finance/Treasury with claims and AR reckoning for the
 * national book. Cross-scope roles are read-only by their capability list — the scope bypass
 * must never be paired with a write capability.
 */
export const CAPABILITIES = {
  "admin.manage": ["super_admin", "admin"],
  "org.read": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ],
  "people.read": ["super_admin", "admin", "manager", "analyst", "viewer"],
  "masterdata.manage": ["super_admin", "admin", "operations"],
  "inventory.read": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ],
  "inventory.write": ["super_admin", "admin", "operations"],
  "inventory.approve": ["super_admin", "approver"],
  "inventory.adjustment.request": [
    "super_admin",
    "admin",
    "operations",
    "manager",
  ],
  "inventory.count.submit": ["super_admin", "admin", "operations", "manager"],
  "inventory.adjustment.approve": [
    "super_admin",
    "admin",
    "manager",
    "approver",
  ],
  "inventory.count.approve": ["super_admin", "admin", "manager", "approver"],
  "mcp.read": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ],
  "mcp.plan": ["super_admin", "admin", "manager", "sales"],
  "mcp.approve": ["super_admin", "manager"],
  "visit.record": ["super_admin", "manager", "sales"],
  "visit.read": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ],
  "order.create": ["super_admin", "manager", "sales"],
  "order.approve": ["super_admin", "manager", "approver"],
  "deliverable.submit": ["super_admin", "manager", "sales"],
  "deliverable.review": ["super_admin", "manager"],
  "perdiem.submit": ["super_admin", "manager", "sales"],
  "perdiem.approve": ["super_admin", "manager", "approver"],
  "report.read": [
    "super_admin",
    "admin",
    "operations",
    "manager",
    "approver",
    "sales",
    "analyst",
    "viewer",
  ],
  "integration.read": ["super_admin", "admin", "operations"],
  "integration.manage": ["super_admin", "admin"],
} as const satisfies Record<string, readonly AppRole[]>;

export type Capability = keyof typeof CAPABILITIES;

/** Read capabilities are the ones ending in `.read`; `capabilities.test.ts` asserts that
 * every capability `analyst` holds is one of them (cross-scope access must stay read-only). */
export function isReadOnlyCapability(capability: Capability): boolean {
  return capability.endsWith(".read");
}

const CROSS_SCOPE_ROLES: readonly AppRole[] = ["super_admin", "analyst"];

export function isCapability(value: string): value is Capability {
  return Object.hasOwn(CAPABILITIES, value);
}

export function capabilityRoles(capability: Capability): readonly AppRole[] {
  return CAPABILITIES[capability];
}

/**
 * Throws unless the caller's role holds the capability AND, when a target unit is given,
 * that unit sits inside the caller's organizational subtree (ADR-005). Client input can
 * never widen either check. Omitting targetUnitId checks the capability ONLY; national
 * data must use requireNationalScope instead.
 */
export async function requireCapability(
  ctx: QueryCtx | MutationCtx,
  capability: Capability,
  targetUnitId?: Id<"orgUnits">,
) {
  const { identity, profile } = await requireActiveProfile(ctx);
  const allowed = capabilityRoles(capability);
  if (
    profile.role !== "super_admin" &&
    !allowed.includes(profile.role as AppRole)
  )
    throw new ConvexError("Insufficient permission");
  if (!targetUnitId || CROSS_SCOPE_ROLES.includes(profile.role as AppRole))
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

export const currentPermissions = query({
  args: {},
  returns: v.object({
    version: v.literal(1),
    role: v.string(),
    orgUnitId: v.union(v.id("orgUnits"), v.null()),
    scopeUnitIds: v.array(v.id("orgUnits")),
    capabilities: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const { profile } = await requireActiveProfile(ctx);
    const capabilities = Object.entries(CAPABILITIES)
      .filter(
        ([, roles]) =>
          profile.role === "super_admin" ||
          (roles as readonly string[]).includes(profile.role),
      )
      .map(([name]) => name);
    const scopeUnitIds =
      profile.role === "super_admin" || profile.role === "analyst"
        ? (await topology(ctx, Date.now())).map((u) => u._id)
        : profile.orgUnitId
          ? await collectScopeUnitIds(ctx, profile.orgUnitId)
          : [];
    if (scopeUnitIds.length > 500)
      throw new ConvexError(
        "Organizational scope exceeds the supported hierarchy size",
      );
    return {
      version: 1 as const,
      role: profile.role,
      orgUnitId: profile.orgUnitId ?? null,
      scopeUnitIds,
      capabilities,
    };
  },
});

/**
 * Diagnostic entry point for the capability contract, exercised by `capabilities.test.ts`
 * and usable from the CLI (`bunx convex run lib/capabilities:assertCapability '{...}'`).
 * New SFA endpoints call `requireCapability` directly.
 */
export const assertCapability = internalMutation({
  args: {
    capability: v.string(),
    targetUnitId: v.optional(v.id("orgUnits")),
  },
  returns: v.object({
    role: v.string(),
    orgUnitId: v.union(v.id("orgUnits"), v.null()),
    organizationId: v.string(),
  }),
  handler: async (ctx, args) => {
    if (!isCapability(args.capability))
      throw new ConvexError(`Unknown capability: ${args.capability}`);
    const { profile } = await requireCapability(
      ctx,
      args.capability,
      args.targetUnitId,
    );
    return {
      role: profile.role,
      orgUnitId: profile.orgUnitId ?? null,
      organizationId: SUNPRIDE_ORGANIZATION_ID,
    };
  },
});
