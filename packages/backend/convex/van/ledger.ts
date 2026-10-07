import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  hashPayload,
  postMovement,
  type PostingLine,
} from "../inventory/posting";
import type { StockStatus } from "../inventory/validators";

/**
 * CVX-029: every truck-stock change is a movement through `postMovement` (ADR-003/007).
 * The truck is the trip's `truckLocationId`; the depot is its `sourceLocationId`.
 * Nothing in the van domain writes balances, ledger rows or lot balances directly.
 */

type LoadLine = Doc<"vanTripLoadLines">;

/** Depot → truck for the actual (or, when unchanged, expected) loaded quantities. */
export async function postTripLoad(
  ctx: MutationCtx,
  args: {
    trip: Doc<"vanTrips">;
    load: Doc<"vanTripLoads">;
    lines: LoadLine[];
    actorSubject: string;
    deviceId?: string;
  },
) {
  const postingLines: PostingLine[] = [];
  for (const line of args.lines) {
    const quantityBase = line.actualBase ?? line.expectedBase;
    if (quantityBase <= 0n) continue;
    postingLines.push({
      productId: line.productId,
      quantityBase,
      enteredUomCode: line.uomCode,
      fromLocationId: args.trip.sourceLocationId,
      toLocationId: args.trip.truckLocationId,
      fromStockStatus: "available",
      toStockStatus: "available",
      ...(line.lotId
        ? {
            allocations: [
              { lotId: line.lotId, quantityBase, userSelected: true },
            ],
          }
        : {}),
      sourceLineId: line._id,
      reasonCode: "van_load",
    });
  }
  if (postingLines.length === 0)
    throw new ConvexError("A load needs at least one positive quantity");
  const commandKey = `van-load:${args.load._id}`;
  const movement = await postMovement(ctx, {
    idempotencyKey: commandKey,
    payloadHash: hashPayload({
      loadId: args.load._id,
      lines: postingLines.map((line) => ({
        productId: line.productId,
        quantityBase: line.quantityBase,
        lotId: line.allocations?.[0]?.lotId,
      })),
    }),
    commandType: "van.load.post",
    movementType: "van_load",
    sourceType: "van_trip_load",
    sourceDocumentId: args.load._id,
    actorSubject: args.actorSubject,
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
    lines: postingLines,
  });
  return { commandKey, movementId: movement.movementId };
}

/** Available → damaged on the truck itself; quantity stays on the truck for the count. */
export async function postTruckDamage(
  ctx: MutationCtx,
  args: {
    trip: Doc<"vanTrips">;
    productId: Id<"products">;
    quantityBase: bigint;
    reason: string;
    note?: string;
    actorSubject: string;
    deviceId?: string;
    idempotencyKey: string;
  },
) {
  if (args.quantityBase <= 0n)
    throw new ConvexError("Damage quantity must be positive");
  const line: PostingLine = {
    productId: args.productId,
    quantityBase: args.quantityBase,
    fromLocationId: args.trip.truckLocationId,
    toLocationId: args.trip.truckLocationId,
    fromStockStatus: "available",
    toStockStatus: "damaged",
    sourceLineId: args.trip._id,
    reasonCode: `van_damage:${args.reason}`,
  };
  return postMovement(ctx, {
    idempotencyKey: args.idempotencyKey,
    payloadHash: hashPayload({
      tripId: args.trip._id,
      productId: args.productId,
      quantityBase: args.quantityBase,
      reason: args.reason,
    }),
    commandType: "van.truck.damage",
    movementType: "status_change",
    sourceType: "van_trip",
    sourceDocumentId: args.trip._id,
    actorSubject: args.actorSubject,
    reasonCode: `van_damage:${args.reason}`,
    ...(args.note ? { note: args.note } : {}),
    ...(args.deviceId ? { deviceId: args.deviceId } : {}),
    lines: [line],
  });
}

/**
 * VAN-020: a supervisor rejected a damage record. The original movement stays as written;
 * this separate damaged → available movement returns the quantity to sellable stock where
 * it now sits (the truck, or the depot once leftovers were returned).
 */
export async function postDamageReversal(
  ctx: MutationCtx,
  args: {
    record: Doc<"vanDamageRecords">;
    locationId: Id<"inventoryLocations">;
    actorSubject: string;
  },
) {
  const reasonCode = `van_damage_rejected:${args.record.reason}`;
  return postMovement(ctx, {
    idempotencyKey: `van-damage-reject:${args.record._id}`,
    payloadHash: hashPayload({
      damageId: args.record._id,
      locationId: args.locationId,
      quantityBase: args.record.quantityBase,
    }),
    commandType: "van.truck.damage.reject",
    movementType: "status_change",
    sourceType: "van_trip",
    sourceDocumentId: args.record.tripId,
    actorSubject: args.actorSubject,
    reasonCode,
    lines: [
      {
        productId: args.record.productId,
        quantityBase: args.record.quantityBase,
        fromLocationId: args.locationId,
        toLocationId: args.locationId,
        fromStockStatus: "damaged",
        toStockStatus: "available",
        sourceLineId: args.record._id,
        reasonCode,
      },
    ],
  });
}

export type TruckBalance = {
  productId: Id<"products">;
  availableBase: bigint;
  damagedBase: bigint;
  physicalBase: bigint;
};

/** Server truck stock by product (summary balances, bounded). */
export async function truckBalances(
  ctx: QueryCtx | MutationCtx,
  truckLocationId: Id<"inventoryLocations">,
  limit = 500,
): Promise<TruckBalance[]> {
  const rows = await ctx.db
    .query("inventoryBalances")
    .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("locationId", truckLocationId),
    )
    .take(limit + 1);
  if (rows.length > limit)
    throw new ConvexError("Truck stock exceeds the supported product count");
  return rows.flatMap((row) =>
    row.productId
      ? [
          {
            productId: row.productId,
            availableBase: row.availableStockBase ?? 0n,
            damagedBase: row.damagedBase ?? 0n,
            physicalBase: row.physicalBase ?? 0n,
          },
        ]
      : [],
  );
}

/**
 * End of day: everything left on the truck (sellable and damaged) goes back to the depot
 * in the same stock status. Lot-tracked products are allocated by the product's policy.
 */
export async function postLeftoverReturn(
  ctx: MutationCtx,
  args: {
    trip: Doc<"vanTrips">;
    actorSubject: string;
    idempotencyKey: string;
  },
) {
  const balances = await truckBalances(ctx, args.trip.truckLocationId);
  const lines: PostingLine[] = [];
  for (const balance of balances) {
    for (const [status, quantityBase] of [
      ["available", balance.availableBase],
      ["damaged", balance.damagedBase],
    ] as const satisfies readonly (readonly [StockStatus, bigint])[]) {
      if (quantityBase <= 0n) continue;
      lines.push({
        productId: balance.productId,
        quantityBase,
        fromLocationId: args.trip.truckLocationId,
        toLocationId: args.trip.sourceLocationId,
        fromStockStatus: status,
        toStockStatus: status,
        sourceLineId: args.trip._id,
        reasonCode: "van_unload",
      });
    }
  }
  if (lines.length === 0) return null;
  return postMovement(ctx, {
    idempotencyKey: args.idempotencyKey,
    payloadHash: hashPayload({
      tripId: args.trip._id,
      lines: lines.map((line) => [
        line.productId,
        line.fromStockStatus,
        line.quantityBase,
      ]),
    }),
    commandType: "van.leftover.return",
    movementType: "van_unload",
    sourceType: "van_trip",
    sourceDocumentId: args.trip._id,
    actorSubject: args.actorSubject,
    lines,
  });
}
