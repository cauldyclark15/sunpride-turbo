import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

/**
 * Van (rolling truck) POS invariants: route-session state transitions,
 * device ownership, offline command sequencing, idempotent replay, and the
 * stock ledger staying equal to the truck balance through sale/return/void.
 */
type T = TestConvex<typeof schema>;
const OPENING = 40_000n;

async function provisionVan() {
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const admin = t.withIdentity({
    subject: "van-admin",
    email: "jcing.jc@gmail.com",
    name: "Van Admin",
  });
  await admin.mutation(api.domains.profiles.ensure);
  await t.mutation(internal.seed.demo);
  await admin.mutation(api.inventory.setup.foundation);
  await admin.mutation(api.domains.profiles.invite, {
    email: "other-van-seller@example.test",
    role: "sales",
  });
  const other = t.withIdentity({
    subject: "other-van-seller",
    email: "other-van-seller@example.test",
  });
  await other.mutation(api.domains.profiles.ensure);
  const offlineCreatedAt = Date.now() - 60_000;
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
    warehouse: (
      await ctx.db
        .query("inventoryLocations")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride"),
        )
        .take(50)
    ).find((location) => location.type !== "truck"),
  }));
  if (!state.product || !state.truck || !state.warehouse)
    throw new Error("Van inventory not seeded");
  await admin.mutation(api.inventory.setup.postOpeningBalances, {
    idempotencyKey: `van-opening:${state.product._id}`,
    sourceReference: "VAN-CUTOVER-001",
    lines: [
      {
        productId: state.product._id,
        locationId: state.truck._id,
        quantityBase: OPENING,
        lotNumber: `OPEN-${state.product.code}-2026`,
        manufacturedAt: Date.now() - 30 * 86_400_000,
        expiresAt: Date.now() + 335 * 86_400_000,
        unitCostMinor: 10_000n,
      },
    ],
  });
  const product = state.product;
  const truck = state.truck;
  const sale = (
    routeSessionId: Id<"truckRouteSessions">,
    clientRequestId: string,
    deviceSequence: number,
    quantity: number,
    deviceId = "van-device-1",
  ) => ({
    clientRequestId,
    customerCode: "CUS-001",
    truckLocationId: truck._id,
    routeSessionId,
    deviceId,
    deviceSequence,
    offlineCreatedAt,
    lines: [
      {
        productCode: product.code,
        description: product.name,
        quantityBase: BigInt(quantity) * 1_000n,
        quantity,
        unitPrice: product.unitPrice,
      },
    ],
  });
  /** Truck balance plus the independent sums that must reconcile with it. */
  const ledgerState = () =>
    t.run(async (ctx) => {
      const balance = await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", product._id)
            .eq("locationId", truck._id),
        )
        .unique();
      const ledger = (
        await ctx.db.query("inventoryLedgerEntries").collect()
      ).filter(
        (entry) =>
          entry.locationId === truck._id &&
          entry.productId === product._id &&
          entry.stockStatus === "available",
      );
      const lots = await ctx.db
        .query("inventoryLotBalances")
        .withIndex("by_organizationId_and_locationId_and_productId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("locationId", truck._id)
            .eq("productId", product._id),
        )
        .collect();
      return {
        available: balance?.availableStockBase ?? 0n,
        physical: balance?.physicalBase ?? 0n,
        ledgerSum: ledger.reduce((sum, e) => sum + e.quantityDeltaBase, 0n),
        lotPhysicalSum: lots.reduce((sum, lot) => sum + lot.physicalBase, 0n),
        anyNegative:
          lots.some((lot) => lot.physicalBase < 0n || lot.availableBase < 0n) ||
          (balance?.availableBase ?? 0n) < 0n,
        orders: (await ctx.db.query("orders").collect()).length,
        movements: (await ctx.db.query("inventoryMovements").collect()).length,
      };
    });
  return {
    t,
    admin,
    other,
    product,
    truck,
    warehouse: state.warehouse,
    sale,
    ledgerState,
  };
}

async function expectReconciled(
  f: Awaited<ReturnType<typeof provisionVan>>,
  expectedAvailable: bigint,
) {
  const state = await f.ledgerState();
  expect(state.available).toBe(expectedAvailable);
  expect(state.ledgerSum).toBe(state.available);
  expect(state.lotPhysicalSum).toBe(state.physical);
  expect(state.anyNegative).toBe(false);
  return state;
}

describe("van POS route sessions", () => {
  it("allows one open session per truck, reopens idempotently and refuses non-truck stock", async () => {
    const f = await provisionVan();
    const route = await f.admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: f.truck._id,
      deviceId: "van-device-1",
    });
    expect(
      await f.admin.mutation(api.inventory.pos.openRoute, {
        truckLocationId: f.truck._id,
        deviceId: "van-device-1",
      }),
    ).toBe(route);
    await expect(
      f.admin.mutation(api.inventory.pos.openRoute, {
        truckLocationId: f.truck._id,
        deviceId: "van-device-2",
      }),
    ).rejects.toThrow(/already has an active route/);
    const other = f.other;
    await expect(
      other.mutation(api.inventory.pos.openRoute, {
        truckLocationId: f.truck._id,
        deviceId: "van-device-1",
      }),
    ).rejects.toThrow(/already has an active route/);
    await expect(
      f.admin.mutation(api.inventory.pos.openRoute, {
        truckLocationId: f.warehouse._id,
        deviceId: "van-device-1",
      }),
    ).rejects.toThrow(/sellable truck location/);
    expect(
      (
        await f.admin.query(api.inventory.pos.currentRoute, {
          deviceId: "van-device-1",
        })
      )?._id,
    ).toBe(route);
    expect(
      await other.query(api.inventory.pos.currentRoute, {
        deviceId: "van-device-1",
      }),
    ).toBeNull();
  });

  it("moves open → closing → closed only with a posted route-close count and a checkpoint of truck stock", async () => {
    const f = await provisionVan();
    const route = await f.admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: f.truck._id,
      deviceId: "van-device-1",
    });
    await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "close-sale-1", 1, 2),
    );
    const count = (status: "submitted" | "posted", locationId = f.truck._id) =>
      f.t.run((ctx) =>
        ctx.db.insert("stockCountSessions", {
          organizationId: "sunpride",
          countNumber: `RC-${status}-${locationId}`,
          countType: "route_close",
          locationId,
          status,
          blindCount: true,
          snapshotAt: Date.now(),
          createdBy: "fixture",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    const posted = await count("posted");
    await expect(
      f.admin.mutation(api.inventory.pos.finalizeRoute, {
        routeSessionId: route,
        countSessionId: posted,
      }),
    ).rejects.toThrow(/not awaiting final reconciliation/);
    const other = f.other;
    await expect(
      other.mutation(api.inventory.pos.beginCloseRoute, {
        routeSessionId: route,
      }),
    ).rejects.toThrow(/another salesperson/);
    await f.admin.mutation(api.inventory.pos.beginCloseRoute, {
      routeSessionId: route,
    });
    // A closing route accepts no more sales.
    await expect(
      f.admin.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "close-sale-2", 2, 1),
      ),
    ).rejects.toThrow(/not open/);
    await expect(
      f.admin.mutation(api.inventory.pos.beginCloseRoute, {
        routeSessionId: route,
      }),
    ).rejects.toThrow(/not open/);
    for (const wrong of [
      await count("submitted"),
      await count("posted", f.warehouse._id),
    ])
      await expect(
        f.admin.mutation(api.inventory.pos.finalizeRoute, {
          routeSessionId: route,
          countSessionId: wrong,
        }),
      ).rejects.toThrow(/posted route-close count/);
    await expect(
      other.mutation(api.inventory.pos.finalizeRoute, {
        routeSessionId: route,
        countSessionId: posted,
      }),
    ).rejects.toThrow(/another salesperson/);
    const checkpointId = await f.admin.mutation(
      api.inventory.pos.finalizeRoute,
      { routeSessionId: route, countSessionId: posted },
    );
    const state = await f.t.run(async (ctx) => ({
      route: await ctx.db.get(route),
      checkpoint: await ctx.db.get(checkpointId),
      lines: (
        await ctx.db.query("truckInventoryCheckpointLines").collect()
      ).filter((line) => line.checkpointId === checkpointId),
      audit: (await ctx.db.query("auditLogs").collect()).filter(
        (log) => log.action === "inventory.route.closed",
      ),
    }));
    expect(state.route).toMatchObject({ status: "closed" });
    expect(state.route?.leaseExpiresAt).toBeUndefined();
    expect(state.checkpoint).toMatchObject({
      checkpointNumber: 1,
      serverSequence: 1,
    });
    expect(state.lines.reduce((sum, line) => sum + line.quantityBase, 0n)).toBe(
      OPENING - 2_000n,
    );
    expect(state.audit).toHaveLength(1);
    await expect(
      f.admin.mutation(api.inventory.pos.finalizeRoute, {
        routeSessionId: route,
        countSessionId: posted,
      }),
    ).rejects.toThrow(/not awaiting final reconciliation/);
    // The truck can start a fresh session once the previous one closed.
    expect(
      await f.admin.mutation(api.inventory.pos.openRoute, {
        truckLocationId: f.truck._id,
        deviceId: "van-device-2",
      }),
    ).not.toBe(route);
  });
});

describe("van POS offline sales", () => {
  it("enforces contiguous device sequence while replaying an acknowledged sale without double posting", async () => {
    const f = await provisionVan();
    const route = await f.admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: f.truck._id,
      deviceId: "van-device-1",
    });
    // The phone sends its second queued sale first: refused, nothing written.
    await expect(
      f.admin.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "queued-sale-2", 2, 1),
      ),
    ).rejects.toThrow(/expected 1/);
    await expectReconciled(f, OPENING);
    const first = await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "queued-sale-1", 1, 3),
    );
    expect(first).toMatchObject({ duplicate: false, nextDeviceSequence: 2 });
    const afterFirst = await expectReconciled(f, OPENING - 3_000n);
    // Ack lost in transit: the phone retries the same request.
    const replay = await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "queued-sale-1", 1, 3),
    );
    expect(replay).toEqual({ ...first, duplicate: true });
    const afterReplay = await expectReconciled(f, OPENING - 3_000n);
    expect(afterReplay.orders).toBe(afterFirst.orders);
    expect(afterReplay.movements).toBe(afterFirst.movements);
    // Another person replaying the same request ID gets neither the order nor a new one.
    await expect(
      f.other.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "queued-sale-1", 1, 3),
      ),
    ).rejects.toThrow(/belongs to another order/);
    await expectReconciled(f, OPENING - 3_000n);
    // A new request cannot reuse an acknowledged sequence slot.
    await expect(
      f.admin.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "queued-sale-x", 1, 1),
      ),
    ).rejects.toThrow(/expected 2/);
    const second = await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "queued-sale-2", 2, 1),
    );
    expect(second.nextDeviceSequence).toBe(3);
    await expectReconciled(f, OPENING - 4_000n);
    const route0 = await f.t.run((ctx) => ctx.db.get(route));
    expect(route0?.lastAcknowledgedSequence).toBe(2);
  });

  it("refuses another seller, another device, empty and non-positive sales", async () => {
    const f = await provisionVan();
    const route = await f.admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: f.truck._id,
      deviceId: "van-device-1",
    });
    const other = f.other;
    await expect(
      other.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "foreign", 1, 1),
      ),
    ).rejects.toThrow(/another salesperson/);
    await expect(
      f.admin.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "wrong-device", 1, 1, "van-device-9"),
      ),
    ).rejects.toThrow(/not assigned/);
    await expect(
      f.admin.mutation(api.inventory.pos.postSale, {
        ...f.sale(route, "empty", 1, 1),
        lines: [],
      }),
    ).rejects.toThrow(/at least one line/);
    const zero = f.sale(route, "zero", 1, 1);
    await expect(
      f.admin.mutation(api.inventory.pos.postSale, {
        ...zero,
        lines: [{ ...zero.lines[0]!, quantityBase: 0n, quantity: 0 }],
      }),
    ).rejects.toThrow(/must be positive/);
    await expectReconciled(f, OPENING);
    const routeOrders = await f.t.run(async (ctx) =>
      (await ctx.db.query("orders").collect()).filter(
        (order) => order.routeSessionId === route,
      ),
    );
    expect(routeOrders).toEqual([]);
    expect(
      (await f.t.run((ctx) => ctx.db.get(route)))?.lastAcknowledgedSequence,
    ).toBe(0);
  });

  it("never oversells the truck: a sale beyond stock rolls back order, ledger and sequence", async () => {
    const f = await provisionVan();
    const route = await f.admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: f.truck._id,
      deviceId: "van-device-1",
    });
    const before = await expectReconciled(f, OPENING);
    await expect(
      f.admin.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "oversell", 1, Number(OPENING / 1_000n) + 1),
      ),
    ).rejects.toThrow();
    const after = await expectReconciled(f, OPENING);
    expect(after.orders).toBe(before.orders);
    expect(after.movements).toBe(before.movements);
    expect(
      (await f.t.run((ctx) => ctx.db.get(route)))?.lastAcknowledgedSequence,
    ).toBe(0);
    // The whole truck can still be sold exactly to zero, but no further.
    await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "sell-out", 1, Number(OPENING / 1_000n)),
    );
    await expectReconciled(f, 0n);
    await expect(
      f.admin.mutation(
        api.inventory.pos.postSale,
        f.sale(route, "after-sell-out", 2, 1),
      ),
    ).rejects.toThrow();
    await expectReconciled(f, 0n);
  });
});

describe("van POS returns and voids", () => {
  it("caps returns at the sold quantity, replays idempotently and closes the original once fully returned", async () => {
    const f = await provisionVan();
    const route = await f.admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: f.truck._id,
      deviceId: "van-device-1",
    });
    const sale = await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "returnable", 1, 3),
    );
    const ret = (clientRequestId: string, quantity: number) => ({
      originalOrderId: sale.orderId,
      clientRequestId,
      reason: "Damaged on delivery",
      lines: [
        {
          productCode: f.product.code,
          quantityBase: BigInt(quantity) * 1_000n,
          quantity,
        },
      ],
    });
    await expect(
      f.admin.mutation(api.inventory.pos.returnSale, ret("too-many", 4)),
    ).rejects.toThrow(/exceeds the original sold quantity/);
    await expectReconciled(f, OPENING - 3_000n);
    const partial = await f.admin.mutation(
      api.inventory.pos.returnSale,
      ret("return-1", 1),
    );
    expect(
      await f.admin.mutation(api.inventory.pos.returnSale, ret("return-1", 1)),
    ).toEqual({ ...partial, duplicate: true });
    await expect(
      f.admin.mutation(api.inventory.pos.returnSale, ret("return-1", 2)),
    ).rejects.toThrow(/reused with another payload/);
    await expectReconciled(f, OPENING - 2_000n);
    const partialOrder = await f.t.run((ctx) => ctx.db.get(sale.orderId));
    expect(partialOrder?.status).toBe("partially_voided");
    // A partially returned sale is no longer "posted", so it is closed to
    // further returns and voids; the remaining 2 stay sold. The return cap is
    // per request, not cumulative, so relaxing this gate without a cumulative
    // cap would allow returning more than was sold — this guards that.
    await expect(
      f.admin.mutation(api.inventory.pos.returnSale, ret("return-2", 2)),
    ).rejects.toThrow(/unreturned posted POS sale/);
    await expect(
      f.admin.mutation(api.inventory.pos.voidSale, {
        orderId: sale.orderId,
        idempotencyKey: "void-after-return",
        reason: "Not allowed",
      }),
    ).rejects.toThrow(/Only a posted inventory sale/);
    const returnOrder = await f.t.run((ctx) =>
      ctx.db.get(partial.returnOrderId),
    );
    expect(returnOrder).toMatchObject({
      orderType: "pos_return",
      originalOrderId: sale.orderId,
      routeSessionId: route,
    });
    expect(returnOrder?.total).toBeLessThan(0);
  });

  it("marks a full return as returned and a void as voided, each exactly once", async () => {
    const f = await provisionVan();
    const route = await f.admin.mutation(api.inventory.pos.openRoute, {
      truckLocationId: f.truck._id,
      deviceId: "van-device-1",
    });
    const returned = await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "full-return", 1, 2),
    );
    const voided = await f.admin.mutation(
      api.inventory.pos.postSale,
      f.sale(route, "to-void", 2, 5),
    );
    await expectReconciled(f, OPENING - 7_000n);
    await f.admin.mutation(api.inventory.pos.returnSale, {
      originalOrderId: returned.orderId,
      clientRequestId: "full-return-1",
      reason: "Wrong flavour",
      lines: [
        { productCode: f.product.code, quantityBase: 2_000n, quantity: 2 },
      ],
    });
    await f.admin.mutation(api.inventory.pos.voidSale, {
      orderId: voided.orderId,
      idempotencyKey: "void-1",
      reason: "Keyed in error",
    });
    await expectReconciled(f, OPENING);
    await expect(
      f.admin.mutation(api.inventory.pos.voidSale, {
        orderId: voided.orderId,
        idempotencyKey: "void-2",
        reason: "Again",
      }),
    ).rejects.toThrow(/Only a posted inventory sale/);
    await expect(
      f.admin.mutation(api.inventory.pos.returnSale, {
        originalOrderId: voided.orderId,
        clientRequestId: "return-voided",
        reason: "Voided already",
        lines: [
          { productCode: f.product.code, quantityBase: 1_000n, quantity: 1 },
        ],
      }),
    ).rejects.toThrow(/unreturned posted POS sale/);
    const orders = await f.t.run(async (ctx) => ({
      returned: await ctx.db.get(returned.orderId),
      voided: await ctx.db.get(voided.orderId),
    }));
    expect(orders.returned?.status).toBe("returned");
    expect(orders.voided).toMatchObject({ status: "voided" });
    expect(orders.voided?.voidMovementId).toBeDefined();
    await expectReconciled(f, OPENING);
  });
});
