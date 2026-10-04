import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireNationalScope } from "../lib/scope";
import { displayQuantity, SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  readableLocationIds,
  requireLocationCapability,
} from "./location_scope";
import { negativeStockMovementTypeValidator } from "./validators";

/**
 * SP-0085 (client call CALL-10): negative stock is allowed in distributor
 * operations; the key accounts group handles stock by pull-out only. The
 * exception is opt-in per stock-holding location and every negative posting is
 * flagged for reconciliation (ADR-007).
 */

// Pull-outs land in returns; in-transit, WIP, production and boundary
// locations are bookkeeping partitions and must never be oversold.
const ALLOWANCE_LOCATION_TYPES = new Set(["warehouse", "zone", "bin", "truck"]);
const MAX_LIST = 200;

const allowanceRow = v.object({
  id: v.id("negativeStockAllowances"),
  locationId: v.id("inventoryLocations"),
  locationCode: v.string(),
  locationName: v.string(),
  operation: v.literal("distributor"),
  movementTypes: v.array(negativeStockMovementTypeValidator),
  limitBase: v.union(v.int64(), v.null()),
  active: v.boolean(),
  sourceRef: v.string(),
  version: v.number(),
  updatedAt: v.number(),
});

const flagRow = v.object({
  id: v.id("negativeStockFlags"),
  movementId: v.id("inventoryMovements"),
  movementNumber: v.string(),
  movementType: negativeStockMovementTypeValidator,
  productId: v.id("products"),
  productCode: v.string(),
  productName: v.string(),
  locationId: v.id("inventoryLocations"),
  locationCode: v.string(),
  locationName: v.string(),
  quantity: v.string(),
  balanceAfter: v.string(),
  shortfall: v.string(),
  currentAvailable: v.string(),
  status: v.union(v.literal("open"), v.literal("resolved")),
  createdAt: v.number(),
  resolvedAt: v.union(v.number(), v.null()),
  resolutionNote: v.union(v.string(), v.null()),
});

export const setAllowance = mutation({
  args: {
    locationId: v.id("inventoryLocations"),
    active: v.boolean(),
    movementTypes: v.array(negativeStockMovementTypeValidator),
    limitBase: v.optional(v.int64()),
    sourceRef: v.string(),
  },
  returns: v.id("negativeStockAllowances"),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(ctx, ["admin"]);
    const location = await ctx.db.get(args.locationId);
    if (
      !location ||
      !location.active ||
      location.organizationId !== SUNPRIDE_ORGANIZATION_ID
    )
      throw new ConvexError("Active inventory location not found");
    if (!ALLOWANCE_LOCATION_TYPES.has(location.type))
      throw new ConvexError(
        "Negative stock can only be allowed at a warehouse, zone, bin or truck",
      );
    const movementTypes = [...new Set(args.movementTypes)].sort();
    if (args.active && movementTypes.length === 0)
      throw new ConvexError("Choose at least one movement type");
    if (args.limitBase !== undefined && args.limitBase <= 0n)
      throw new ConvexError("Negative stock limit must be positive");
    const sourceRef = args.sourceRef.trim();
    if (sourceRef.length === 0 || sourceRef.length > 200)
      throw new ConvexError(
        "A source reference (1-200 characters) is required",
      );
    const existing = await ctx.db
      .query("negativeStockAllowances")
      .withIndex("by_organizationId_and_locationId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("locationId", location._id),
      )
      .unique();
    const now = Date.now();
    const payload = {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      locationId: location._id,
      operation: "distributor" as const,
      movementTypes,
      limitBase: args.limitBase,
      active: args.active,
      sourceRef,
      version: (existing?.version ?? 0) + 1,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    };
    let allowanceId;
    if (existing) {
      await ctx.db.replace(existing._id, {
        ...payload,
        createdAt: existing.createdAt,
      });
      allowanceId = existing._id;
    } else
      allowanceId = await ctx.db.insert("negativeStockAllowances", {
        ...payload,
        createdAt: now,
      });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: args.active
        ? "inventory.negative_stock.allowed"
        : "inventory.negative_stock.disallowed",
      entityType: "negativeStockAllowance",
      entityId: allowanceId,
      details: `version:${payload.version};location:${location.code};types:${movementTypes.join(",")}`,
      createdAt: now,
    });
    return allowanceId;
  },
});

export const allowances = query({
  args: {},
  returns: v.array(allowanceRow),
  handler: async (ctx) => {
    const canRead = await readableLocationIds(ctx);
    const rows = await ctx.db
      .query("negativeStockAllowances")
      .withIndex("by_organizationId_and_locationId", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .take(MAX_LIST);
    const result = [];
    for (const row of rows) {
      if (!(await canRead(row.locationId))) continue;
      const location = await ctx.db.get(row.locationId);
      if (!location) continue;
      result.push({
        id: row._id,
        locationId: location._id,
        locationCode: location.code,
        locationName: location.name,
        operation: row.operation,
        movementTypes: row.movementTypes,
        limitBase: row.limitBase ?? null,
        active: row.active,
        sourceRef: row.sourceRef,
        version: row.version,
        updatedAt: row.updatedAt,
      });
    }
    return result;
  },
});

export const flags = query({
  args: {
    status: v.optional(v.union(v.literal("open"), v.literal("resolved"))),
    limit: v.optional(v.number()),
  },
  returns: v.array(flagRow),
  handler: async (ctx, args) => {
    const canRead = await readableLocationIds(ctx);
    const rows = await ctx.db
      .query("negativeStockFlags")
      .withIndex("by_organizationId_and_status_and_createdAt", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("status", args.status ?? "open"),
      )
      .order("desc")
      .take(Math.max(1, Math.min(args.limit ?? 50, MAX_LIST)));
    const result = [];
    for (const row of rows) {
      if (!(await canRead(row.locationId))) continue;
      const [product, location, movement, balance] = await Promise.all([
        ctx.db.get(row.productId),
        ctx.db.get(row.locationId),
        ctx.db.get(row.movementId),
        ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", row.productId)
              .eq("locationId", row.locationId),
          )
          .unique(),
      ]);
      if (!product || !location || !movement) continue;
      const scale = product.quantityScale ?? 1n;
      result.push({
        id: row._id,
        movementId: movement._id,
        movementNumber: movement.movementNumber,
        movementType: row.movementType,
        productId: product._id,
        productCode: product.code,
        productName: product.name,
        locationId: location._id,
        locationCode: location.code,
        locationName: location.name,
        quantity: displayQuantity(row.quantityBase, scale),
        balanceAfter: displayQuantity(row.balanceAfterBase, scale),
        shortfall: displayQuantity(row.shortfallBase, scale),
        currentAvailable: displayQuantity(balance?.availableBase ?? 0n, scale),
        status: row.status,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt ?? null,
        resolutionNote: row.resolutionNote ?? null,
      });
    }
    return result;
  },
});

/**
 * Close a reconciliation flag. The balance must be back at zero or above
 * (a receipt, transfer in, or approved count has covered the shortfall), and
 * the person who made the negative posting cannot close their own flag.
 */
export const resolveFlag = mutation({
  args: { flagId: v.id("negativeStockFlags"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const flag = await ctx.db.get(args.flagId);
    if (!flag || flag.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Negative stock flag not found");
    const { identity } = await requireLocationCapability(
      ctx,
      "inventory.adjustment.approve",
      flag.locationId,
    );
    if (flag.status !== "open")
      throw new ConvexError("Negative stock flag is already resolved");
    if (flag.postedBy === identity.tokenIdentifier)
      throw new ConvexError(
        "The person who posted below zero cannot resolve the flag",
      );
    const note = args.note.trim();
    if (note.length === 0 || note.length > 500)
      throw new ConvexError("A resolution note (1-500 characters) is required");
    const balance = await ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("productId", flag.productId)
          .eq("locationId", flag.locationId),
      )
      .unique();
    if (
      (balance?.physicalBase ?? 0n) < 0n ||
      (balance?.availableBase ?? 0n) < 0n
    )
      throw new ConvexError(
        "Stock is still below zero; receive or count it before resolving",
      );
    const now = Date.now();
    await ctx.db.patch(flag._id, {
      status: "resolved",
      resolvedBy: identity.tokenIdentifier,
      resolvedAt: now,
      resolutionNote: note,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.negative_stock.resolved",
      entityType: "negativeStockFlag",
      entityId: flag._id,
      details: `movement:${flag.movementId}`,
      createdAt: now,
    });
    return null;
  },
});
