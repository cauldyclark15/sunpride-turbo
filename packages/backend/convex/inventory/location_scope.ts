import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, mutation } from "../_generated/server";
import { requireCapability, type Capability } from "../lib/capabilities";
import {
  collectScopeUnitIds,
  requireNationalScope,
  rootOrgUnitId,
} from "../lib/scope";
import { topology } from "../org/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";

/** Never accept a caller-supplied unit as proof of inventory ownership. */
export async function requireLocationCapability(
  ctx: QueryCtx | MutationCtx,
  capability: Capability,
  locationId: Id<"inventoryLocations">,
) {
  const location = await ctx.db.get(locationId);
  if (
    !location ||
    !location.active ||
    location.organizationId !== SUNPRIDE_ORGANIZATION_ID
  )
    throw new ConvexError("Active inventory location not found");
  if (!location.orgUnitId) {
    const { identity, profile } = await requireCapability(ctx, capability);
    if (profile.role !== "super_admin")
      await requireNationalScope(ctx, ["admin"]);
    return { identity, profile, location };
  }
  const { identity, profile } = await requireCapability(
    ctx,
    capability,
    location.orgUnitId,
  );
  return { identity, profile, location };
}

export async function readableLocationIds(ctx: QueryCtx | MutationCtx) {
  const { profile } = await requireCapability(ctx, "inventory.read");
  const root = await rootOrgUnitId(ctx);
  const national =
    profile.role === "super_admin" ||
    (profile.role === "admin" && !!root && profile.orgUnitId === root);
  const units =
    profile.role === "super_admin" || profile.role === "analyst"
      ? null
      : profile.orgUnitId
        ? new Set(await collectScopeUnitIds(ctx, profile.orgUnitId))
        : new Set<Id<"orgUnits">>();
  return async (locationId: Id<"inventoryLocations">) => {
    const location = await ctx.db.get(locationId);
    return (
      !!location &&
      location.active &&
      location.organizationId === SUNPRIDE_ORGANIZATION_ID &&
      (location.orgUnitId ? !units || units.has(location.orgUnitId) : national)
    );
  };
}

function regionOf(
  unitId: Id<"orgUnits">,
  tree: Awaited<ReturnType<typeof topology>>,
) {
  const byId = new Map(tree.map((unit) => [unit._id, unit]));
  let node = byId.get(unitId);
  if (!node)
    throw new ConvexError("Destination must be an active organizational unit");
  while (node.parentId) {
    const parent = byId.get(node.parentId);
    if (!parent) throw new ConvexError("Invalid organization hierarchy");
    if (!parent.parentId) return node._id;
    node = parent;
  }
  return node._id;
}

export const assign = mutation({
  args: {
    locationId: v.id("inventoryLocations"),
    orgUnitId: v.id("orgUnits"),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.reason.trim())
      throw new ConvexError("Assignment reason is required");
    const location: Doc<"inventoryLocations"> | null = await ctx.db.get(
      args.locationId,
    );
    if (
      !location ||
      !location.active ||
      location.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      throw new ConvexError("Active inventory location not found");
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      args.orgUnitId,
    );
    if (location.orgUnitId)
      await requireCapability(ctx, "admin.manage", location.orgUnitId);
    const tree = await topology(ctx, Date.now());
    const target = tree.find((unit) => unit._id === args.orgUnitId);
    if (
      !target ||
      target.status !== "active" ||
      target.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      throw new ConvexError(
        "Destination must be an active organizational unit",
      );
    if (
      !location.orgUnitId ||
      regionOf(location.orgUnitId, tree) !== regionOf(args.orgUnitId, tree)
    )
      await requireNationalScope(ctx, ["admin"]);
    if (location.orgUnitId === args.orgUnitId) return null;
    await ctx.db.patch(location._id, {
      orgUnitId: args.orgUnitId,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.location_scope.assigned",
      entityType: "inventoryLocation",
      entityId: location._id,
      details: JSON.stringify({
        from: location.orgUnitId ?? null,
        to: args.orgUnitId,
        reason: args.reason.trim(),
      }),
      createdAt: Date.now(),
    });
    return null;
  },
});

/** Idempotent bounded backfill; schedules the next batch until no unmapped rows remain. */
export const backfillNational = internalMutation({
  args: {},
  returns: v.object({ mapped: v.number(), remaining: v.boolean() }),
  handler: async (ctx) => {
    const root = await rootOrgUnitId(ctx);
    if (!root) throw new ConvexError("Seed the national root before backfill");
    const rows = await ctx.db
      .query("inventoryLocations")
      .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", undefined))
      .take(101);
    const batch = rows.slice(0, 100);
    for (const location of batch)
      if (location.organizationId === SUNPRIDE_ORGANIZATION_ID)
        await ctx.db.patch(location._id, {
          orgUnitId: root,
          updatedAt: Date.now(),
        });
    if (rows.length > 100)
      await ctx.scheduler.runAfter(
        0,
        internal.inventory.location_scope.backfillNational,
        {},
      );
    return {
      mapped: batch.filter(
        (row) => row.organizationId === SUNPRIDE_ORGANIZATION_ID,
      ).length,
      remaining: rows.length > 100,
    };
  },
});
