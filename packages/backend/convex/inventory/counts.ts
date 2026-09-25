import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import {
  readableLocationIds,
  requireLocationCapability,
} from "./location_scope";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import { hashPayload, postMovement, type PostingLine } from "./posting";
import { stockStatusValidator } from "./validators";

export const start = mutation({
  args: {
    locationId: v.id("inventoryLocations"),
    countType: v.union(
      v.literal("cycle"),
      v.literal("full"),
      v.literal("spot"),
      v.literal("route_close"),
    ),
    blindCount: v.boolean(),
  },
  returns: v.id("stockCountSessions"),
  handler: async (ctx, args) => {
    const { identity } = await requireLocationCapability(
      ctx,
      "inventory.count.submit",
      args.locationId,
    );
    const now = Date.now();
    const sessionId = await ctx.db.insert("stockCountSessions", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      countNumber: `SC-${now.toString(36).toUpperCase()}`,
      countType: args.countType,
      locationId: args.locationId,
      status: "counting",
      blindCount: args.blindCount,
      snapshotAt: now,
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    const balances = await ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("locationId", args.locationId),
      )
      .take(500);
    for (const balance of balances) {
      if (!balance.productId) continue;
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", balance.productId!),
        )
        .unique();
      if (policy?.trackingMode === "lot") {
        const lotRows = await ctx.db
          .query("inventoryLotBalances")
          .withIndex("by_org_product_location_status_expiry", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", balance.productId!)
              .eq("locationId", args.locationId)
              .eq("stockStatus", "available"),
          )
          .take(100);
        for (const lotRow of lotRows)
          await ctx.db.insert("stockCountLines", {
            organizationId: SUNPRIDE_ORGANIZATION_ID,
            sessionId,
            productId: lotRow.productId,
            lotId: lotRow.lotId,
            stockStatus: lotRow.stockStatus,
            systemBase: lotRow.physicalBase,
            snapshotBalanceVersion: lotRow.version,
            ...(lotRow.lastMovementId
              ? { snapshotMovementId: lotRow.lastMovementId }
              : {}),
          });
      } else
        await ctx.db.insert("stockCountLines", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          sessionId,
          productId: balance.productId,
          stockStatus: "available",
          systemBase: balance.availableStockBase ?? 0n,
          ...(balance.version !== undefined
            ? { snapshotBalanceVersion: balance.version }
            : {}),
          ...(balance.lastMovementId
            ? { snapshotMovementId: balance.lastMovementId }
            : {}),
        });
    }
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.count.started",
      entityType: "stockCountSession",
      entityId: sessionId,
      createdAt: now,
    });
    return sessionId;
  },
});

type Observation = {
  lineId: import("../_generated/dataModel").Id<"stockCountLines">;
  countedBase: bigint;
  finding?:
    "over" | "missing" | "damaged" | "expired" | "wrong_lot" | "wrong_location";
  note?: string;
};

export async function snapshotIsStale(
  ctx: QueryCtx | MutationCtx,
  session: import("../_generated/dataModel").Doc<"stockCountSessions">,
  lines: import("../_generated/dataModel").Doc<"stockCountLines">[],
): Promise<boolean> {
  for (const line of lines) {
    if (line.lotId) {
      const live = await ctx.db
        .query("inventoryLotBalances")
        .withIndex(
          "by_organizationId_and_lotId_and_locationId_and_stockStatus",
          (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("lotId", line.lotId!)
              .eq("locationId", session.locationId)
              .eq("stockStatus", line.stockStatus),
        )
        .unique();
      if (
        (live?.physicalBase ?? 0n) !== line.systemBase ||
        (line.snapshotBalanceVersion !== undefined &&
          live?.version !== line.snapshotBalanceVersion) ||
        (line.snapshotMovementId !== undefined &&
          live?.lastMovementId !== line.snapshotMovementId)
      )
        return true;
    } else {
      const live = await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", line.productId)
            .eq("locationId", session.locationId),
        )
        .unique();
      if (
        (live?.availableStockBase ?? 0n) !== line.systemBase ||
        (line.snapshotBalanceVersion !== undefined &&
          live?.version !== line.snapshotBalanceVersion) ||
        (line.snapshotMovementId !== undefined &&
          live?.lastMovementId !== line.snapshotMovementId)
      )
        return true;
    }
  }
  return false;
}

export async function assertFreshSnapshot(
  ctx: MutationCtx,
  session: import("../_generated/dataModel").Doc<"stockCountSessions">,
  lines: import("../_generated/dataModel").Doc<"stockCountLines">[],
) {
  if (lines.length > 100) throw new ConvexError("session_too_large");
  if (await snapshotIsStale(ctx, session, lines))
    throw new ConvexError("stale_snapshot: recount required");
}

export async function submitCount(
  ctx: MutationCtx,
  args: {
    sessionId: import("../_generated/dataModel").Id<"stockCountSessions">;
    lines: Observation[];
  },
) {
  await requireCapability(ctx, "inventory.count.submit");
  const session = await ctx.db.get(args.sessionId);
  if (!session || session.status !== "counting")
    throw new ConvexError("Count is not accepting entries");
  const { identity } = await requireLocationCapability(
    ctx,
    "inventory.count.submit",
    session.locationId,
  );
  const expected = await ctx.db
    .query("stockCountLines")
    .withIndex("by_organizationId_and_sessionId", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("sessionId", session._id),
    )
    .take(501);
  const ids = new Set(args.lines.map((line) => line.lineId));
  if (expected.length > 100) throw new ConvexError("session_too_large");
  if (args.lines.length !== expected.length)
    throw new ConvexError("All count lines must be counted exactly once");
  await assertFreshSnapshot(ctx, session, expected);
  if (
    expected.length > 500 ||
    ids.size !== args.lines.length ||
    expected.some((line) => !ids.has(line._id))
  )
    throw new ConvexError("All count lines must be counted exactly once");
  const now = Date.now();
  for (const input of args.lines) {
    if (input.countedBase < 0n)
      throw new ConvexError("Count cannot be negative");
    const line = await ctx.db.get(input.lineId);
    if (!line || line.sessionId !== session._id)
      throw new ConvexError("Count line does not belong to this session");
    await ctx.db.patch(line._id, {
      countedBase: input.countedBase,
      varianceBase: input.countedBase - line.systemBase,
      ...(input.finding ? { finding: input.finding } : {}),
      ...(input.note ? { note: input.note } : {}),
      countedBy: identity.tokenIdentifier,
      countedAt: now,
    });
  }
  await ctx.db.patch(session._id, { status: "submitted", updatedAt: now });
  await ctx.db.insert("auditLogs", {
    subject: identity.tokenIdentifier,
    action: "inventory.count.submitted",
    entityType: "stockCountSession",
    entityId: session._id,
    createdAt: now,
  });
  return null;
}

export const submit = mutation({
  args: {
    sessionId: v.id("stockCountSessions"),
    lines: v.array(
      v.object({
        lineId: v.id("stockCountLines"),
        countedBase: v.int64(),
        finding: v.optional(
          v.union(
            v.literal("over"),
            v.literal("missing"),
            v.literal("damaged"),
            v.literal("expired"),
            v.literal("wrong_lot"),
            v.literal("wrong_location"),
          ),
        ),
        note: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: submitCount,
});

export const approveAndPost = mutation({
  args: {
    sessionId: v.id("stockCountSessions"),
    idempotencyKey: v.string(),
    reasonCode: v.string(),
  },
  returns: v.id("inventoryAdjustments"),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "inventory.count.approve");
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "submitted")
      throw new ConvexError("Count is not ready for approval");
    const { identity } = await requireLocationCapability(
      ctx,
      "inventory.count.approve",
      session.locationId,
    );
    if (session.createdBy === identity.tokenIdentifier)
      throw new ConvexError("Counter cannot approve their own stock count");
    const countLines = await ctx.db
      .query("stockCountLines")
      .withIndex("by_organizationId_and_sessionId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("sessionId", session._id),
      )
      .take(101);
    if (countLines.length > 100) throw new ConvexError("session_too_large");
    await assertFreshSnapshot(ctx, session, countLines);
    if (countLines.some((line) => line.countedBy === identity.tokenIdentifier))
      throw new ConvexError("Counter cannot approve their own stock count");
    if (countLines.some((line) => line.countedBase === undefined))
      throw new ConvexError("All count lines must be counted");
    const now = Date.now();
    const adjustmentId = await ctx.db.insert("inventoryAdjustments", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      adjustmentNumber: `ADJ-${now.toString(36).toUpperCase()}`,
      adjustmentType: "stock_count",
      reasonCode: args.reasonCode,
      sourceCountId: session._id,
      status: "approved",
      requestedBy: session.createdBy,
      approvedBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    const postingLines: PostingLine[] = [];
    for (const line of countLines) {
      const variance = line.varianceBase ?? 0n;
      if (variance === 0n) continue;
      await ctx.db.insert("inventoryAdjustmentLines", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        adjustmentId,
        productId: line.productId,
        ...(line.lotId ? { lotId: line.lotId } : {}),
        locationId: session.locationId,
        stockStatus: line.stockStatus,
        varianceBase: variance,
        reasonCode: args.reasonCode,
      });
      postingLines.push({
        productId: line.productId,
        quantityBase: variance < 0n ? -variance : variance,
        ...(variance < 0n
          ? {
              fromLocationId: session.locationId,
              fromStockStatus: line.stockStatus,
            }
          : {
              toLocationId: session.locationId,
              toStockStatus: line.stockStatus,
            }),
        allocations: line.lotId
          ? [
              {
                lotId: line.lotId,
                quantityBase: variance < 0n ? -variance : variance,
                userSelected: true,
              },
            ]
          : undefined,
        sourceLineId: line._id,
        reasonCode: args.reasonCode,
      });
    }
    if (postingLines.length > 0) {
      const movement = await postMovement(ctx, {
        idempotencyKey: args.idempotencyKey,
        payloadHash: hashPayload({ sessionId: session._id, postingLines }),
        commandType: "stockCount.approveAndPost",
        movementType: "inventory_adjustment",
        sourceType: "stock_count",
        sourceDocumentId: adjustmentId,
        actorSubject: identity.tokenIdentifier,
        reasonCode: args.reasonCode,
        lines: postingLines,
      });
      await ctx.db.patch(adjustmentId, {
        status: "posted",
        movementId: movement.movementId,
        updatedAt: Date.now(),
      });
    } else
      await ctx.db.patch(adjustmentId, {
        status: "posted",
        updatedAt: Date.now(),
      });
    await ctx.db.patch(session._id, {
      status: "posted",
      approvedBy: identity.tokenIdentifier,
      adjustmentId,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.count.approved_and_posted",
      entityType: "stockCountSession",
      entityId: session._id,
      createdAt: Date.now(),
    });
    return adjustmentId;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const canRead = await readableLocationIds(ctx);
    const rows = await ctx.db
      .query("stockCountSessions")
      .order("desc")
      .take(250);
    const visible = [];
    for (const row of rows) {
      if (await canRead(row.locationId)) visible.push(row);
      if (visible.length >= Math.max(0, Math.min(args.limit ?? 100, 250)))
        break;
    }
    return visible;
  },
});

export const detail = query({
  args: { sessionId: v.id("stockCountSessions") },
  returns: v.object({
    session: v.any(),
    lines: v.array(
      v.object({
        lineId: v.id("stockCountLines"),
        productCode: v.string(),
        productName: v.string(),
        lotNumber: v.optional(v.string()),
        stockStatus: stockStatusValidator,
        systemBase: v.optional(v.int64()),
        countedBase: v.optional(v.int64()),
        varianceBase: v.optional(v.int64()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { identity } = await requireCapability(ctx, "inventory.read");
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new ConvexError("Stock count not found");
    await requireLocationCapability(ctx, "inventory.read", session.locationId);
    const rows = await ctx.db
      .query("stockCountLines")
      .withIndex("by_organizationId_and_sessionId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("sessionId", session._id),
      )
      .take(500);
    const hideExpected =
      session.blindCount &&
      (session.createdBy === identity.tokenIdentifier ||
        rows.some((row) => row.countedBy === identity.tokenIdentifier));
    const lines = [];
    for (const row of rows) {
      const [product, lot] = await Promise.all([
        ctx.db.get(row.productId),
        row.lotId ? ctx.db.get(row.lotId) : null,
      ]);
      if (!product) continue;
      lines.push({
        lineId: row._id,
        productCode: product.code,
        productName: product.name,
        ...(lot ? { lotNumber: lot.lotNumber } : {}),
        stockStatus: row.stockStatus,
        ...(!hideExpected ? { systemBase: row.systemBase } : {}),
        ...(row.countedBase !== undefined
          ? { countedBase: row.countedBase }
          : {}),
        ...(!hideExpected && row.varianceBase !== undefined
          ? { varianceBase: row.varianceBase }
          : {}),
      });
    }
    return { session, lines };
  },
});
