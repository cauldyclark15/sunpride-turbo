import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { postMovement, type PostMovementInput } from "./posting";

async function postTestMovement(
  t: TestConvex<typeof schema>,
  input: PostMovementInput,
) {
  return t.run(async (ctx) => postMovement(ctx, input));
}

function issueInput(
  productId: PostMovementInput["lines"][number]["productId"],
  locationId: PostMovementInput["lines"][number]["fromLocationId"],
  key: string,
  quantityBase = 1_000n,
  overrides: Partial<PostMovementInput> = {},
): PostMovementInput {
  return {
    idempotencyKey: key,
    payloadHash: key,
    commandType: "test.issue",
    movementType: "inventory_issue",
    sourceType: "test",
    actorSubject: "inventory-admin",
    lines: [{ productId, fromLocationId: locationId, quantityBase }],
    ...overrides,
  };
}

async function provisionInventory() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const admin = t.withIdentity({
    subject: "inventory-admin",
    email: "jcing.jc@gmail.com",
    name: "Inventory Admin",
  });
  await admin.mutation(api.domains.profiles.ensure);
  await admin.mutation(api.seed.demo);
  await admin.mutation(api.inventory.setup.foundation);
  const state = await t.run(async (ctx) => ({
    product: await ctx.db
      .query("products")
      .withIndex("by_code", (q) => q.eq("code", "SP-PJ-1L"))
      .unique(),
    truck: await ctx.db
      .query("inventoryLocations")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", "sunpride").eq("code", "TRUCK-001"),
      )
      .unique(),
  }));
  if (!state.product || !state.truck)
    throw new Error("Test inventory not seeded");
  await admin.mutation(api.inventory.setup.postOpeningBalances, {
    idempotencyKey: `test-opening:${state.product._id}`,
    sourceReference: "TEST-CUTOVER-001",
    lines: [
      {
        productId: state.product._id,
        locationId: state.truck._id,
        quantityBase: 40_000n,
        lotNumber: `OPEN-${state.product.code}-2026`,
        manufacturedAt: Date.now() - 30 * 86_400_000,
        expiresAt: Date.now() + 335 * 86_400_000,
        unitCostMinor: 10_000n,
      },
    ],
  });
  return { t, admin, product: state.product, truck: state.truck };
}

async function stockedState(
  t: TestConvex<typeof schema>,
  productId: PostMovementInput["lines"][number]["productId"],
  locationId: NonNullable<PostMovementInput["lines"][number]["fromLocationId"]>,
) {
  return t.run(async (ctx) => ({
    balance: await ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
        q
          .eq("organizationId", "sunpride")
          .eq("productId", productId)
          .eq("locationId", locationId),
      )
      .unique(),
    allocations: await ctx.db.query("inventoryAllocations").collect(),
    ledger: await ctx.db.query("inventoryLedgerEntries").collect(),
    movements: await ctx.db.query("inventoryMovements").collect(),
    commands: await ctx.db.query("inventoryCommands").collect(),
  }));
}

async function expireOpeningLot(
  t: TestConvex<typeof schema>,
  productId: PostMovementInput["lines"][number]["productId"],
) {
  return t.run(async (ctx) => {
    const lot = await ctx.db
      .query("inventoryLots")
      .withIndex(
        "by_organizationId_and_productId_and_normalizedLotNumber",
        (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", productId)
            .eq("normalizedLotNumber", "OPEN-SP-PJ-1L-2026"),
      )
      .unique();
    if (!lot) throw new Error("Opening lot missing");
    const expiresAt = Date.now() - 1_000;
    await ctx.db.patch(lot._id, { expiresAt });
    const balances = await ctx.db
      .query("inventoryLotBalances")
      .withIndex("by_organizationId_and_lotId", (q) =>
        q.eq("organizationId", "sunpride").eq("lotId", lot._id),
      )
      .collect();
    for (const balance of balances)
      await ctx.db.patch(balance._id, { expirySortKey: expiresAt });
    return lot._id;
  });
}

async function receiveLaterLot(
  admin: Awaited<ReturnType<typeof provisionInventory>>["admin"],
  productId: PostMovementInput["lines"][number]["productId"],
  locationId: NonNullable<PostMovementInput["lines"][number]["fromLocationId"]>,
  key: string,
  daysRemaining: number,
) {
  return admin.mutation(api.inventory.receipts.post, {
    idempotencyKey: key,
    receiptType: "unplanned",
    receivingLocationId: locationId,
    lines: [
      {
        productId,
        quantityBase: 5_000n,
        lotNumber: key,
        manufacturedAt: Date.now() - 30 * 86_400_000,
        expiresAt: Date.now() + daysRemaining * 86_400_000,
        unitCostMinor: 10_000n,
      },
    ],
  });
}

describe("operational inventory posting", () => {
  it("posts an idempotent FEFO truck sale and reverses the exact movement", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    const before = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
    );
    const request = {
      clientRequestId: "truck-device-sale-001",
      customerCode: "CUS-001",
      truckLocationId: truck._id,
      deviceId: "device-001",
      deviceSequence: 1,
      offlineCreatedAt: Date.now() - 1_000,
      lines: [
        {
          productCode: product.code,
          description: product.name,
          quantityBase: 2_000n,
          quantity: 2,
          unitPrice: product.unitPrice,
        },
      ],
    };
    const routeSessionId = await admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: truck._id,
      deviceId: request.deviceId,
    });
    const routedRequest = { ...request, routeSessionId };
    const posted = await admin.mutation(
      api.inventory.pos.postSale,
      routedRequest,
    );
    const duplicate = await admin.mutation(
      api.inventory.pos.postSale,
      routedRequest,
    );
    expect(duplicate).toMatchObject({
      orderId: posted.orderId,
      movementId: posted.movementId,
      duplicate: true,
    });
    const afterSale = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
    );
    expect(afterSale?.availableBase).toBe(
      (before?.availableBase ?? 0n) - 2_000n,
    );

    await admin.mutation(api.inventory.pos.voidSale, {
      orderId: posted.orderId,
      idempotencyKey: "truck-device-sale-001:void",
      reason: "Customer cancelled before delivery",
    });
    const afterVoid = await t.run(async (ctx) => ({
      balance: await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
      movements: await ctx.db.query("inventoryMovements").collect(),
      allocations: await ctx.db.query("inventoryAllocations").collect(),
    }));
    expect(afterVoid.balance?.availableBase).toBe(before?.availableBase);
    expect(
      afterVoid.movements.find((movement) => movement._id === posted.movementId)
        ?.status,
    ).toBe("reversed");
    expect(
      afterVoid.allocations.some(
        (allocation) => allocation.reversesAllocationId,
      ),
    ).toBe(true);
  });

  it("rejects a reused idempotency key with a different payload", async () => {
    const { admin, product, truck } = await provisionInventory();
    const base = {
      clientRequestId: "collision-001",
      customerCode: "CUS-001",
      truckLocationId: truck._id,
      deviceId: "device-001",
      deviceSequence: 1,
      lines: [
        {
          productCode: product.code,
          description: product.name,
          quantityBase: 1_000n,
          quantity: 1,
          unitPrice: product.unitPrice,
        },
      ],
    };
    const routeSessionId = await admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: truck._id,
      deviceId: base.deviceId,
    });
    const routedBase = { ...base, routeSessionId };
    await admin.mutation(api.inventory.pos.postSale, routedBase);
    await expect(
      admin.mutation(api.inventory.pos.postSale, {
        ...routedBase,
        lines: [{ ...routedBase.lines[0]!, quantityBase: 2_000n, quantity: 2 }],
      }),
    ).rejects.toThrow("another sale payload");
  });

  it("returns a partial sale to the exact original lot", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    const routeSessionId = await admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: truck._id,
      deviceId: "return-device",
    });
    const sale = await admin.mutation(api.inventory.pos.postSale, {
      clientRequestId: "return-source-sale",
      customerCode: "CUS-001",
      truckLocationId: truck._id,
      routeSessionId,
      deviceId: "return-device",
      deviceSequence: 1,
      lines: [
        {
          productCode: product.code,
          description: product.name,
          quantityBase: 3_000n,
          quantity: 3,
          unitPrice: product.unitPrice,
        },
      ],
    });
    const beforeReturn = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
    );
    const returned = await admin.mutation(api.inventory.pos.returnSale, {
      originalOrderId: sale.orderId,
      clientRequestId: "return-001",
      reason: "One unopened case returned",
      lines: [{ productCode: product.code, quantityBase: 1_000n, quantity: 1 }],
    });
    const state = await t.run(async (ctx) => ({
      original: await ctx.db.get(sale.orderId),
      balance: await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
      allocations: (
        await ctx.db.query("inventoryAllocations").collect()
      ).filter((allocation) => allocation.movementId === returned.movementId),
    }));
    expect(state.original?.status).toBe("partially_voided");
    expect(state.balance?.availableBase).toBe(
      (beforeReturn?.availableBase ?? 0n) + 1_000n,
    );
    expect(
      state.allocations.every((allocation) => allocation.reversesAllocationId),
    ).toBe(true);
  });

  it("moves hard reservations through ATP and physical consumption", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    const before = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
    );
    const reservationId = await admin.mutation(
      api.inventory.reservations.create,
      {
        idempotencyKey: "reservation-001",
        reservationType: "sales_order",
        sourceType: "sales_order",
        sourceDocumentId: "SO-001",
        lines: [
          {
            productId: product._id,
            locationId: truck._id,
            quantityBase: 2_000n,
          },
        ],
      },
    );
    const reserved = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
    );
    expect(reserved?.physicalBase).toBe(before?.physicalBase);
    expect(reserved?.reservedBase).toBe((before?.reservedBase ?? 0n) + 2_000n);
    expect(reserved?.availableBase).toBe(
      (before?.availableBase ?? 0n) - 2_000n,
    );

    await admin.mutation(api.inventory.reservations.consume, {
      reservationId,
      idempotencyKey: "reservation-001:consume",
    });
    const consumed = await t.run(async (ctx) => ({
      balance: await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique(),
      reservation: await ctx.db.get(reservationId),
    }));
    expect(consumed.balance?.physicalBase).toBe(
      (before?.physicalBase ?? 0n) - 2_000n,
    );
    expect(consumed.balance?.reservedBase).toBe(before?.reservedBase);
    expect(consumed.balance?.availableBase).toBe(
      (before?.availableBase ?? 0n) - 2_000n,
    );
    expect(consumed.reservation?.status).toBe("consumed");
  });

  it("rejects negative available stock for a non-lot policy even with allowNegativeStock", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    await t.run(async (ctx) => {
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", product._id),
        )
        .unique();
      if (!policy) throw new Error("Policy missing");
      await ctx.db.patch(policy._id, {
        trackingMode: "none",
        allowNegativeStock: true,
      });
    });
    await admin.mutation(api.inventory.reservations.create, {
      idempotencyKey: "nonlot-reserve",
      reservationType: "sales_order",
      sourceType: "sales_order",
      sourceDocumentId: "SO-NONLOT",
      lines: [
        {
          productId: product._id,
          locationId: truck._id,
          quantityBase: 39_000n,
        },
      ],
    });
    const before = await stockedState(t, product._id, truck._id);
    expect(before.balance?.availableBase).toBe(1_000n);
    await expect(
      postTestMovement(
        t,
        issueInput(product._id, truck._id, "nonlot-oversell", 2_000n),
      ),
    ).rejects.toThrow("Insufficient available stock");
    const after = await stockedState(t, product._id, truck._id);
    expect(after.balance).toEqual(before.balance);
    expect(after.movements).toEqual(before.movements);
    expect(after.commands).toEqual(before.commands);
  });

  it("FEFO skips an expired earliest lot and allocates the later eligible lot", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    const expiredLotId = await expireOpeningLot(t, product._id);
    await receiveLaterLot(admin, product._id, truck._id, "FEFO-LATER", 60);
    const before = await stockedState(t, product._id, truck._id);
    const posted = await postTestMovement(
      t,
      issueInput(product._id, truck._id, "fefo-eligible"),
    );
    const after = await stockedState(t, product._id, truck._id);
    const selected = after.allocations.filter(
      (allocation) => allocation.movementId === posted.movementId,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.lotId).not.toBe(expiredLotId);
    expect(selected[0]?.quantityBase).toBe(1_000n);
    expect(after.balance?.availableBase).toBe(
      (before.balance?.availableBase ?? 0n) - 1_000n,
    );
  });

  it("all expired FEFO lots fail atomically without changing balances or ledger", async () => {
    const { t, product, truck } = await provisionInventory();
    await expireOpeningLot(t, product._id);
    const before = await stockedState(t, product._id, truck._id);
    await expect(
      postTestMovement(t, issueInput(product._id, truck._id, "all-expired")),
    ).rejects.toThrow("Insufficient eligible lot stock");
    const after = await stockedState(t, product._id, truck._id);
    expect(after).toEqual(before);
  });

  it("insufficient eligible FEFO quantity rolls back all partial allocations", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    await expireOpeningLot(t, product._id);
    await receiveLaterLot(
      admin,
      product._id,
      truck._id,
      "PARTIAL-ELIGIBLE",
      60,
    );
    const before = await stockedState(t, product._id, truck._id);
    await expect(
      postTestMovement(
        t,
        issueInput(product._id, truck._id, "fefo-partial-shortfall", 6_000n),
      ),
    ).rejects.toThrow("Insufficient eligible lot stock");
    expect(await stockedState(t, product._id, truck._id)).toEqual(before);
  });

  it("FEFO skips lots below minimum remaining shelf life", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    const shortLotId = await expireOpeningLot(t, product._id);
    await t.run(async (ctx) => {
      const expiresAt = Date.now() + 2 * 86_400_000;
      await ctx.db.patch(shortLotId, { expiresAt });
      const balances = await ctx.db
        .query("inventoryLotBalances")
        .withIndex("by_organizationId_and_lotId", (q) =>
          q.eq("organizationId", "sunpride").eq("lotId", shortLotId),
        )
        .collect();
      for (const balance of balances)
        await ctx.db.patch(balance._id, { expirySortKey: expiresAt });
    });
    await receiveLaterLot(admin, product._id, truck._id, "LONG-SHELF-LIFE", 60);
    const posted = await postTestMovement(
      t,
      issueInput(product._id, truck._id, "skip-short-life"),
    );
    const after = await stockedState(t, product._id, truck._id);
    const selected = after.allocations.filter(
      (allocation) => allocation.movementId === posted.movementId,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.lotId).not.toBe(shortLotId);
  });

  it("respects reserved available stock at the FEFO allocation boundary", async () => {
    const { t, admin, product, truck } = await provisionInventory();
    await admin.mutation(api.inventory.reservations.create, {
      idempotencyKey: "fefo-boundary-reservation",
      reservationType: "sales_order",
      sourceType: "sales_order",
      sourceDocumentId: "SO-FEFO-BOUNDARY",
      lines: [
        {
          productId: product._id,
          locationId: truck._id,
          quantityBase: 39_000n,
        },
      ],
    });
    const before = await stockedState(t, product._id, truck._id);
    expect(before.balance?.availableBase).toBe(1_000n);
    await expect(
      postTestMovement(
        t,
        issueInput(product._id, truck._id, "fefo-reserved-oversell", 2_000n),
      ),
    ).rejects.toThrow("Insufficient available stock");
    expect(await stockedState(t, product._id, truck._id)).toEqual(before);
    const posted = await postTestMovement(
      t,
      issueInput(product._id, truck._id, "fefo-reserved-boundary"),
    );
    const after = await stockedState(t, product._id, truck._id);
    expect(after.balance?.availableBase).toBe(0n);
    expect(
      after.allocations.filter(
        (allocation) => allocation.movementId === posted.movementId,
      ),
    ).toHaveLength(1);
  });

  it("rejects an explicitly expired sale lot but permits an adjustment disposition", async () => {
    const { t, product, truck } = await provisionInventory();
    const lotId = await expireOpeningLot(t, product._id);
    const line = {
      productId: product._id,
      fromLocationId: truck._id,
      quantityBase: 1_000n,
      allocations: [{ lotId, quantityBase: 1_000n }],
    };
    const before = await stockedState(t, product._id, truck._id);
    await expect(
      postTestMovement(
        t,
        issueInput(product._id, truck._id, "expired-explicit-sale", 1_000n, {
          movementType: "pos_sale",
          lines: [line],
        }),
      ),
    ).rejects.toThrow("Cannot select an expired lot for sale or issue");
    expect(await stockedState(t, product._id, truck._id)).toEqual(before);
    const disposition = await postTestMovement(
      t,
      issueInput(product._id, truck._id, "expired-adjustment", 1_000n, {
        movementType: "inventory_adjustment",
        lines: [line],
      }),
    );
    expect(disposition.duplicate).toBe(false);
    expect(
      (await stockedState(t, product._id, truck._id)).balance?.availableBase,
    ).toBe(39_000n);
  });
});
