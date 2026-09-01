import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";
import { displayQuantity, SUNPRIDE_ORGANIZATION_ID } from "./constants";
import { stockStatusValidator } from "./validators";

const operationalBalance = v.object({
  id: v.id("inventoryBalances"),
  productId: v.id("products"),
  productCode: v.string(),
  productName: v.string(),
  locationId: v.id("inventoryLocations"),
  locationCode: v.string(),
  locationName: v.string(),
  locationType: v.string(),
  physical: v.string(),
  reserved: v.string(),
  available: v.string(),
  qualityHold: v.string(),
  inTransit: v.string(),
  version: v.number(),
  updatedAt: v.number(),
});

export const overview = query({
  args: {
    locationId: v.optional(v.id("inventoryLocations")),
    limit: v.optional(v.number()),
  },
  returns: v.array(operationalBalance),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const rows = args.locationId
      ? await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("locationId", args.locationId!),
          )
          .take(Math.min(args.limit ?? 100, 250))
      : await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
            q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
          )
          .take(Math.min(args.limit ?? 100, 250));
    const result = [];
    for (const row of rows) {
      if (!row.productId || !row.locationId) continue;
      const [product, location] = await Promise.all([
        ctx.db.get(row.productId),
        ctx.db.get(row.locationId),
      ]);
      if (!product || !location) continue;
      const scale = product.quantityScale ?? 1n;
      result.push({
        id: row._id,
        productId: product._id,
        productCode: product.code,
        productName: product.name,
        locationId: location._id,
        locationCode: location.code,
        locationName: location.name,
        locationType: location.type,
        physical: displayQuantity(row.physicalBase ?? 0n, scale),
        reserved: displayQuantity(row.reservedBase ?? 0n, scale),
        available: displayQuantity(row.availableBase ?? 0n, scale),
        qualityHold: displayQuantity(row.qualityHoldBase ?? 0n, scale),
        inTransit: displayQuantity(row.inTransitBase ?? 0n, scale),
        version: row.version ?? 0,
        updatedAt: row.asOf,
      });
    }
    return result;
  },
});

const location = v.object({
  _id: v.id("inventoryLocations"),
  _creationTime: v.number(),
  organizationId: v.string(),
  siteCode: v.string(),
  warehouseId: v.optional(v.id("warehouses")),
  parentLocationId: v.optional(v.id("inventoryLocations")),
  code: v.string(),
  name: v.string(),
  type: v.string(),
  active: v.boolean(),
  allowsPicking: v.boolean(),
  allowsReceiving: v.boolean(),
  allowsSale: v.boolean(),
  allowsProduction: v.boolean(),
  externalId: v.optional(v.string()),
  truckCode: v.optional(v.string()),
  assignedDeviceId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const locations = query({
  args: { type: v.optional(v.string()) },
  returns: v.array(location),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const rows = await ctx.db
      .query("inventoryLocations")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .take(100);
    return args.type ? rows.filter((row) => row.type === args.type) : rows;
  },
});

const movement = v.object({
  _id: v.id("inventoryMovements"),
  _creationTime: v.number(),
  organizationId: v.string(),
  movementNumber: v.string(),
  movementType: v.string(),
  sourceType: v.string(),
  sourceDocumentId: v.optional(v.string()),
  status: v.string(),
  effectiveAt: v.number(),
  postedAt: v.number(),
  postedBy: v.string(),
  deviceId: v.optional(v.string()),
  idempotencyKey: v.string(),
  reasonCode: v.optional(v.string()),
  note: v.optional(v.string()),
  reversesMovementId: v.optional(v.id("inventoryMovements")),
  reversedByMovementId: v.optional(v.id("inventoryMovements")),
  schemaVersion: v.number(),
});

export const movements = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(movement),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    return ctx.db
      .query("inventoryMovements")
      .withIndex("by_organizationId_and_postedAt", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const lots = query({
  args: {
    productId: v.optional(v.id("products")),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const rows = args.productId
      ? await ctx.db
          .query("inventoryLots")
          .withIndex("by_organizationId_and_productId_and_expiresAt", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", args.productId!),
          )
          .take(Math.min(args.limit ?? 100, 250))
      : await ctx.db
          .query("inventoryLots")
          .order("desc")
          .take(Math.min(args.limit ?? 100, 250));
    return rows;
  },
});

export const lotBalances = query({
  args: {
    lotId: v.id("inventoryLots"),
    stockStatus: v.optional(stockStatusValidator),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const rows = await ctx.db
      .query("inventoryLotBalances")
      .withIndex("by_organizationId_and_lotId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("lotId", args.lotId),
      )
      .take(100);
    return args.stockStatus
      ? rows.filter((row) => row.stockStatus === args.stockStatus)
      : rows;
  },
});

export const trace = query({
  args: { movementId: v.id("inventoryMovements") },
  returns: v.object({
    movement: v.any(),
    lines: v.array(v.any()),
    allocations: v.array(v.any()),
    entries: v.array(v.any()),
    command: v.union(v.any(), v.null()),
    integrationEvents: v.array(v.any()),
  }),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const movement = await ctx.db.get(args.movementId);
    if (!movement) throw new Error("Movement not found");
    const [lines, entries, integrationEvents] = await Promise.all([
      ctx.db
        .query("inventoryMovementLines")
        .withIndex("by_organizationId_and_movementId_and_lineNumber", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("movementId", args.movementId),
        )
        .take(100),
      ctx.db
        .query("inventoryLedgerEntries")
        .withIndex("by_organizationId_and_movementId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("movementId", args.movementId),
        )
        .take(500),
      ctx.db
        .query("integrationEvents")
        .withIndex("by_event_id", (q) =>
          q.eq("eventId", `inventory-${args.movementId}`),
        )
        .take(10),
    ]);
    const allocations = [];
    for (const line of lines)
      allocations.push(
        ...(await ctx.db
          .query("inventoryAllocations")
          .withIndex("by_organizationId_and_movementLineId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("movementLineId", line._id),
          )
          .take(50)),
      );
    const command = await ctx.db
      .query("inventoryCommands")
      .withIndex("by_organizationId_and_idempotencyKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("idempotencyKey", movement.idempotencyKey),
      )
      .unique();
    return {
      movement,
      lines,
      allocations,
      entries,
      command,
      integrationEvents,
    };
  },
});
