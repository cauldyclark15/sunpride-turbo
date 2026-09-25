import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireNationalScope } from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  readableLocationIds,
  requireLocationCapability,
} from "./location_scope";
import { hashPayload, postMovement, type PostingLine } from "./posting";
import { productionStatusValidator } from "./validators";

export const createBomVersion = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    outputProductId: v.id("products"),
    outputQuantityBase: v.int64(),
    effectiveFrom: v.number(),
    yieldTargetBps: v.number(),
    components: v.array(
      v.object({
        productId: v.id("products"),
        quantityBase: v.int64(),
        issuePolicy: v.union(
          v.literal("backflush"),
          v.literal("manual_issue"),
          v.literal("staged"),
        ),
        scrapAllowanceBps: v.optional(v.number()),
        optional: v.optional(v.boolean()),
        preferredLocationId: v.optional(v.id("inventoryLocations")),
      }),
    ),
  },
  returns: v.id("billOfMaterialVersions"),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(ctx, ["admin"]);
    if (args.outputQuantityBase <= 0n || args.components.length === 0)
      throw new ConvexError("BOM needs positive output and components");
    const now = Date.now();
    const existingBom = await ctx.db
      .query("billOfMaterials")
      .withIndex("by_organizationId_and_code", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("code", args.code.trim().toUpperCase()),
      )
      .unique();
    const bomId =
      existingBom?._id ??
      (await ctx.db.insert("billOfMaterials", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        productId: args.outputProductId,
        code: args.code.trim().toUpperCase(),
        name: args.name,
        active: true,
        createdAt: now,
        updatedAt: now,
      }));
    const versions = await ctx.db
      .query("billOfMaterialVersions")
      .withIndex("by_organizationId_and_bomId_and_version", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("bomId", bomId),
      )
      .order("desc")
      .take(1);
    const versionId = await ctx.db.insert("billOfMaterialVersions", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      bomId,
      version: (versions[0]?.version ?? 0) + 1,
      outputQuantityBase: args.outputQuantityBase,
      status: "draft",
      effectiveFrom: args.effectiveFrom,
      yieldTargetBps: args.yieldTargetBps,
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    for (const component of args.components) {
      if (component.quantityBase <= 0n)
        throw new ConvexError("BOM component quantity must be positive");
      await ctx.db.insert("billOfMaterialComponents", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        bomVersionId: versionId,
        componentProductId: component.productId,
        quantityBase: component.quantityBase,
        issuePolicy: component.issuePolicy,
        scrapAllowanceBps: component.scrapAllowanceBps ?? 0,
        optional: component.optional ?? false,
        ...(component.preferredLocationId
          ? { preferredLocationId: component.preferredLocationId }
          : {}),
        createdAt: now,
      });
    }
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.bom.version_created",
      entityType: "billOfMaterialVersion",
      entityId: versionId,
      createdAt: now,
    });
    return versionId;
  },
});

export const approveBomVersion = mutation({
  args: { bomVersionId: v.id("billOfMaterialVersions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(ctx, ["admin", "approver"]);
    const version = await ctx.db.get(args.bomVersionId);
    if (!version || !["draft", "approved"].includes(version.status))
      throw new ConvexError("BOM version is not approvable");
    if (version.createdBy === identity.tokenIdentifier)
      throw new ConvexError("BOM author cannot approve the same version");
    const siblings = await ctx.db
      .query("billOfMaterialVersions")
      .withIndex("by_organizationId_and_bomId_and_version", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("bomId", version.bomId),
      )
      .take(50);
    const now = Date.now();
    for (const sibling of siblings)
      if (sibling.status === "active")
        await ctx.db.patch(sibling._id, {
          status: "obsolete",
          effectiveTo: now,
          updatedAt: now,
        });
    await ctx.db.patch(version._id, {
      status: "active",
      approvedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.bom.version_activated",
      entityType: "billOfMaterialVersion",
      entityId: version._id,
      createdAt: now,
    });
    return null;
  },
});

export const createProductionOrder = mutation({
  args: {
    productId: v.id("products"),
    bomVersionId: v.id("billOfMaterialVersions"),
    plannedBase: v.int64(),
    sourceLocationId: v.id("inventoryLocations"),
    wipLocationId: v.id("inventoryLocations"),
    outputLocationId: v.id("inventoryLocations"),
  },
  returns: v.id("productionOrders"),
  handler: async (ctx, args) => {
    const { identity } = await requireLocationCapability(
      ctx,
      "inventory.write",
      args.sourceLocationId,
    );
    await requireLocationCapability(ctx, "inventory.write", args.wipLocationId);
    await requireLocationCapability(
      ctx,
      "inventory.write",
      args.outputLocationId,
    );
    const version = await ctx.db.get(args.bomVersionId);
    if (!version || version.status !== "active")
      throw new ConvexError("Active BOM version required");
    const bom = await ctx.db.get(version.bomId);
    if (!bom || bom.productId !== args.productId)
      throw new ConvexError("BOM does not produce the selected product");
    if (args.plannedBase <= 0n)
      throw new ConvexError("Planned quantity must be positive");
    const components = await ctx.db
      .query("billOfMaterialComponents")
      .withIndex("by_organizationId_and_bomVersionId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("bomVersionId", version._id),
      )
      .take(100);
    for (const component of components)
      if (component.preferredLocationId)
        await requireLocationCapability(
          ctx,
          "inventory.write",
          component.preferredLocationId,
        );
    const now = Date.now();
    return ctx.db.insert("productionOrders", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productionOrderNumber: `PO-${now.toString(36).toUpperCase()}`,
      productId: args.productId,
      bomVersionId: args.bomVersionId,
      plannedBase: args.plannedBase,
      completedBase: 0n,
      scrappedBase: 0n,
      sourceLocationId: args.sourceLocationId,
      wipLocationId: args.wipLocationId,
      outputLocationId: args.outputLocationId,
      status: "released",
      createdBy: identity.tokenIdentifier,
      releasedBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const complete = mutation({
  args: {
    productionOrderId: v.id("productionOrders"),
    idempotencyKey: v.string(),
    outputQuantityBase: v.int64(),
    outputLotNumber: v.string(),
    manufacturedAt: v.number(),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({
    movementId: v.id("inventoryMovements"),
    outputLotId: v.id("inventoryLots"),
  }),
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.productionOrderId);
    if (!order || order.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Production order not found");
    const { identity } = await requireLocationCapability(
      ctx,
      "inventory.write",
      order.sourceLocationId,
    );
    await requireLocationCapability(
      ctx,
      "inventory.write",
      order.wipLocationId,
    );
    await requireLocationCapability(
      ctx,
      "inventory.write",
      order.outputLocationId,
    );
    if (
      ![
        "released",
        "material_staged",
        "in_progress",
        "partially_completed",
      ].includes(order.status)
    )
      throw new ConvexError("Production order is not completable");
    if (
      args.outputQuantityBase <= 0n ||
      order.completedBase + args.outputQuantityBase > order.plannedBase
    )
      throw new ConvexError("Output exceeds remaining planned quantity");
    const version = await ctx.db.get(order.bomVersionId);
    if (!version) throw new ConvexError("Pinned BOM version is missing");
    const components = await ctx.db
      .query("billOfMaterialComponents")
      .withIndex("by_organizationId_and_bomVersionId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("bomVersionId", version._id),
      )
      .take(100);
    for (const component of components)
      if (component.preferredLocationId)
        await requireLocationCapability(
          ctx,
          "inventory.write",
          component.preferredLocationId,
        );
    const outputPolicy = await ctx.db
      .query("productInventoryPolicies")
      .withIndex("by_organizationId_and_productId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("productId", order.productId),
      )
      .unique();
    if (!outputPolicy || outputPolicy.trackingMode !== "lot")
      throw new ConvexError(
        "Manufacturing output must use lot tracking for genealogy",
      );
    if (outputPolicy?.expiryDateRequired && !args.expiresAt)
      throw new ConvexError("Output lot requires an expiry date");
    const normalizedLotNumber = args.outputLotNumber.trim().toUpperCase();
    const duplicateLot = await ctx.db
      .query("inventoryLots")
      .withIndex(
        "by_organizationId_and_productId_and_normalizedLotNumber",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", order.productId)
            .eq("normalizedLotNumber", normalizedLotNumber),
      )
      .unique();
    if (duplicateLot) throw new ConvexError("Output lot number already exists");
    const now = Date.now();
    const outputLotId = await ctx.db.insert("inventoryLots", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productId: order.productId,
      lotNumber: args.outputLotNumber.trim(),
      normalizedLotNumber,
      sourceType: "production",
      sourceDocumentId: order._id,
      manufacturedAt: args.manufacturedAt,
      receivedAt: now,
      ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
      qualityStatus: outputPolicy?.qualityReleaseRequired
        ? "pending"
        : "released",
      createdAt: now,
      updatedAt: now,
    });
    const postingLines: PostingLine[] = components.map((component) => {
      const numerator = component.quantityBase * args.outputQuantityBase;
      if (numerator % version.outputQuantityBase !== 0n)
        throw new ConvexError(
          "BOM quantity does not convert exactly to the requested output",
        );
      return {
        productId: component.componentProductId,
        quantityBase: numerator / version.outputQuantityBase,
        fromLocationId: component.preferredLocationId ?? order.sourceLocationId,
        fromStockStatus: "available",
        sourceLineId: component._id,
        reasonCode: "production_component_consumption",
      };
    });
    postingLines.push({
      productId: order.productId,
      quantityBase: args.outputQuantityBase,
      toLocationId: order.outputLocationId,
      toStockStatus: outputPolicy?.qualityReleaseRequired
        ? "quality_hold"
        : "available",
      allocations: [
        {
          lotId: outputLotId,
          quantityBase: args.outputQuantityBase,
          userSelected: true,
        },
      ],
      sourceLineId: order._id,
      reasonCode: "production_output",
    });
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash: hashPayload(args),
      commandType: "production.complete",
      movementType: "production_output",
      sourceType: "production_order",
      sourceDocumentId: order._id,
      actorSubject: identity.tokenIdentifier,
      lines: postingLines,
    });
    const movementLines = await ctx.db
      .query("inventoryMovementLines")
      .withIndex("by_organizationId_and_movementId_and_lineNumber", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("movementId", movement.movementId),
      )
      .take(100);
    for (const movementLine of movementLines) {
      if (movementLine.productId === order.productId) continue;
      const allocations = await ctx.db
        .query("inventoryAllocations")
        .withIndex("by_organizationId_and_movementLineId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("movementLineId", movementLine._id),
        )
        .take(50);
      for (const allocation of allocations)
        await ctx.db.insert("lotGenealogyLinks", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          productionOrderId: order._id,
          outputLotId,
          componentLotId: allocation.lotId,
          componentProductId: movementLine.productId,
          quantityBase: allocation.quantityBase,
          movementId: movement.movementId,
          movementLineId: movementLine._id,
        });
    }
    await ctx.db.insert("productionMaterialIssues", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productionOrderId: order._id,
      movementId: movement.movementId,
      issueType: "issue",
      postedBy: identity.tokenIdentifier,
      postedAt: now,
    });
    await ctx.db.insert("productionOutputReceipts", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productionOrderId: order._id,
      outputLotId,
      quantityBase: args.outputQuantityBase,
      movementId: movement.movementId,
      qualityStatus: outputPolicy?.qualityReleaseRequired
        ? "quality_hold"
        : "available",
      postedBy: identity.tokenIdentifier,
      postedAt: now,
    });
    const completedBase = order.completedBase + args.outputQuantityBase;
    await ctx.db.patch(order._id, {
      completedBase,
      status:
        completedBase === order.plannedBase
          ? "completed"
          : "partially_completed",
      updatedAt: now,
    });
    return { movementId: movement.movementId, outputLotId };
  },
});

export const recordScrap = mutation({
  args: {
    productionOrderId: v.id("productionOrders"),
    lotId: v.id("inventoryLots"),
    quantityBase: v.int64(),
    idempotencyKey: v.string(),
    reason: v.string(),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.productionOrderId);
    if (!order || order.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Production order not found");
    const { identity } = await requireLocationCapability(
      ctx,
      "inventory.write",
      order.sourceLocationId,
    );
    await requireLocationCapability(
      ctx,
      "inventory.write",
      order.wipLocationId,
    );
    await requireLocationCapability(
      ctx,
      "inventory.write",
      order.outputLocationId,
    );
    const lot = await ctx.db.get(args.lotId);
    if (!order || !lot || lot.productId !== order.productId)
      throw new ConvexError("Production order or output lot not found");
    if (args.quantityBase <= 0n)
      throw new ConvexError("Scrap quantity must be positive");
    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash: hashPayload(args),
      commandType: "production.recordScrap",
      movementType: "production_scrap",
      sourceType: "production_order",
      sourceDocumentId: order._id,
      actorSubject: identity.tokenIdentifier,
      reasonCode: "production_scrap",
      note: args.reason,
      lines: [
        {
          productId: order.productId,
          quantityBase: args.quantityBase,
          fromLocationId: order.outputLocationId,
          fromStockStatus: "available",
          allocations: [
            {
              lotId: lot._id,
              quantityBase: args.quantityBase,
              userSelected: true,
            },
          ],
          reasonCode: "production_scrap",
        },
      ],
    });
    await ctx.db.patch(order._id, {
      scrappedBase: order.scrappedBase + args.quantityBase,
      updatedAt: Date.now(),
    });
    return movement.movementId;
  },
});

export const list = query({
  args: {
    status: v.optional(productionStatusValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const canRead = await readableLocationIds(ctx);
    const rows = args.status
      ? await ctx.db
          .query("productionOrders")
          .withIndex("by_organizationId_and_status_and_createdAt", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("status", args.status!),
          )
          .order("desc")
          .take(Math.min(args.limit ?? 100, 250))
      : await ctx.db
          .query("productionOrders")
          .order("desc")
          .take(Math.min(args.limit ?? 100, 250));
    const visible = [];
    for (const row of rows)
      if (
        row.organizationId === SUNPRIDE_ORGANIZATION_ID &&
        (await canRead(row.sourceLocationId)) &&
        (await canRead(row.wipLocationId)) &&
        (await canRead(row.outputLocationId))
      )
        visible.push(row);
    return visible;
  },
});
