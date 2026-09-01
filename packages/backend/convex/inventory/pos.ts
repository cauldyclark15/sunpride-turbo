import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireIdentity, requireRole } from "../lib/auth";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";
import {
  findExistingCommand,
  hashPayload,
  postMovement,
  reverseMovement,
  type PostingLine,
} from "./posting";

const saleLine = v.object({
  productCode: v.string(),
  description: v.string(),
  quantityBase: v.int64(),
  quantity: v.number(),
  unitPrice: v.number(),
  allocations: v.optional(
    v.array(
      v.object({
        lotId: v.id("inventoryLots"),
        quantityBase: v.int64(),
      }),
    ),
  ),
});

export const postSale = mutation({
  args: {
    clientRequestId: v.string(),
    customerCode: v.string(),
    truckLocationId: v.id("inventoryLocations"),
    routeSessionId: v.id("truckRouteSessions"),
    deviceId: v.string(),
    deviceSequence: v.number(),
    offlineCreatedAt: v.optional(v.number()),
    lines: v.array(saleLine),
  },
  returns: v.object({
    orderId: v.id("orders"),
    movementId: v.id("inventoryMovements"),
    duplicate: v.boolean(),
    nextDeviceSequence: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    if (args.lines.length === 0)
      throw new ConvexError("Sale needs at least one line");
    const payloadHash = hashPayload(args);
    const duplicateOrder = await ctx.db
      .query("orders")
      .withIndex("by_client_request", (q) =>
        q.eq("clientRequestId", args.clientRequestId),
      )
      .unique();
    if (duplicateOrder) {
      if (
        duplicateOrder.requestPayloadHash &&
        duplicateOrder.requestPayloadHash !== payloadHash
      )
        throw new ConvexError(
          "Client request ID was reused with another sale payload",
        );
      if (!duplicateOrder.inventoryMovementId)
        throw new ConvexError(
          "Existing sale is missing its inventory movement",
        );
      return {
        orderId: duplicateOrder._id,
        movementId: duplicateOrder.inventoryMovementId,
        duplicate: true,
        nextDeviceSequence:
          (duplicateOrder.deviceSequence ?? args.deviceSequence) + 1,
      };
    }
    const route = await ctx.db.get(args.routeSessionId);
    if (
      !route ||
      route.status !== "open" ||
      route.truckLocationId !== args.truckLocationId
    )
      throw new ConvexError("Route session is not open for this truck");
    if (route.salespersonSubject !== identity.tokenIdentifier)
      throw new ConvexError("Route session belongs to another salesperson");
    if (route.assignedDeviceId !== args.deviceId)
      throw new ConvexError("Device is not assigned to this route session");
    const expected = route.lastAcknowledgedSequence + 1;
    if (args.deviceSequence !== expected)
      throw new ConvexError(
        `Device command sequence conflict; expected ${expected}`,
      );
    const commandKey = `pos-sale:${args.clientRequestId}`;
    await findExistingCommand(ctx, commandKey, payloadHash);
    const total = args.lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPrice,
      0,
    );
    const now = Date.now();
    const orderId = await ctx.db.insert("orders", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      clientRequestId: args.clientRequestId,
      orderNumber: `POS-${now.toString(36).toUpperCase()}`,
      orderType: "rolling_truck_sale",
      customerCode: args.customerCode,
      salespersonSubject: identity.tokenIdentifier,
      status: "posted",
      subtotal: total,
      total,
      offlineCreatedAt: args.offlineCreatedAt,
      sourceLocationId: args.truckLocationId,
      routeSessionId: args.routeSessionId,
      deviceId: args.deviceId,
      requestPayloadHash: payloadHash,
      deviceSequence: args.deviceSequence,
      createdAt: now,
      updatedAt: now,
    });
    const postingLines: PostingLine[] = [];
    for (const line of args.lines) {
      if (line.quantityBase <= 0n || line.quantity <= 0)
        throw new ConvexError("Sale quantity must be positive");
      const product = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", line.productCode))
        .unique();
      if (!product)
        throw new ConvexError(`Product ${line.productCode} not found`);
      const orderLineId = await ctx.db.insert("orderLines", {
        orderId,
        productCode: line.productCode,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.quantity * line.unitPrice,
      });
      postingLines.push({
        productId: product._id,
        quantityBase: line.quantityBase,
        fromLocationId: args.truckLocationId,
        fromStockStatus: "available",
        allocations: line.allocations?.map((allocation) => ({
          ...allocation,
          userSelected: true,
        })),
        sourceLineId: orderLineId,
        reasonCode: "rolling_truck_pos_sale",
      });
    }
    const movement = await postMovement(ctx, {
      idempotencyKey: commandKey,
      payloadHash,
      commandType: "pos.postSale",
      movementType: "pos_sale",
      sourceType: "pos_order",
      sourceDocumentId: orderId,
      actorSubject: identity.tokenIdentifier,
      deviceId: args.deviceId,
      effectiveAt: args.offlineCreatedAt,
      lines: postingLines,
    });
    await ctx.db.patch(orderId, {
      inventoryMovementId: movement.movementId,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(args.routeSessionId, {
      lastAcknowledgedSequence: args.deviceSequence,
      leaseExpiresAt: Date.now() + 15 * 60_000,
      updatedAt: Date.now(),
    });
    return {
      orderId,
      movementId: movement.movementId,
      duplicate: false,
      nextDeviceSequence: args.deviceSequence + 1,
    };
  },
});

export const voidSale = mutation({
  args: {
    orderId: v.id("orders"),
    idempotencyKey: v.string(),
    reason: v.string(),
  },
  returns: v.id("inventoryMovements"),
  handler: async (ctx, args) => {
    const { identity } = await requireRole(ctx, [
      "admin",
      "manager",
      "approver",
    ]);
    const order = await ctx.db.get(args.orderId);
    if (!order || !order.inventoryMovementId || order.status !== "posted")
      throw new ConvexError("Only a posted inventory sale can be voided");
    const movement = await reverseMovement(ctx, {
      originalMovementId: order.inventoryMovementId,
      idempotencyKey: args.idempotencyKey,
      actorSubject: identity.tokenIdentifier,
      sourceType: "pos_void",
      sourceDocumentId: order._id,
      note: args.reason,
    });
    await ctx.db.patch(order._id, {
      status: "voided",
      voidMovementId: movement.movementId,
      voidedAt: Date.now(),
      voidedBy: identity.tokenIdentifier,
      updatedAt: Date.now(),
    });
    return movement.movementId;
  },
});

export const returnSale = mutation({
  args: {
    originalOrderId: v.id("orders"),
    clientRequestId: v.string(),
    reason: v.string(),
    lines: v.array(
      v.object({
        productCode: v.string(),
        quantityBase: v.int64(),
        quantity: v.number(),
      }),
    ),
  },
  returns: v.object({
    returnOrderId: v.id("orders"),
    movementId: v.id("inventoryMovements"),
    duplicate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireRole(ctx, [
      "sales",
      "admin",
      "manager",
      "approver",
    ]);
    const payloadHash = hashPayload(args);
    const duplicate = await ctx.db
      .query("orders")
      .withIndex("by_client_request", (q) =>
        q.eq("clientRequestId", args.clientRequestId),
      )
      .unique();
    if (duplicate) {
      if (duplicate.requestPayloadHash !== payloadHash)
        throw new ConvexError(
          "Return request ID was reused with another payload",
        );
      if (!duplicate.inventoryMovementId)
        throw new ConvexError("Existing return is missing its movement");
      return {
        returnOrderId: duplicate._id,
        movementId: duplicate.inventoryMovementId,
        duplicate: true,
      };
    }
    const original = await ctx.db.get(args.originalOrderId);
    if (
      !original ||
      !original.inventoryMovementId ||
      !original.sourceLocationId ||
      original.status !== "posted"
    )
      throw new ConvexError(
        "Only an unreturned posted POS sale can be returned",
      );
    if (
      profile.role === "sales" &&
      original.salespersonSubject !== identity.tokenIdentifier
    )
      throw new ConvexError("Salespeople can only return their own sale");
    if (args.lines.length === 0)
      throw new ConvexError("Return needs at least one line");
    const originalMovementLines = await ctx.db
      .query("inventoryMovementLines")
      .withIndex("by_organizationId_and_movementId_and_lineNumber", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("movementId", original.inventoryMovementId!),
      )
      .take(100);
    const originalOrderLines = await ctx.db
      .query("orderLines")
      .withIndex("by_order", (q) => q.eq("orderId", original._id))
      .take(100);
    const postingLines: PostingLine[] = [];
    let returnTotal = 0;
    let returnedBase = 0n;
    for (const input of args.lines) {
      if (input.quantityBase <= 0n || input.quantity <= 0)
        throw new ConvexError("Return quantity must be positive");
      const product = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", input.productCode))
        .unique();
      if (!product) throw new ConvexError("Return product not found");
      const originalLine = originalMovementLines.find(
        (line) => line.productId === product._id,
      );
      if (!originalLine || input.quantityBase > originalLine.quantityBase)
        throw new ConvexError("Return exceeds the original sold quantity");
      const originalAllocations = await ctx.db
        .query("inventoryAllocations")
        .withIndex("by_organizationId_and_movementLineId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("movementLineId", originalLine._id),
        )
        .take(50);
      let remaining = input.quantityBase;
      const allocations = [];
      for (const allocation of originalAllocations) {
        if (remaining <= 0n) break;
        const quantityBase =
          allocation.quantityBase < remaining
            ? allocation.quantityBase
            : remaining;
        allocations.push({
          lotId: allocation.lotId,
          quantityBase,
          userSelected: true,
          reversesAllocationId: allocation._id,
        });
        remaining -= quantityBase;
      }
      if (originalAllocations.length > 0 && remaining > 0n)
        throw new ConvexError("Original lot evidence is incomplete");
      const commercialLine = originalOrderLines.find(
        (line) => line.productCode === input.productCode,
      );
      const unitPrice = commercialLine?.unitPrice ?? 0;
      returnTotal += input.quantity * unitPrice;
      returnedBase += input.quantityBase;
      postingLines.push({
        productId: product._id,
        quantityBase: input.quantityBase,
        toLocationId: original.sourceLocationId,
        toStockStatus: "available",
        allocations: allocations.length > 0 ? allocations : undefined,
        sourceLineId: originalLine._id,
        unitCostMinor: originalLine.unitCostMinor,
        reasonCode: "customer_return",
      });
    }
    const now = Date.now();
    const returnOrderId = await ctx.db.insert("orders", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      clientRequestId: args.clientRequestId,
      orderNumber: `RET-${now.toString(36).toUpperCase()}`,
      orderType: "pos_return",
      customerCode: original.customerCode,
      salespersonSubject: identity.tokenIdentifier,
      status: "posted",
      subtotal: -returnTotal,
      total: -returnTotal,
      sourceLocationId: original.sourceLocationId,
      ...(original.routeSessionId
        ? { routeSessionId: original.routeSessionId }
        : {}),
      originalOrderId: original._id,
      requestPayloadHash: payloadHash,
      createdAt: now,
      updatedAt: now,
    });
    for (const input of args.lines) {
      const commercialLine = originalOrderLines.find(
        (line) => line.productCode === input.productCode,
      );
      const unitPrice = commercialLine?.unitPrice ?? 0;
      await ctx.db.insert("orderLines", {
        orderId: returnOrderId,
        productCode: input.productCode,
        description: commercialLine?.description ?? input.productCode,
        quantity: -input.quantity,
        unitPrice,
        lineTotal: -input.quantity * unitPrice,
      });
    }
    const movement = await postMovement(ctx, {
      idempotencyKey: `pos-return:${args.clientRequestId}`,
      payloadHash,
      commandType: "pos.returnSale",
      movementType: "pos_return",
      sourceType: "pos_return",
      sourceDocumentId: returnOrderId,
      actorSubject: identity.tokenIdentifier,
      note: args.reason,
      lines: postingLines,
    });
    await ctx.db.patch(returnOrderId, {
      inventoryMovementId: movement.movementId,
      updatedAt: Date.now(),
    });
    const originalTotalBase = originalMovementLines.reduce(
      (sum, line) => sum + line.quantityBase,
      0n,
    );
    await ctx.db.patch(original._id, {
      status:
        returnedBase === originalTotalBase ? "returned" : "partially_voided",
      updatedAt: Date.now(),
    });
    return {
      returnOrderId,
      movementId: movement.movementId,
      duplicate: false,
    };
  },
});

export const currentRoute = query({
  args: { deviceId: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const routes = await ctx.db
      .query("truckRouteSessions")
      .withIndex("by_organizationId_and_salespersonSubject_and_status", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("salespersonSubject", identity.tokenIdentifier)
          .eq("status", "open"),
      )
      .take(5);
    return (
      routes.find((route) => route.assignedDeviceId === args.deviceId) ?? null
    );
  },
});

export const openRoute = mutation({
  args: {
    truckLocationId: v.id("inventoryLocations"),
    deviceId: v.string(),
    routeCode: v.optional(v.string()),
  },
  returns: v.id("truckRouteSessions"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const location = await ctx.db.get(args.truckLocationId);
    if (!location || location.type !== "truck" || !location.allowsSale)
      throw new ConvexError("A sellable truck location is required");
    const existing = await ctx.db
      .query("truckRouteSessions")
      .withIndex("by_organizationId_and_truckLocationId_and_status", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("truckLocationId", args.truckLocationId)
          .eq("status", "open"),
      )
      .unique();
    if (existing) {
      if (
        existing.salespersonSubject === identity.tokenIdentifier &&
        existing.assignedDeviceId === args.deviceId
      )
        return existing._id;
      throw new ConvexError("Truck already has an active route session");
    }
    const now = Date.now();
    return ctx.db.insert("truckRouteSessions", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      routeCode: args.routeCode ?? `ROUTE-${now.toString(36).toUpperCase()}`,
      truckLocationId: args.truckLocationId,
      salespersonSubject: identity.tokenIdentifier,
      assignedDeviceId: args.deviceId,
      status: "open",
      openedAt: now,
      lastAcknowledgedSequence: 0,
      leaseExpiresAt: now + 15 * 60_000,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const beginCloseRoute = mutation({
  args: { routeSessionId: v.id("truckRouteSessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const route = await ctx.db.get(args.routeSessionId);
    if (!route || route.status !== "open")
      throw new ConvexError("Route is not open");
    if (route.salespersonSubject !== identity.tokenIdentifier)
      throw new ConvexError("Route belongs to another salesperson");
    await ctx.db.patch(route._id, {
      status: "closing",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const finalizeRoute = mutation({
  args: {
    routeSessionId: v.id("truckRouteSessions"),
    countSessionId: v.id("stockCountSessions"),
  },
  returns: v.id("truckInventoryCheckpoints"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const [route, count] = await Promise.all([
      ctx.db.get(args.routeSessionId),
      ctx.db.get(args.countSessionId),
    ]);
    if (!route || route.status !== "closing")
      throw new ConvexError("Route is not awaiting final reconciliation");
    if (route.salespersonSubject !== identity.tokenIdentifier)
      throw new ConvexError("Route belongs to another salesperson");
    if (
      !count ||
      count.status !== "posted" ||
      count.locationId !== route.truckLocationId
    )
      throw new ConvexError("A posted route-close count is required");
    const balances = await ctx.db
      .query("inventoryLotBalances")
      .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("locationId", route.truckLocationId),
      )
      .take(500);
    const previous = await ctx.db
      .query("truckInventoryCheckpoints")
      .withIndex(
        "by_organizationId_and_routeSessionId_and_checkpointNumber",
        (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("routeSessionId", route._id),
      )
      .order("desc")
      .take(1);
    const checkpointNumber = (previous[0]?.checkpointNumber ?? 0) + 1;
    const now = Date.now();
    const checkpointId = await ctx.db.insert("truckInventoryCheckpoints", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      routeSessionId: route._id,
      checkpointNumber,
      serverSequence: route.lastAcknowledgedSequence,
      checksum: hashPayload(
        balances.map((balance) => ({
          productId: balance.productId,
          lotId: balance.lotId,
          quantityBase: balance.physicalBase,
          version: balance.version,
        })),
      ),
      createdAt: now,
    });
    for (const balance of balances)
      await ctx.db.insert("truckInventoryCheckpointLines", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        checkpointId,
        productId: balance.productId,
        lotId: balance.lotId,
        quantityBase: balance.physicalBase,
        balanceVersion: balance.version,
      });
    await ctx.db.patch(route._id, {
      status: "closed",
      closedAt: now,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "inventory.route.closed",
      entityType: "truckRouteSession",
      entityId: route._id,
      details: checkpointId,
      createdAt: now,
    });
    return checkpointId;
  },
});
