import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireIdentity, requireRole } from "../lib/auth";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";

export const upsertPolicy = mutation({
  args: {
    productId: v.id("products"),
    locationId: v.optional(v.id("inventoryLocations")),
    enabled: v.boolean(),
    reorderPointBase: v.int64(),
    targetLevelBase: v.int64(),
    safetyStockBase: v.int64(),
    leadTimeDays: v.optional(v.number()),
    alertCooldownMs: v.number(),
  },
  returns: v.id("replenishmentPolicies"),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, ["admin", "manager"]);
    if (
      args.reorderPointBase < 0n ||
      args.targetLevelBase <= args.reorderPointBase ||
      args.safetyStockBase < 0n
    )
      throw new ConvexError("Invalid replenishment thresholds");
    const existing = await ctx.db
      .query("replenishmentPolicies")
      .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("productId", args.productId)
          .eq("locationId", args.locationId),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      return existing._id;
    }
    const id = await ctx.db.insert("replenishmentPolicies", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      ...args,
      lastAlertState: "ok",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.replenishment_policy.updated",
      entityType: "replenishmentPolicy",
      entityId: id,
      createdAt: now,
    });
    return id;
  },
});

export const suggestions = query({
  args: {},
  returns: v.array(
    v.object({
      policyId: v.id("replenishmentPolicies"),
      productId: v.id("products"),
      productCode: v.string(),
      productName: v.string(),
      locationId: v.optional(v.id("inventoryLocations")),
      locationCode: v.optional(v.string()),
      availableBase: v.int64(),
      reorderPointBase: v.int64(),
      suggestedBase: v.int64(),
      leadTimeDays: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requireIdentity(ctx);
    const policies = await ctx.db
      .query("replenishmentPolicies")
      .withIndex("by_organizationId_and_enabled", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("enabled", true),
      )
      .take(100);
    const result = [];
    for (const policy of policies) {
      const [product, location] = await Promise.all([
        ctx.db.get(policy.productId),
        policy.locationId ? ctx.db.get(policy.locationId) : null,
      ]);
      if (!product) continue;
      let availableBase = 0n;
      if (policy.locationId) {
        const balance = await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", policy.productId)
              .eq("locationId", policy.locationId!),
          )
          .unique();
        availableBase = balance?.availableBase ?? 0n;
      } else {
        const balances = await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", policy.productId),
          )
          .take(100);
        availableBase = balances.reduce(
          (sum, balance) => sum + (balance.availableBase ?? 0n),
          0n,
        );
      }
      if (availableBase > policy.reorderPointBase) continue;
      result.push({
        policyId: policy._id,
        productId: product._id,
        productCode: product.code,
        productName: product.name,
        ...(policy.locationId ? { locationId: policy.locationId } : {}),
        ...(location ? { locationCode: location.code } : {}),
        availableBase,
        reorderPointBase: policy.reorderPointBase,
        suggestedBase:
          policy.targetLevelBase > availableBase
            ? policy.targetLevelBase - availableBase
            : 0n,
        ...(policy.leadTimeDays !== undefined
          ? { leadTimeDays: policy.leadTimeDays }
          : {}),
      });
    }
    return result;
  },
});
