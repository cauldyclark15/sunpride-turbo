import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  MAX_ALLOCATIONS_PER_LINE,
  MAX_COMMAND_LINES,
  SUNPRIDE_ORGANIZATION_ID,
} from "./constants";
import type { MovementType, StockStatus } from "./validators";

export type PostingAllocation = {
  lotId: Id<"inventoryLots">;
  quantityBase: bigint;
  userSelected?: boolean;
  reversesAllocationId?: Id<"inventoryAllocations">;
};

export type PostingLine = {
  productId: Id<"products">;
  quantityBase: bigint;
  enteredQuantity?: string;
  enteredUomCode?: string;
  fromLocationId?: Id<"inventoryLocations">;
  toLocationId?: Id<"inventoryLocations">;
  fromStockStatus?: StockStatus;
  toStockStatus?: StockStatus;
  allocations?: PostingAllocation[];
  sourceLineId?: string;
  unitCostMinor?: bigint;
  sourceReservedDeltaBase?: bigint;
  reasonCode?: string;
};

export type PostMovementInput = {
  idempotencyKey: string;
  payloadHash: string;
  commandType: string;
  movementType: MovementType;
  sourceType: string;
  sourceDocumentId?: string;
  actorSubject: string;
  deviceId?: string;
  reasonCode?: string;
  note?: string;
  effectiveAt?: number;
  reversesMovementId?: Id<"inventoryMovements">;
  lines: PostingLine[];
  emitIntegrationEvent?: boolean;
};

const ZERO = 0n;

export function canonicalize(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
    .join(",")}}`;
}

export function hashPayload(value: unknown): string {
  const input = canonicalize(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function statusField(status: StockStatus) {
  return {
    available: "availableStockBase",
    quality_hold: "qualityHoldBase",
    quarantine: "quarantineBase",
    damaged: "damagedBase",
    expired: "expiredBase",
    rejected: "rejectedBase",
    wip: "wipBase",
    in_transit: "inTransitBase",
  }[status] as
    | "availableStockBase"
    | "qualityHoldBase"
    | "quarantineBase"
    | "damagedBase"
    | "expiredBase"
    | "rejectedBase"
    | "wipBase"
    | "inTransitBase";
}

async function requireProductAndPolicy(
  ctx: MutationCtx,
  productId: Id<"products">,
) {
  const product = await ctx.db.get(productId);
  if (!product || !product.active)
    throw new ConvexError("Product not found or inactive");
  const policy = await ctx.db
    .query("productInventoryPolicies")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", productId),
    )
    .unique();
  return { product, policy };
}

async function requireLocation(
  ctx: MutationCtx,
  locationId: Id<"inventoryLocations">,
) {
  const location = await ctx.db.get(locationId);
  if (
    !location ||
    !location.active ||
    location.organizationId !== SUNPRIDE_ORGANIZATION_ID
  )
    throw new ConvexError("Inventory location not found or inactive");
  return location;
}

function emptySummary(
  product: Doc<"products">,
  location: Doc<"inventoryLocations">,
  now: number,
) {
  return {
    productCode: product.code,
    warehouseCode: location.code,
    onHand: 0,
    reserved: 0,
    available: 0,
    asOf: now,
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    productId: product._id,
    locationId: location._id,
    physicalBase: ZERO,
    availableStockBase: ZERO,
    reservedBase: ZERO,
    availableBase: ZERO,
    qualityHoldBase: ZERO,
    quarantineBase: ZERO,
    damagedBase: ZERO,
    expiredBase: ZERO,
    rejectedBase: ZERO,
    wipBase: ZERO,
    inTransitBase: ZERO,
    weightedAverageCostMinor: ZERO,
    inventoryValueMinor: ZERO,
    version: 0,
  };
}

export async function applySummaryDelta(
  ctx: MutationCtx,
  args: {
    product: Doc<"products">;
    location: Doc<"inventoryLocations">;
    status: StockStatus;
    quantityDeltaBase: bigint;
    physicalDeltaBase: bigint;
    reservedDeltaBase?: bigint;
    unitCostMinor?: bigint;
    movementId: Id<"inventoryMovements">;
    now: number;
  },
) {
  const existing = await ctx.db
    .query("inventoryBalances")
    .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", args.product._id)
        .eq("locationId", args.location._id),
    )
    .unique();
  const base = existing ?? emptySummary(args.product, args.location, args.now);
  const field = statusField(args.status);
  const statusBefore = base[field] ?? ZERO;
  const statusAfter = statusBefore + args.quantityDeltaBase;
  const physicalAfter = (base.physicalBase ?? ZERO) + args.physicalDeltaBase;
  const reservedAfter =
    (base.reservedBase ?? ZERO) + (args.reservedDeltaBase ?? ZERO);
  const availableStockAfter =
    field === "availableStockBase"
      ? statusAfter
      : (base.availableStockBase ?? ZERO);
  const availableAfter = availableStockAfter - reservedAfter;
  if (statusAfter < ZERO || physicalAfter < ZERO || reservedAfter < ZERO)
    throw new ConvexError("Inventory movement would create a negative balance");
  const policy = await ctx.db
    .query("productInventoryPolicies")
    .withIndex("by_organizationId_and_productId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", args.product._id),
    )
    .unique();
  // ADR-003 / CVX-016: negative availability is forbidden even when a legacy policy allows negative stock.
  if (availableAfter < ZERO)
    throw new ConvexError("Insufficient available stock");
  const scale = Number(
    policy?.quantityScale ?? args.product.quantityScale ?? 1n,
  );
  const quantityScale =
    policy?.quantityScale ?? args.product.quantityScale ?? 1n;
  const valueBefore = base.inventoryValueMinor ?? ZERO;
  const valueDelta =
    args.physicalDeltaBase === ZERO
      ? ZERO
      : ((args.unitCostMinor ?? base.weightedAverageCostMinor ?? ZERO) *
          args.physicalDeltaBase) /
        quantityScale;
  const inventoryValueAfter = valueBefore + valueDelta;
  if (inventoryValueAfter < ZERO)
    throw new ConvexError("Inventory value would become negative");
  const weightedAverageCostMinor =
    physicalAfter > ZERO
      ? (inventoryValueAfter * quantityScale) / physicalAfter
      : ZERO;
  const patch = {
    [field]: statusAfter,
    physicalBase: physicalAfter,
    reservedBase: reservedAfter,
    availableBase: availableAfter,
    onHand: Number(physicalAfter) / scale,
    reserved: Number(reservedAfter) / scale,
    available: Number(availableAfter) / scale,
    weightedAverageCostMinor,
    inventoryValueMinor: inventoryValueAfter,
    asOf: args.now,
    version: (base.version ?? 0) + 1,
    lastMovementId: args.movementId,
  };
  if (existing) await ctx.db.patch(existing._id, patch);
  else await ctx.db.insert("inventoryBalances", { ...base, ...patch });
  return {
    before: statusBefore,
    after: statusAfter,
    version: patch.version,
    valueDelta,
  };
}

export async function applyLotDelta(
  ctx: MutationCtx,
  args: {
    productId: Id<"products">;
    lotId: Id<"inventoryLots">;
    locationId: Id<"inventoryLocations">;
    status: StockStatus;
    quantityDeltaBase: bigint;
    reservedDeltaBase?: bigint;
    movementId: Id<"inventoryMovements">;
    now: number;
  },
) {
  const lot = await ctx.db.get(args.lotId);
  if (!lot || lot.productId !== args.productId)
    throw new ConvexError("Lot does not belong to the product");
  const existing = await ctx.db
    .query("inventoryLotBalances")
    .withIndex(
      "by_organizationId_and_lotId_and_locationId_and_stockStatus",
      (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("lotId", args.lotId)
          .eq("locationId", args.locationId)
          .eq("stockStatus", args.status),
    )
    .unique();
  const before = existing?.physicalBase ?? ZERO;
  const after = before + args.quantityDeltaBase;
  const reservedAfter =
    (existing?.reservedBase ?? ZERO) + (args.reservedDeltaBase ?? ZERO);
  const availableAfter = after - reservedAfter;
  if (after < ZERO || reservedAfter < ZERO || availableAfter < ZERO)
    throw new ConvexError("Lot movement would create a negative balance");
  const patch = {
    physicalBase: after,
    reservedBase: reservedAfter,
    availableBase: availableAfter,
    version: (existing?.version ?? 0) + 1,
    lastMovementId: args.movementId,
    updatedAt: args.now,
  };
  if (existing) await ctx.db.patch(existing._id, patch);
  else
    await ctx.db.insert("inventoryLotBalances", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productId: args.productId,
      lotId: args.lotId,
      locationId: args.locationId,
      stockStatus: args.status,
      expirySortKey: lot.expiresAt ?? Number.MAX_SAFE_INTEGER,
      receiptSequence: lot.receivedAt,
      ...patch,
    });
  return { before, after, version: patch.version };
}

export async function allocateTrackedSource(
  ctx: MutationCtx,
  line: PostingLine,
  policy: Doc<"productInventoryPolicies">,
  movementType: MovementType = "reservation",
  now = Date.now(),
) {
  if (line.allocations?.length) {
    const total = line.allocations.reduce(
      (sum, allocation) => sum + allocation.quantityBase,
      ZERO,
    );
    if (total !== line.quantityBase)
      throw new ConvexError(
        "Explicit lot allocations must equal line quantity",
      );
    // Only outbound sale/issue selections using FEFO are expiry-gated. Exact
    // returns, reversals, adjustments and disposition must retain their lots.
    if (
      policy.allocationPolicy === "fefo" &&
      line.fromLocationId &&
      (movementType === "pos_sale" ||
        movementType === "inventory_issue" ||
        movementType === "production_issue")
    ) {
      for (const allocation of line.allocations) {
        const lot = await ctx.db.get(allocation.lotId);
        if (lot?.expiresAt !== undefined && lot.expiresAt <= now)
          throw new ConvexError(
            "Cannot select an expired lot for sale or issue",
          );
      }
    }
    return line.allocations;
  }
  if (!line.fromLocationId)
    throw new ConvexError("A lot allocation is required for tracked receipts");
  if (policy.allocationPolicy === "explicit_only")
    throw new ConvexError("This product requires explicit lot selection");
  const status = line.fromStockStatus ?? "available";
  const candidates = await ctx.db
    .query("inventoryLotBalances")
    .withIndex("by_org_product_location_status_expiry", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("productId", line.productId)
        .eq("locationId", line.fromLocationId!)
        .eq("stockStatus", status),
    )
    .take(MAX_ALLOCATIONS_PER_LINE);
  const ordered =
    policy.allocationPolicy === "fifo"
      ? [...candidates].sort(
          (left, right) => left.receiptSequence - right.receiptSequence,
        )
      : candidates;
  let remaining = line.quantityBase;
  const allocations: PostingAllocation[] = [];
  for (const candidate of ordered) {
    if (remaining <= ZERO) break;
    if (candidate.availableBase <= ZERO) continue;
    if (policy.allocationPolicy === "fefo") {
      const lot = await ctx.db.get(candidate.lotId);
      const expiresAt = lot?.expiresAt;
      const minimumShelfLifeMs =
        policy.minimumRemainingShelfLifeDays * 86_400_000;
      if (
        (expiresAt !== undefined && expiresAt <= now) ||
        (minimumShelfLifeMs > 0 &&
          (expiresAt === undefined || expiresAt - now < minimumShelfLifeMs))
      )
        continue;
    }
    const quantityBase =
      candidate.availableBase < remaining ? candidate.availableBase : remaining;
    allocations.push({ lotId: candidate.lotId, quantityBase });
    remaining -= quantityBase;
  }
  if (remaining > ZERO)
    throw new ConvexError("Insufficient eligible lot stock");
  return allocations;
}

function validateLine(line: PostingLine) {
  if (line.quantityBase <= ZERO)
    throw new ConvexError("Quantity must be positive");
  if (!line.fromLocationId && !line.toLocationId)
    throw new ConvexError("A movement line needs a source or destination");
  if (line.fromLocationId === line.toLocationId) {
    const fromStatus = line.fromStockStatus ?? "available";
    const toStatus = line.toStockStatus ?? "available";
    if (fromStatus === toStatus)
      throw new ConvexError("Source and destination are identical");
  }
  if ((line.allocations?.length ?? 0) > MAX_ALLOCATIONS_PER_LINE)
    throw new ConvexError("Too many lot allocations on one line");
}

export async function postMovement(ctx: MutationCtx, input: PostMovementInput) {
  if (input.lines.length === 0 || input.lines.length > MAX_COMMAND_LINES)
    throw new ConvexError(`Movement requires 1-${MAX_COMMAND_LINES} lines`);
  const duplicate = await ctx.db
    .query("inventoryCommands")
    .withIndex("by_organizationId_and_idempotencyKey", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("idempotencyKey", input.idempotencyKey),
    )
    .unique();
  if (duplicate) {
    if (duplicate.payloadHash !== input.payloadHash)
      throw new ConvexError(
        "Idempotency key was already used for another payload",
      );
    if (!duplicate.movementId)
      throw new ConvexError("Command is not replayable");
    const movement = await ctx.db.get(duplicate.movementId);
    if (!movement) throw new ConvexError("Command movement is missing");
    return {
      movementId: movement._id,
      movementNumber: movement.movementNumber,
      duplicate: true,
    };
  }
  const now = Date.now();
  const effectiveAt = input.effectiveAt ?? now;
  const movementNumber = `MV-${now.toString(36).toUpperCase()}-${hashPayload(input.idempotencyKey).slice(-6).toUpperCase()}`;
  const movementId = await ctx.db.insert("inventoryMovements", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    movementNumber,
    movementType: input.movementType,
    sourceType: input.sourceType,
    ...(input.sourceDocumentId
      ? { sourceDocumentId: input.sourceDocumentId }
      : {}),
    status: "posted",
    effectiveAt,
    postedAt: now,
    postedBy: input.actorSubject,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    idempotencyKey: input.idempotencyKey,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.reversesMovementId
      ? { reversesMovementId: input.reversesMovementId }
      : {}),
    schemaVersion: 1,
  });

  for (const [lineIndex, line] of input.lines.entries()) {
    validateLine(line);
    const { product, policy } = await requireProductAndPolicy(
      ctx,
      line.productId,
    );
    const fromLocation = line.fromLocationId
      ? await requireLocation(ctx, line.fromLocationId)
      : null;
    const toLocation = line.toLocationId
      ? await requireLocation(ctx, line.toLocationId)
      : null;
    const fromStatus = line.fromStockStatus ?? "available";
    const toStatus = line.toStockStatus ?? "available";
    const isSameLocation = line.fromLocationId === line.toLocationId;
    const sourceSummary = fromLocation
      ? await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", product._id)
              .eq("locationId", fromLocation._id),
          )
          .unique()
      : null;
    const effectiveUnitCostMinor =
      line.unitCostMinor ?? sourceSummary?.weightedAverageCostMinor ?? ZERO;
    const quantityScale = policy?.quantityScale ?? product.quantityScale ?? 1n;
    const movementLineId = await ctx.db.insert("inventoryMovementLines", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      movementId,
      lineNumber: lineIndex + 1,
      productId: product._id,
      ...(policy?.baseUomId ? { baseUomId: policy.baseUomId } : {}),
      quantityBase: line.quantityBase,
      ...(line.enteredQuantity
        ? { enteredQuantity: line.enteredQuantity }
        : {}),
      ...(line.enteredUomCode ? { enteredUomCode: line.enteredUomCode } : {}),
      ...(line.fromLocationId ? { fromLocationId: line.fromLocationId } : {}),
      ...(line.toLocationId ? { toLocationId: line.toLocationId } : {}),
      ...(line.fromLocationId ? { fromStockStatus: fromStatus } : {}),
      ...(line.toLocationId ? { toStockStatus: toStatus } : {}),
      ...(line.sourceLineId ? { sourceLineId: line.sourceLineId } : {}),
      ...(effectiveUnitCostMinor > ZERO
        ? {
            unitCostMinor: effectiveUnitCostMinor,
            totalCostMinor:
              (effectiveUnitCostMinor * line.quantityBase) / quantityScale,
          }
        : {}),
      ...(line.reasonCode ? { reasonCode: line.reasonCode } : {}),
      effectiveAt,
    });

    const fromSummary = fromLocation
      ? await applySummaryDelta(ctx, {
          product,
          location: fromLocation,
          status: fromStatus,
          quantityDeltaBase: -line.quantityBase,
          physicalDeltaBase: isSameLocation ? ZERO : -line.quantityBase,
          reservedDeltaBase: line.sourceReservedDeltaBase,
          unitCostMinor: effectiveUnitCostMinor,
          movementId,
          now,
        })
      : null;
    const toSummary = toLocation
      ? await applySummaryDelta(ctx, {
          product,
          location: toLocation,
          status: toStatus,
          quantityDeltaBase: line.quantityBase,
          physicalDeltaBase: isSameLocation ? ZERO : line.quantityBase,
          unitCostMinor: effectiveUnitCostMinor,
          movementId,
          now,
        })
      : null;

    const isTracked = policy?.trackingMode === "lot";
    const allocations = isTracked
      ? await allocateTrackedSource(ctx, line, policy, input.movementType, now)
      : [];
    if (!isTracked && line.allocations?.length)
      throw new ConvexError("Non-lot product cannot receive lot allocations");

    if (allocations.length === 0) {
      if (fromLocation) {
        const summary = await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", product._id)
              .eq("locationId", fromLocation._id),
          )
          .unique();
        await ctx.db.insert("inventoryLedgerEntries", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          movementId,
          movementLineId,
          productId: product._id,
          locationId: fromLocation._id,
          stockStatus: fromStatus,
          quantityDeltaBase: -line.quantityBase,
          reservedDeltaBase: line.sourceReservedDeltaBase ?? ZERO,
          valueDeltaMinor: fromSummary?.valueDelta,
          balanceVersion: summary?.version ?? 1,
          quantityBeforeBase:
            (summary?.[statusField(fromStatus)] ?? ZERO) + line.quantityBase,
          quantityAfterBase: summary?.[statusField(fromStatus)] ?? ZERO,
          effectiveAt,
          postedAt: now,
        });
      }
      if (toLocation) {
        const summary = await ctx.db
          .query("inventoryBalances")
          .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", product._id)
              .eq("locationId", toLocation._id),
          )
          .unique();
        await ctx.db.insert("inventoryLedgerEntries", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          movementId,
          movementLineId,
          productId: product._id,
          locationId: toLocation._id,
          stockStatus: toStatus,
          quantityDeltaBase: line.quantityBase,
          reservedDeltaBase: ZERO,
          valueDeltaMinor: toSummary?.valueDelta,
          balanceVersion: summary?.version ?? 1,
          quantityBeforeBase:
            (summary?.[statusField(toStatus)] ?? ZERO) - line.quantityBase,
          quantityAfterBase: summary?.[statusField(toStatus)] ?? ZERO,
          effectiveAt,
          postedAt: now,
        });
      }
      continue;
    }

    for (const [allocationIndex, allocation] of allocations.entries()) {
      const allocationReservedDelta = line.sourceReservedDeltaBase
        ? (line.sourceReservedDeltaBase * allocation.quantityBase) /
          line.quantityBase
        : ZERO;
      const allocationId = await ctx.db.insert("inventoryAllocations", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        movementId,
        movementLineId,
        productId: product._id,
        lotId: allocation.lotId,
        quantityBase: allocation.quantityBase,
        ...(line.fromLocationId ? { fromLocationId: line.fromLocationId } : {}),
        ...(line.toLocationId ? { toLocationId: line.toLocationId } : {}),
        ...(line.fromLocationId ? { fromStockStatus: fromStatus } : {}),
        ...(line.toLocationId ? { toStockStatus: toStatus } : {}),
        allocationSequence: allocationIndex + 1,
        allocationPolicy: policy?.allocationPolicy ?? "fifo",
        userSelected: allocation.userSelected ?? Boolean(line.allocations),
        ...(allocation.reversesAllocationId
          ? { reversesAllocationId: allocation.reversesAllocationId }
          : {}),
        effectiveAt,
      });
      if (fromLocation) {
        const result = await applyLotDelta(ctx, {
          productId: product._id,
          lotId: allocation.lotId,
          locationId: fromLocation._id,
          status: fromStatus,
          quantityDeltaBase: -allocation.quantityBase,
          reservedDeltaBase: allocationReservedDelta,
          movementId,
          now,
        });
        await ctx.db.insert("inventoryLedgerEntries", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          movementId,
          movementLineId,
          allocationId,
          productId: product._id,
          lotId: allocation.lotId,
          locationId: fromLocation._id,
          stockStatus: fromStatus,
          quantityDeltaBase: -allocation.quantityBase,
          reservedDeltaBase: allocationReservedDelta,
          valueDeltaMinor:
            (-effectiveUnitCostMinor * allocation.quantityBase) / quantityScale,
          balanceVersion: result.version,
          quantityBeforeBase: result.before,
          quantityAfterBase: result.after,
          effectiveAt,
          postedAt: now,
        });
      }
      if (toLocation) {
        const result = await applyLotDelta(ctx, {
          productId: product._id,
          lotId: allocation.lotId,
          locationId: toLocation._id,
          status: toStatus,
          quantityDeltaBase: allocation.quantityBase,
          movementId,
          now,
        });
        await ctx.db.insert("inventoryLedgerEntries", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          movementId,
          movementLineId,
          allocationId,
          productId: product._id,
          lotId: allocation.lotId,
          locationId: toLocation._id,
          stockStatus: toStatus,
          quantityDeltaBase: allocation.quantityBase,
          reservedDeltaBase: ZERO,
          valueDeltaMinor:
            (effectiveUnitCostMinor * allocation.quantityBase) / quantityScale,
          balanceVersion: result.version,
          quantityBeforeBase: result.before,
          quantityAfterBase: result.after,
          effectiveAt,
          postedAt: now,
        });
      }
    }
  }

  await ctx.db.insert("inventoryCommands", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    idempotencyKey: input.idempotencyKey,
    commandType: input.commandType,
    schemaVersion: 1,
    payloadHash: input.payloadHash,
    actorSubject: input.actorSubject,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    status: "posted",
    ...(input.sourceDocumentId
      ? { sourceDocumentId: input.sourceDocumentId }
      : {}),
    movementId,
    result: { movementId, movementNumber },
    createdAt: now,
    committedAt: now,
  });
  await ctx.db.insert("auditLogs", {
    subject: input.actorSubject,
    action: `inventory.${input.movementType}.posted`,
    entityType: "inventoryMovement",
    entityId: movementId,
    details: input.sourceDocumentId,
    createdAt: now,
  });
  if (input.emitIntegrationEvent !== false)
    await ctx.db.insert("integrationEvents", {
      eventId: `inventory-${movementId}`,
      direction: "outbound",
      eventType: `inventory.${input.movementType}.posted`,
      status: "pending",
      attempts: 0,
      payload: {
        movementId,
        movementNumber,
        movementType: input.movementType,
        sourceType: input.sourceType,
        sourceDocumentId: input.sourceDocumentId,
      },
      receivedAt: now,
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      schemaVersion: 1,
      payloadHash: hashPayload({ movementId, movementNumber }),
      sourceDocumentId: input.sourceDocumentId,
      movementId,
      nextAttemptAt: now,
    });
  if (input.reversesMovementId)
    await ctx.db.patch(input.reversesMovementId, {
      status: "reversed",
      reversedByMovementId: movementId,
    });
  return { movementId, movementNumber, duplicate: false };
}

export async function findExistingCommand(
  ctx: MutationCtx,
  idempotencyKey: string,
  payloadHash: string,
) {
  const command = await ctx.db
    .query("inventoryCommands")
    .withIndex("by_organizationId_and_idempotencyKey", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("idempotencyKey", idempotencyKey),
    )
    .unique();
  if (command && command.payloadHash !== payloadHash)
    throw new ConvexError(
      "Idempotency key was already used for another payload",
    );
  return command;
}

export async function reverseMovement(
  ctx: MutationCtx,
  args: {
    originalMovementId: Id<"inventoryMovements">;
    idempotencyKey: string;
    actorSubject: string;
    sourceType: string;
    sourceDocumentId?: string;
    note?: string;
  },
) {
  const original = await ctx.db.get(args.originalMovementId);
  if (!original || original.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Original movement not found");
  if (original.status === "reversed" || original.reversedByMovementId)
    throw new ConvexError("Movement is already reversed");
  const lines = await ctx.db
    .query("inventoryMovementLines")
    .withIndex("by_organizationId_and_movementId_and_lineNumber", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("movementId", original._id),
    )
    .take(MAX_COMMAND_LINES);
  const reversalLines: PostingLine[] = [];
  for (const line of lines) {
    const allocations = await ctx.db
      .query("inventoryAllocations")
      .withIndex("by_organizationId_and_movementLineId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("movementLineId", line._id),
      )
      .take(MAX_ALLOCATIONS_PER_LINE);
    reversalLines.push({
      productId: line.productId,
      quantityBase: line.quantityBase,
      fromLocationId: line.toLocationId,
      toLocationId: line.fromLocationId,
      fromStockStatus: line.toStockStatus,
      toStockStatus: line.fromStockStatus,
      allocations:
        allocations.length > 0
          ? allocations.map((allocation) => ({
              lotId: allocation.lotId,
              quantityBase: allocation.quantityBase,
              userSelected: true,
              reversesAllocationId: allocation._id,
            }))
          : undefined,
      sourceLineId: line.sourceLineId,
      unitCostMinor: line.unitCostMinor,
      reasonCode: "exact_reversal",
    });
  }
  return postMovement(ctx, {
    idempotencyKey: args.idempotencyKey,
    payloadHash: hashPayload({
      originalMovementId: args.originalMovementId,
      sourceDocumentId: args.sourceDocumentId,
    }),
    commandType: "movement.reverse",
    movementType: "reversal",
    sourceType: args.sourceType,
    sourceDocumentId: args.sourceDocumentId,
    actorSubject: args.actorSubject,
    note: args.note,
    reversesMovementId: original._id,
    lines: reversalLines,
  });
}
