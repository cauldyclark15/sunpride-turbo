import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

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
});
