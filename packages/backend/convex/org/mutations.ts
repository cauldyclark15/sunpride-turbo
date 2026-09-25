import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, mutation } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  assertParent,
  audit,
  edgeAt,
  normalizeCode,
  prospective,
  topology,
} from "./validation";

export const create = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    typeCode: v.string(),
    parentId: v.id("orgUnits"),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.id("orgUnits"),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      args.parentId,
    );
    const parent = await assertParent(
      ctx,
      args.typeCode,
      args.parentId,
      args.effectiveFrom,
    );
    if (!parent) throw new ConvexError("Parent not found");
    const code = normalizeCode(args.code);
    if (
      await ctx.db
        .query("orgUnits")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
        )
        .first()
    )
      throw new ConvexError("Duplicate organization code");
    const name = args.name.trim();
    if (!name) throw new ConvexError("Name required");
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Reason required");
    const now = Date.now();
    const id = await ctx.db.insert("orgUnits", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      code,
      name,
      typeCode: args.typeCode,
      parentId: args.effectiveFrom <= now ? args.parentId : undefined,
      status: "active",
      effectiveFrom: args.effectiveFrom,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("orgUnitParentEdges", {
      unitId: id,
      parentId: args.parentId,
      effectiveFrom: args.effectiveFrom,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    await ctx.scheduler.runAt(
      args.effectiveFrom,
      internal.org.mutations.applyProjection,
      { unitId: id },
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "org.created",
      "orgUnit",
      id,
      reason,
      now,
    );
    return id;
  },
});

export const edit = mutation({
  args: { unitId: v.id("orgUnits"), name: v.string(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new ConvexError("Unit not found");
    const { identity } = await requireCapability(ctx, "admin.manage", unit._id);
    const name = args.name.trim();
    if (!name) throw new ConvexError("Name required");
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Reason required");
    const now = Date.now();
    await ctx.db.patch(unit._id, { name, updatedAt: now });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "org.edited",
      "orgUnit",
      unit._id,
      reason,
      now,
    );
    return null;
  },
});

export const reparent = mutation({
  args: {
    unitId: v.id("orgUnits"),
    parentId: v.id("orgUnits"),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    const unit = await ctx.db.get(args.unitId);
    if (
      !unit ||
      unit.code === "SUNPRIDE" ||
      unit.status !== "active" ||
      unit.effectiveFrom >= args.effectiveFrom
    )
      throw new ConvexError("Unit cannot be reparented");
    const { identity } = await requireCapability(ctx, "admin.manage", unit._id);
    await requireCapability(ctx, "admin.manage", args.parentId);
    await assertParent(
      ctx,
      unit.typeCode,
      args.parentId,
      args.effectiveFrom,
      unit.effectiveTo,
    );
    const edges = await ctx.db
      .query("orgUnitParentEdges")
      .withIndex("by_unitId_and_effectiveFrom", (q) => q.eq("unitId", unit._id))
      .order("desc")
      .take(2);
    const previous = edges[0];
    if (previous && previous.effectiveFrom >= args.effectiveFrom)
      throw new ConvexError("Overlapping parent interval");
    const oldParent = previous
      ? previous.parentId
      : await edgeAt(ctx, unit, args.effectiveFrom - 1);
    if (!oldParent || oldParent === args.parentId)
      throw new ConvexError("Invalid parent transition");
    // Existing descendants must remain valid under the new tree; type levels make cycles impossible.
    await topology(ctx, args.effectiveFrom);
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Reason required");
    const now = Date.now();
    if (previous)
      await ctx.db.patch(previous._id, { effectiveTo: args.effectiveFrom });
    else
      await ctx.db.insert("orgUnitParentEdges", {
        unitId: unit._id,
        parentId: oldParent,
        effectiveFrom: unit.effectiveFrom,
        effectiveTo: args.effectiveFrom,
        actorSubject: "system:backfill",
        reason: "legacy projection",
        createdAt: now,
      });
    await ctx.db.insert("orgUnitParentEdges", {
      unitId: unit._id,
      parentId: args.parentId,
      effectiveFrom: args.effectiveFrom,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    await ctx.scheduler.runAt(
      args.effectiveFrom,
      internal.org.mutations.applyProjection,
      { unitId: unit._id },
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "org.reparented",
      "orgUnit",
      unit._id,
      reason,
      now,
    );
    return null;
  },
});

export const deactivate = mutation({
  args: {
    unitId: v.id("orgUnits"),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    prospective(args.effectiveTo);
    const unit = await ctx.db.get(args.unitId);
    if (
      !unit ||
      unit.code === "SUNPRIDE" ||
      unit.status !== "active" ||
      args.effectiveTo <= unit.effectiveFrom
    )
      throw new ConvexError("Unit cannot be deactivated");
    const { identity } = await requireCapability(ctx, "admin.manage", unit._id);
    const tree = await topology(ctx, args.effectiveTo);
    if (tree.some((child) => child.parentId === unit._id))
      throw new ConvexError("Unit has active children");
    const futureEdges = await ctx.db
      .query("orgUnitParentEdges")
      .withIndex("by_parentId_and_effectiveFrom", (q) =>
        q.eq("parentId", unit._id),
      )
      .take(501);
    if (
      futureEdges.length > 500 ||
      futureEdges.some(
        (edge) =>
          edge.effectiveTo === undefined || edge.effectiveTo > args.effectiveTo,
      )
    )
      throw new ConvexError("Unit has dependent child intervals");
    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("Reason required");
    const now = Date.now();
    await ctx.db.patch(unit._id, {
      effectiveTo: args.effectiveTo,
      updatedAt: now,
    });
    const edge = await ctx.db
      .query("orgUnitParentEdges")
      .withIndex("by_unitId_and_effectiveFrom", (q) => q.eq("unitId", unit._id))
      .order("desc")
      .first();
    if (
      edge &&
      (edge.effectiveTo === undefined || edge.effectiveTo > args.effectiveTo)
    )
      await ctx.db.patch(edge._id, { effectiveTo: args.effectiveTo });
    await ctx.scheduler.runAt(
      args.effectiveTo,
      internal.org.mutations.applyProjection,
      { unitId: unit._id },
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "org.deactivated",
      "orgUnit",
      unit._id,
      reason,
      now,
    );
    return null;
  },
});

/** Scheduled projection for legacy readers; gates use effective edges directly. */
export const applyProjection = internalMutation({
  args: { unitId: v.id("orgUnits") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) return null;
    const now = Date.now();
    const parentId = await edgeAt(ctx, unit, now);
    await ctx.db.patch(unit._id, {
      parentId: parentId ?? undefined,
      status:
        unit.effectiveTo !== undefined && unit.effectiveTo <= now
          ? "inactive"
          : unit.status,
      updatedAt: now,
    });
    return null;
  },
});
