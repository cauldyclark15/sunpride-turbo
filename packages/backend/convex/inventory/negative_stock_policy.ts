import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  NEGATIVE_STOCK_MOVEMENT_TYPES,
  type MovementType,
  type NegativeStockMovementType,
} from "./validators";

/**
 * SP-0085 / ADR-007: distributor operations may post below zero, but only at a
 * location with an explicit, active allowance that names the movement type.
 * Everything else keeps the default non-negative rule (ADR-003).
 */
export function isNegativeStockMovementType(
  movementType: MovementType,
): movementType is NegativeStockMovementType {
  return (NEGATIVE_STOCK_MOVEMENT_TYPES as readonly string[]).includes(
    movementType,
  );
}

export async function activeNegativeStockAllowance(
  ctx: MutationCtx,
  locationId: Id<"inventoryLocations">,
  movementType: MovementType,
): Promise<Doc<"negativeStockAllowances"> | null> {
  if (!isNegativeStockMovementType(movementType)) return null;
  const allowance = await ctx.db
    .query("negativeStockAllowances")
    .withIndex("by_organizationId_and_locationId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("locationId", locationId),
    )
    .unique();
  if (!allowance?.active || !allowance.movementTypes.includes(movementType))
    return null;
  return allowance;
}

/** Every posting that leaves a negative balance is flagged for reconciliation. */
export async function flagNegativeStockPosting(
  ctx: MutationCtx,
  args: {
    allowance: Doc<"negativeStockAllowances">;
    movementId: Id<"inventoryMovements">;
    movementType: NegativeStockMovementType;
    productId: Id<"products">;
    locationId: Id<"inventoryLocations">;
    quantityBase: bigint;
    balanceAfterBase: bigint;
    actorSubject: string;
    now: number;
  },
) {
  const shortfall = -args.balanceAfterBase;
  const shortfallBase =
    shortfall < args.quantityBase ? shortfall : args.quantityBase;
  const flagId = await ctx.db.insert("negativeStockFlags", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    allowanceId: args.allowance._id,
    movementId: args.movementId,
    movementType: args.movementType,
    productId: args.productId,
    locationId: args.locationId,
    quantityBase: args.quantityBase,
    balanceAfterBase: args.balanceAfterBase,
    shortfallBase,
    status: "open",
    postedBy: args.actorSubject,
    createdAt: args.now,
  });
  await ctx.db.insert("auditLogs", {
    subject: args.actorSubject,
    action: "inventory.negative_stock.flagged",
    entityType: "negativeStockFlag",
    entityId: flagId,
    details: `movement:${args.movementId}`,
    createdAt: args.now,
  });
  return flagId;
}
