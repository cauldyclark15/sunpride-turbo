import { ConvexError, type ObjectType, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import {
  authorizeWrite,
  USER_ACTOR,
  type WriteActor,
} from "../lib/write_actor";
import { audit } from "../org/validation";
import { loadLines, requireTrip, tripLoad } from "./access";
import { postTripLoad } from "./ledger";
import { boundedText, VAN_POLICY } from "./model";
import { locationForWrite } from "./trips";

/** Base UOM code and scale from the product's inventory policy (ADR-006). */
export async function productUnit(
  ctx: MutationCtx,
  product: Doc<"products">,
): Promise<{ uomCode: string; quantityScale: bigint }> {
  const policy = await ctx.db
    .query("productInventoryPolicies")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", product._id),
    )
    .unique();
  const uomId = policy?.baseUomId ?? product.baseUomId;
  const uom = uomId ? await ctx.db.get(uomId) : null;
  return {
    uomCode: uom?.code ?? product.uom,
    quantityScale: policy?.quantityScale ?? product.quantityScale ?? 1n,
  };
}

/**
 * CVX-028: the office (warehouse) issues the expected load by product, base quantity and
 * optional lot. One load sheet per trip (Q3 default: no top-ups).
 */
const planArgs = {
  tripId: v.id("vanTrips"),
  lines: v.array(
    v.object({
      productId: v.id("products"),
      expectedBase: v.int64(),
      lotId: v.optional(v.id("inventoryLots")),
    }),
  ),
};

export const plan = mutation({
  args: planArgs,
  returns: v.id("vanTripLoads"),
  handler: async (ctx, args) => planLoad(ctx, args, USER_ACTOR),
});

/** The load-sheet writer (the office's `plan`, or the trusted beta sample writer). */
export async function planLoad(
  ctx: MutationCtx,
  args: ObjectType<typeof planArgs>,
  actor: WriteActor,
) {
  const trip = await requireTrip(ctx, args.tripId);
  const actorSubject = await authorizeWrite(
    ctx,
    actor,
    "van.manage",
    trip.orgUnitId,
  );
  await locationForWrite(ctx, actor, trip.sourceLocationId);
  if (trip.status !== "planned")
    throw new ConvexError("The load sheet is issued once, before loading");
  if (args.lines.length === 0 || args.lines.length > VAN_POLICY.maxLoadLines)
    throw new ConvexError(
      `A load sheet needs 1-${VAN_POLICY.maxLoadLines} lines`,
    );
  if (await tripLoad(ctx, trip._id))
    throw new ConvexError("Trip already has a load sheet");
  const seen = new Set<string>();
  const now = Date.now();
  const loadId = await ctx.db.insert("vanTripLoads", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    tripId: trip._id,
    loadNumber: 1,
    status: "planned",
    createdBy: actorSubject,
    createdAt: now,
    updatedAt: now,
  });
  for (const [index, line] of args.lines.entries()) {
    if (line.expectedBase <= 0n)
      throw new ConvexError("Expected quantity must be positive");
    const key = `${line.productId}:${line.lotId ?? ""}`;
    if (seen.has(key))
      throw new ConvexError("Each product/lot appears once on a load sheet");
    seen.add(key);
    const product = await ctx.db.get(line.productId);
    if (!product || !product.active)
      throw new ConvexError("Product not found or inactive");
    let lotNumber: string | undefined;
    if (line.lotId) {
      const lot = await ctx.db.get(line.lotId);
      if (!lot || lot.productId !== product._id)
        throw new ConvexError("Lot does not belong to the product");
      lotNumber = lot.lotNumber;
    }
    const unit = await productUnit(ctx, product);
    await ctx.db.insert("vanTripLoadLines", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      loadId,
      tripId: trip._id,
      lineNumber: index + 1,
      productId: product._id,
      productCode: product.code,
      uomCode: unit.uomCode,
      quantityScale: unit.quantityScale,
      ...(line.lotId ? { lotId: line.lotId } : {}),
      ...(lotNumber ? { lotNumber } : {}),
      expectedBase: line.expectedBase,
      createdAt: now,
      updatedAt: now,
    });
  }
  await ctx.db.patch(trip._id, { status: "loading", updatedAt: now });
  await audit(
    ctx,
    actorSubject,
    "van.load.planned",
    "vanTripLoad",
    loadId,
    `${args.lines.length} lines`,
    now,
  );
  return loadId;
}

/** Shared by approval and the matched-confirm path: post, then mark load and trip loaded. */
export async function finishLoad(
  ctx: MutationCtx,
  trip: Doc<"vanTrips">,
  load: Doc<"vanTripLoads">,
  actorSubject: string,
  deviceId?: Id<"registeredDevices">,
) {
  const lines = await loadLines(ctx, load._id);
  const { commandKey, movementId } = await postTripLoad(ctx, {
    trip,
    load,
    lines,
    actorSubject,
    ...(deviceId ? { deviceId } : {}),
  });
  const now = Date.now();
  await ctx.db.patch(load._id, {
    status: "posted",
    commandKey,
    movementId,
    updatedAt: now,
  });
  await ctx.db.patch(trip._id, { status: "loaded", updatedAt: now });
  return movementId;
}

/**
 * VAN-005: a supervisor in scope approves a load whose actual quantities differ from the
 * sheet. The person who confirmed the actuals can never approve them.
 */
export const approve = mutation({
  args: {
    tripId: v.id("vanTrips"),
    note: v.optional(v.string()),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const trip = await requireTrip(ctx, args.tripId);
    const { identity } = await requireCapability(
      ctx,
      "van.load.approve",
      trip.orgUnitId,
    );
    const load = await tripLoad(ctx, trip._id);
    if (!load || load.status !== "discrepancy" || trip.status !== "loading")
      throw new ConvexError("No load is waiting for approval");
    if (load.confirmedBy === identity.tokenIdentifier)
      throw new ConvexError(
        "The person who confirmed a load cannot approve it",
      );
    const note = boundedText(args.note, 300, "Approval note");
    const now = Date.now();
    await ctx.db.patch(load._id, {
      approvedBy: identity.tokenIdentifier,
      approvedAt: now,
      ...(note ? { approvalNote: note } : {}),
      updatedAt: now,
    });
    const movementId = await finishLoad(
      ctx,
      trip,
      { ...load, approvedBy: identity.tokenIdentifier },
      identity.tokenIdentifier,
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.load.approved",
      "vanTripLoad",
      load._id,
      note ?? "approved",
      now,
    );
    return movementId;
  },
});
