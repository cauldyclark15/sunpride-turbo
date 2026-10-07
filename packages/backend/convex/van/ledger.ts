import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  MAX_ALLOCATIONS_PER_LINE,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import {
  hashPayload,
  postMovement,
  type PostingAllocation,
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

/** Whether the product keeps lot balances (the same rule `postMovement` applies). */
async function lotTracked(
  ctx: QueryCtx | MutationCtx,
  productId: Id<"products">,
) {
  const policy = await ctx.db
    .query("productInventoryPolicies")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", productId),
    )
    .unique();
  return policy?.trackingMode === "lot";
}

/** One product's lot balances at a location in one status, earliest expiry first. */
async function lotBalances(
  ctx: QueryCtx | MutationCtx,
  productId: Id<"products">,
  locationId: Id<"inventoryLocations">,
  status: StockStatus,
) {
  const rows = await ctx.db
    .query("inventoryLotBalances")
    .withIndex("by_org_product_location_status_expiry", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", productId)
        .eq("locationId", locationId)
        .eq("stockStatus", status),
    )
    .take(MAX_ALLOCATIONS_PER_LINE * 4);
  return rows.filter((row) => row.availableBase > 0n);
}

function allocate(
  rows: { lotId: Id<"inventoryLots">; availableBase: bigint }[],
  quantityBase: bigint,
): PostingAllocation[] | null {
  let remaining = quantityBase;
  const allocations: PostingAllocation[] = [];
  for (const row of rows) {
    if (remaining <= 0n) break;
    const take = row.availableBase < remaining ? row.availableBase : remaining;
    allocations.push({
      lotId: row.lotId,
      quantityBase: take,
      userSelected: true,
    });
    remaining -= take;
  }
  if (remaining > 0n || allocations.length > MAX_ALLOCATIONS_PER_LINE)
    return null;
  return allocations;
}

/**
 * VAN-020: `expired` disposes of lots that are actually past expiry. Generic FEFO skips
 * expired lots (they must never be sold), so the truck's lots are named explicitly,
 * expired ones first. Other reasons keep the product's normal allocation.
 */
async function damageAllocations(
  ctx: MutationCtx,
  args: {
    trip: Doc<"vanTrips">;
    productId: Id<"products">;
    quantityBase: bigint;
    reason: string;
    now: number;
  },
): Promise<PostingAllocation[] | undefined> {
  if (args.reason !== "expired" || !(await lotTracked(ctx, args.productId)))
    return undefined;
  type Row = { lotId: Id<"inventoryLots">; availableBase: bigint };
  const expired: Row[] = [],
    unexpired: Row[] = [];
  for (const row of await lotBalances(
    ctx,
    args.productId,
    args.trip.truckLocationId,
    "available",
  )) {
    const lot = await ctx.db.get(row.lotId);
    (lot?.expiresAt !== undefined && lot.expiresAt <= args.now
      ? expired
      : unexpired
    ).push(row);
  }
  // Lots past expiry first; then the nearest-expiry sellable lots (the seller judged
  // them expired on the shelf), never refusing stock that is really on the truck.
  const allocations = allocate([...expired, ...unexpired], args.quantityBase);
  if (!allocations) throw new ConvexError("Insufficient available truck stock");
  return allocations;
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
  const allocations = await damageAllocations(ctx, {
    trip: args.trip,
    productId: args.productId,
    quantityBase: args.quantityBase,
    reason: args.reason,
    now: Date.now(),
  });
  const line: PostingLine = {
    productId: args.productId,
    quantityBase: args.quantityBase,
    fromLocationId: args.trip.truckLocationId,
    toLocationId: args.trip.truckLocationId,
    fromStockStatus: "available",
    toStockStatus: "damaged",
    ...(allocations ? { allocations } : {}),
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

/** The lots the record's own damage movement moved, each linked for the reversal. */
async function recordedAllocations(
  ctx: MutationCtx,
  record: Doc<"vanDamageRecords">,
): Promise<PostingAllocation[] | undefined> {
  const lines = await ctx.db
    .query("inventoryMovementLines")
    .withIndex("by_organizationId_and_movementId_and_lineNumber", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("movementId", record.movementId),
    )
    .take(2);
  if (lines.length !== 1 || lines[0]!.productId !== record.productId)
    throw new ConvexError("The damage movement is not a single product line");
  const rows = await ctx.db
    .query("inventoryAllocations")
    .withIndex("by_organizationId_and_movementLineId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("movementLineId", lines[0]!._id),
    )
    .take(MAX_ALLOCATIONS_PER_LINE + 1);
  if (rows.length === 0) return undefined; // not lot-tracked
  const total = rows.reduce((sum, row) => sum + row.quantityBase, 0n);
  if (rows.length > MAX_ALLOCATIONS_PER_LINE || total !== record.quantityBase)
    throw new ConvexError("Original lot evidence is incomplete");
  return rows.map((row) => ({
    lotId: row.lotId,
    quantityBase: row.quantityBase,
    userSelected: true,
    reversesAllocationId: row._id,
  }));
}

/**
 * VAN-020: a supervisor rejected a damage record. The original movement stays as written;
 * this separate damaged → available movement returns exactly the record's lots to sellable
 * stock where they now sit: on the truck while the trip still holds them, at the trip's
 * depot once its leftovers were returned. Another trip's damage is never touched.
 */
export async function postDamageReversal(
  ctx: MutationCtx,
  args: {
    record: Doc<"vanDamageRecords">;
    trip: Doc<"vanTrips">;
    actorSubject: string;
  },
) {
  if (args.record.tripId !== args.trip._id)
    throw new ConvexError("Damage record does not belong to the trip");
  const locationId = (await leftoversReturned(ctx, args.trip))
    ? args.trip.sourceLocationId
    : args.trip.truckLocationId;
  const allocations = await recordedAllocations(ctx, args.record);
  const reasonCode = `van_damage_rejected:${args.record.reason}`;
  return postMovement(ctx, {
    idempotencyKey: `van-damage-reject:${args.record._id}`,
    payloadHash: hashPayload({
      damageId: args.record._id,
      locationId,
      quantityBase: args.record.quantityBase,
      lots: allocations?.map((allocation) => [
        allocation.lotId,
        allocation.quantityBase,
      ]),
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
        fromLocationId: locationId,
        toLocationId: locationId,
        fromStockStatus: "damaged",
        toStockStatus: "available",
        ...(allocations ? { allocations } : {}),
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
 * Whether this trip's leftovers went back to the depot. Damage is recorded only on an
 * active trip and the first return closes it to `closing`, so a return always follows
 * every damage record of the trip.
 */
export async function leftoversReturned(
  ctx: QueryCtx | MutationCtx,
  trip: Doc<"vanTrips">,
) {
  let seen = 0;
  for await (const movement of ctx.db
    .query("inventoryMovements")
    .withIndex("by_organizationId_and_sourceType_and_sourceDocumentId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("sourceType", "van_trip")
        .eq("sourceDocumentId", trip._id),
    )) {
    if (movement.movementType === "van_unload") return true;
    if (++seen > 2_000)
      throw new ConvexError("Trip has more stock movements than supported");
  }
  return false;
}

/**
 * End of day: everything left on the truck (sellable and damaged) goes back to the depot
 * in the same stock status. Lot-tracked products move exactly the truck's lots in that
 * status (expired ones included, which generic FEFO would skip), so a damage record's lots
 * can later be found and reversed at the depot.
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
      const allocations = (await lotTracked(ctx, balance.productId))
        ? allocate(
            await lotBalances(
              ctx,
              balance.productId,
              args.trip.truckLocationId,
              status,
            ),
            quantityBase,
          )
        : null;
      lines.push({
        productId: balance.productId,
        quantityBase,
        fromLocationId: args.trip.truckLocationId,
        toLocationId: args.trip.sourceLocationId,
        fromStockStatus: status,
        toStockStatus: status,
        ...(allocations ? { allocations } : {}),
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
