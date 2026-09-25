import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { requireRole } from "../lib/auth";
import { DEFAULT_QUANTITY_SCALE, SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  findExistingCommand,
  hashPayload,
  postMovement,
  type PostingLine,
} from "./posting";
import { movementResultValidator } from "./validators";

async function ensureLocation(
  ctx: Parameters<typeof postMovement>[0],
  input: {
    code: string;
    name: string;
    type:
      | "warehouse"
      | "production"
      | "wip"
      | "truck"
      | "in_transit"
      | "returns"
      | "virtual_boundary";
    allowsPicking?: boolean;
    allowsReceiving?: boolean;
    allowsSale?: boolean;
    allowsProduction?: boolean;
    truckCode?: string;
  },
) {
  const existing = await ctx.db
    .query("inventoryLocations")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", input.code),
    )
    .unique();
  if (existing) return existing._id;
  const now = Date.now();
  return ctx.db.insert("inventoryLocations", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    siteCode: "SUNPRIDE-MAIN",
    code: input.code,
    name: input.name,
    type: input.type,
    active: true,
    allowsPicking: input.allowsPicking ?? false,
    allowsReceiving: input.allowsReceiving ?? false,
    allowsSale: input.allowsSale ?? false,
    allowsProduction: input.allowsProduction ?? false,
    ...(input.truckCode ? { truckCode: input.truckCode } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

export const foundation = mutation({
  args: {},
  returns: v.object({
    seeded: v.boolean(),
    locationCount: v.number(),
    policyCount: v.number(),
  }),
  handler: async (ctx) => {
    await requireRole(ctx, ["admin"]);
    const now = Date.now();
    let caseUom = await ctx.db
      .query("unitsOfMeasure")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", "CASE"),
      )
      .unique();
    if (!caseUom) {
      const id = await ctx.db.insert("unitsOfMeasure", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        code: "CASE",
        name: "Case",
        dimension: "count",
        decimalPlaces: 3,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      caseUom = await ctx.db.get(id);
    }
    if (!caseUom) throw new Error("Could not provision base UOM");
    for (const input of [
      {
        code: "EACH",
        name: "Each",
        dimension: "count" as const,
        decimalPlaces: 0,
      },
      {
        code: "KG",
        name: "Kilogram",
        dimension: "mass" as const,
        decimalPlaces: 3,
      },
      {
        code: "L",
        name: "Liter",
        dimension: "volume" as const,
        decimalPlaces: 3,
      },
    ]) {
      const existing = await ctx.db
        .query("unitsOfMeasure")
        .withIndex("by_organizationId_and_code", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("code", input.code),
        )
        .unique();
      if (!existing)
        await ctx.db.insert("unitsOfMeasure", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          ...input,
          active: true,
          createdAt: now,
          updatedAt: now,
        });
    }
    await ensureLocation(ctx, {
      code: "WH-MNL",
      name: "Manila Distribution Center",
      type: "warehouse",
      allowsPicking: true,
      allowsReceiving: true,
    });
    await ensureLocation(ctx, {
      code: "TRUCK-001",
      name: "Rolling Truck 001",
      type: "truck",
      allowsPicking: true,
      allowsReceiving: true,
      allowsSale: true,
      truckCode: "TRUCK-001",
    });
    await ensureLocation(ctx, {
      code: "IN-TRANSIT",
      name: "Transfer in transit",
      type: "in_transit",
      allowsPicking: true,
      allowsReceiving: true,
    });
    await ensureLocation(ctx, {
      code: "WIP-MAIN",
      name: "Main work in process",
      type: "wip",
      allowsPicking: true,
      allowsReceiving: true,
      allowsProduction: true,
    });
    await ensureLocation(ctx, {
      code: "PRODUCTION-MAIN",
      name: "Main production floor",
      type: "production",
      allowsPicking: true,
      allowsReceiving: true,
      allowsProduction: true,
    });
    await ensureLocation(ctx, {
      code: "RETURNS",
      name: "Returns and inspection",
      type: "returns",
      allowsReceiving: true,
    });
    await ensureLocation(ctx, {
      code: "EXTERNAL-SUPPLIER",
      name: "External supplier boundary",
      type: "virtual_boundary",
    });
    const products = await ctx.db.query("products").take(250);
    let policyCount = 0;
    for (const product of products) {
      await ctx.db.patch(product._id, {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        baseUomId: caseUom._id,
        quantityScale: DEFAULT_QUANTITY_SCALE,
        trackingMode: "lot",
        allocationPolicy: "fefo",
        policyVersion: 1,
        updatedAt: now,
      });
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", product._id),
        )
        .unique();
      if (!policy) {
        await ctx.db.insert("productInventoryPolicies", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          productId: product._id,
          baseUomId: caseUom._id,
          quantityScale: DEFAULT_QUANTITY_SCALE,
          quantityPrecision: 3,
          trackingMode: "lot",
          allocationPolicy: "fefo",
          allowMixedLotsPerLine: true,
          allowNegativeStock: false,
          qualityReleaseRequired: false,
          shelfLifeDays: 365,
          expiryDateRequired: true,
          manufactureDateRequired: true,
          minimumRemainingShelfLifeDays: 7,
          costingMethod: "weighted_average",
          version: 1,
          active: true,
          createdAt: now,
          updatedAt: now,
        });
        policyCount += 1;
      }
    }
    return {
      seeded: policyCount > 0,
      locationCount: 7,
      policyCount,
    };
  },
});

export const openingBalanceLineInput = v.object({
  productId: v.id("products"),
  locationId: v.id("inventoryLocations"),
  quantityBase: v.int64(),
  lotNumber: v.optional(v.string()),
  manufacturedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  unitCostMinor: v.optional(v.int64()),
});

export type OpeningBalanceLineInput = {
  productId: Id<"products">;
  locationId: Id<"inventoryLocations">;
  quantityBase: bigint;
  lotNumber?: string;
  manufacturedAt?: number;
  expiresAt?: number;
  unitCostMinor?: bigint;
};

/**
 * A row-level failure with a machine-readable code, so the CSV import can report per row
 * while the single-document mutation keeps rethrowing the same human message it always has.
 */
export class OpeningBalanceLineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OpeningBalanceLineError";
    this.code = code;
  }
}

/**
 * Validates one opening-balance line and resolves or creates its lot. Shared by
 * `postOpeningBalances` and the opening-stock CSV import so both apply identical rules
 * (ADR-007: opening stock is explicit, lot-tracked, and never implicit).
 */
export async function buildOpeningBalanceLine(
  ctx: MutationCtx,
  args: { sourceReference: string; line: OpeningBalanceLineInput },
): Promise<PostingLine> {
  const { line, sourceReference } = args;
  if (line.quantityBase <= 0n)
    throw new OpeningBalanceLineError(
      "not_positive",
      "Opening quantity must be positive",
    );
  const policy = await ctx.db
    .query("productInventoryPolicies")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", line.productId),
    )
    .unique();
  const now = Date.now();
  let lotId;
  if (policy?.trackingMode === "lot") {
    if (!line.lotNumber)
      throw new OpeningBalanceLineError(
        "required_missing",
        "Lot-tracked opening balance requires a lot",
      );
    if (policy.expiryDateRequired && !line.expiresAt)
      throw new OpeningBalanceLineError(
        "required_missing",
        "Opening lot requires an expiry date",
      );
    if (policy.manufactureDateRequired && !line.manufacturedAt)
      throw new OpeningBalanceLineError(
        "required_missing",
        "Opening lot requires a manufacture date",
      );
    const normalizedLotNumber = line.lotNumber.trim().toUpperCase();
    let lot = await ctx.db
      .query("inventoryLots")
      .withIndex(
        "by_organizationId_and_productId_and_normalizedLotNumber",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", line.productId)
            .eq("normalizedLotNumber", normalizedLotNumber),
      )
      .unique();
    if (!lot) {
      const id = await ctx.db.insert("inventoryLots", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        productId: line.productId,
        lotNumber: line.lotNumber,
        normalizedLotNumber,
        sourceType: "opening_balance",
        sourceDocumentId: sourceReference,
        ...(line.manufacturedAt ? { manufacturedAt: line.manufacturedAt } : {}),
        receivedAt: now,
        ...(line.expiresAt ? { expiresAt: line.expiresAt } : {}),
        qualityStatus: "released",
        ...(line.unitCostMinor ? { unitCostMinor: line.unitCostMinor } : {}),
        createdAt: now,
        updatedAt: now,
      });
      lot = await ctx.db.get(id);
    }
    if (!lot)
      throw new OpeningBalanceLineError(
        "internal",
        "Could not create opening lot",
      );
    lotId = lot._id;
  }
  return {
    productId: line.productId,
    quantityBase: line.quantityBase,
    toLocationId: line.locationId,
    toStockStatus: "available",
    ...(lotId
      ? {
          allocations: [
            {
              lotId,
              quantityBase: line.quantityBase,
              userSelected: true,
            },
          ],
        }
      : {}),
    unitCostMinor: line.unitCostMinor,
    reasonCode: "approved_opening_balance",
  };
}

export const postOpeningBalances = mutation({
  args: {
    idempotencyKey: v.string(),
    sourceReference: v.string(),
    lines: v.array(openingBalanceLineInput),
  },
  returns: movementResultValidator,
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, ["admin"]);
    const payloadHash = hashPayload(args);
    const duplicate = await findExistingCommand(
      ctx,
      args.idempotencyKey,
      payloadHash,
    );
    if (duplicate?.movementId) {
      const movement = await ctx.db.get(duplicate.movementId);
      if (movement)
        return {
          movementId: movement._id,
          movementNumber: movement.movementNumber,
          duplicate: true,
        };
    }
    if (args.lines.length === 0)
      throw new ConvexError("Opening balance needs at least one line");
    const postingLines: PostingLine[] = [];
    for (const line of args.lines) {
      try {
        postingLines.push(
          await buildOpeningBalanceLine(ctx, {
            sourceReference: args.sourceReference,
            line,
          }),
        );
      } catch (error) {
        if (error instanceof OpeningBalanceLineError)
          throw new ConvexError(error.message);
        throw error;
      }
    }
    return postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash,
      commandType: "inventory.openingBalance",
      movementType: "opening_balance",
      sourceType: "cutover",
      sourceDocumentId: args.sourceReference,
      actorSubject: identity.tokenIdentifier,
      lines: postingLines,
      emitIntegrationEvent: false,
    });
  },
});
