import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { requireNationalScope } from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  allocationPolicyValidator,
  costingMethodValidator,
  trackingModeValidator,
} from "./validators";

export const upsertProductPolicy = mutation({
  args: {
    productId: v.id("products"),
    baseUomId: v.id("unitsOfMeasure"),
    quantityScale: v.int64(),
    quantityPrecision: v.number(),
    trackingMode: trackingModeValidator,
    allocationPolicy: allocationPolicyValidator,
    allowMixedLotsPerLine: v.boolean(),
    qualityReleaseRequired: v.boolean(),
    shelfLifeDays: v.optional(v.number()),
    expiryDateRequired: v.boolean(),
    manufactureDateRequired: v.boolean(),
    minimumRemainingShelfLifeDays: v.number(),
    costingMethod: costingMethodValidator,
  },
  returns: v.id("productInventoryPolicies"),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(ctx, ["admin"]);
    if (args.quantityScale <= 0n || args.quantityPrecision < 0)
      throw new ConvexError("Invalid quantity scale or precision");
    const [product, uom, existing] = await Promise.all([
      ctx.db.get(args.productId),
      ctx.db.get(args.baseUomId),
      ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", args.productId),
        )
        .unique(),
    ]);
    if (!product || !uom) throw new ConvexError("Product or UOM not found");
    if (existing && existing.trackingMode !== args.trackingMode) {
      const balances = await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", product._id),
        )
        .take(100);
      if (balances.some((balance) => (balance.physicalBase ?? 0n) !== 0n))
        throw new ConvexError("Tracking mode cannot change while stock exists");
    }
    const now = Date.now();
    const payload = {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      ...args,
      allowNegativeStock: false,
      version: (existing?.version ?? 0) + 1,
      active: true,
      updatedAt: now,
    };
    let policyId;
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      policyId = existing._id;
    } else
      policyId = await ctx.db.insert("productInventoryPolicies", {
        ...payload,
        createdAt: now,
      });
    await ctx.db.patch(product._id, {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      baseUomId: uom._id,
      quantityScale: args.quantityScale,
      trackingMode: args.trackingMode,
      allocationPolicy: args.allocationPolicy,
      policyVersion: payload.version,
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.product_policy.updated",
      entityType: "productInventoryPolicy",
      entityId: policyId,
      details: `version:${payload.version}`,
      createdAt: now,
    });
    return policyId;
  },
});

export const addUomConversion = mutation({
  args: {
    productId: v.optional(v.id("products")),
    fromUomId: v.id("unitsOfMeasure"),
    toUomId: v.id("unitsOfMeasure"),
    numerator: v.int64(),
    denominator: v.int64(),
    roundingMode: v.union(
      v.literal("exact"),
      v.literal("half_up"),
      v.literal("floor"),
      v.literal("ceiling"),
    ),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
  },
  returns: v.id("uomConversions"),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(ctx, ["admin"]);
    if (
      args.fromUomId === args.toUomId ||
      args.numerator <= 0n ||
      args.denominator <= 0n
    )
      throw new ConvexError("Invalid UOM conversion");
    const [from, to] = await Promise.all([
      ctx.db.get(args.fromUomId),
      ctx.db.get(args.toUomId),
    ]);
    if (!from || !to || from.dimension !== to.dimension)
      throw new ConvexError("UOM dimensions must match");
    const now = Date.now();
    const id = await ctx.db.insert("uomConversions", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      ...args,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.uom_conversion.created",
      entityType: "uomConversion",
      entityId: id,
      createdAt: now,
    });
    return id;
  },
});

export const convert = query({
  args: {
    productId: v.optional(v.id("products")),
    fromUomId: v.id("unitsOfMeasure"),
    toUomId: v.id("unitsOfMeasure"),
    quantityBase: v.int64(),
    at: v.optional(v.number()),
  },
  returns: v.int64(),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "inventory.read");
    const at = args.at ?? Date.now();
    const rows = args.productId
      ? await ctx.db
          .query("uomConversions")
          .withIndex(
            "by_organizationId_and_productId_and_fromUomId_and_toUomId",
            (q) =>
              q
                .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                .eq("productId", args.productId)
                .eq("fromUomId", args.fromUomId)
                .eq("toUomId", args.toUomId),
          )
          .take(20)
      : await ctx.db
          .query("uomConversions")
          .withIndex("by_organizationId_and_fromUomId_and_toUomId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("fromUomId", args.fromUomId)
              .eq("toUomId", args.toUomId),
          )
          .take(20);
    const conversion = rows
      .filter(
        (row) =>
          row.active &&
          row.effectiveFrom <= at &&
          (!row.effectiveTo || row.effectiveTo >= at),
      )
      .sort((left, right) => right.effectiveFrom - left.effectiveFrom)[0];
    if (!conversion) throw new ConvexError("No active UOM conversion found");
    const numerator = args.quantityBase * conversion.numerator;
    const quotient = numerator / conversion.denominator;
    const remainder = numerator % conversion.denominator;
    if (remainder === 0n) return quotient;
    if (conversion.roundingMode === "exact")
      throw new ConvexError("UOM conversion is not exact");
    if (conversion.roundingMode === "floor") return quotient;
    if (conversion.roundingMode === "ceiling") return quotient + 1n;
    return quotient + (remainder * 2n >= conversion.denominator ? 1n : 0n);
  },
});

export const list = query({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    await requireCapability(ctx, "inventory.read");
    return ctx.db
      .query("productInventoryPolicies")
      .withIndex("by_organizationId_and_trackingMode_and_active", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .take(250);
  },
});
