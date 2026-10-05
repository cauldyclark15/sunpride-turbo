import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireActiveProfile } from "../lib/auth";
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
const MAX_LOCATIONS = 200;
const MAX_FLAG_PAGE = 100;

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

export const canManageAllowances = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    // Signed-out and unprovisioned callers are refused like every other
    // endpoint; for a provisioned profile this is the same rule as
    // setAllowance, so the web never offers a refused control.
    await requireActiveProfile(ctx);
    try {
      await requireNationalScope(ctx, ["admin"]);
      return true;
    } catch {
      return false;
    }
  },
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

/**
 * Allowance state for the locations the caller asks about. Scope is checked
 * per requested location BEFORE any lookup, and each lookup is an exact index
 * hit, so newer rows at foreign locations can never crowd out an authorized
 * one (there is no global cap to fill).
 */
export const allowances = query({
  args: { locationIds: v.array(v.id("inventoryLocations")) },
  returns: v.array(allowanceRow),
  handler: async (ctx, args) => {
    const canRead = await readableLocationIds(ctx);
    const locationIds = [...new Set(args.locationIds)];
    if (locationIds.length > MAX_LOCATIONS)
      throw new ConvexError(
        `Ask for at most ${MAX_LOCATIONS} locations at a time`,
      );
    const result = [];
    for (const locationId of locationIds) {
      if (!(await canRead(locationId))) continue;
      const row = await ctx.db
        .query("negativeStockAllowances")
        .withIndex("by_organizationId_and_locationId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("locationId", locationId),
        )
        .unique();
      const location = await ctx.db.get(locationId);
      if (!row || !location) continue;
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

/**
 * Newest-first flags, paginated. Each page is filtered to the caller's
 * location scope; a page can therefore be short or empty while `isDone` is
 * false, and the caller keeps paging rather than treating it as the end.
 */
export const flags = query({
  args: {
    status: v.optional(v.union(v.literal("open"), v.literal("resolved"))),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(flagRow),
  handler: async (ctx, args) => {
    const canRead = await readableLocationIds(ctx);
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > MAX_FLAG_PAGE
    )
      throw new ConvexError(`Page size must be 1–${MAX_FLAG_PAGE}`);
    const pageResult = await ctx.db
      .query("negativeStockFlags")
      .withIndex("by_organizationId_and_status_and_createdAt", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("status", args.status ?? "open"),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const row of pageResult.page) {
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
      page.push({
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
    return { ...pageResult, page };
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
