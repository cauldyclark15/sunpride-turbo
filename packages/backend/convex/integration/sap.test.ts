import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

describe("SAP integration ingestion", () => {
  it("deduplicates event ids and upserts inventory", async () => {
    const t = convexTest(schema, modules);
    const payload = {
      productCode: "SP-PJ-1L",
      warehouseCode: "WH-MNL",
      onHand: 100,
      reserved: 10,
      available: 90,
      asOf: new Date(0).toISOString(),
    };
    const first = await t.mutation(internal.integration.sap.recordInbound, {
      eventId: "evt-001",
      eventType: "inventory.snapshot",
      payload,
    });
    const duplicate = await t.mutation(internal.integration.sap.recordInbound, {
      eventId: "evt-001",
      eventType: "inventory.snapshot",
      payload,
    });
    expect(first).toEqual({ duplicate: false });
    expect(duplicate).toEqual({ duplicate: true });
    const balances = await t.run(async (ctx) =>
      ctx.db.query("inventoryBalances").collect(),
    );
    expect(balances).toHaveLength(1);
    expect(balances[0]?.available).toBe(90);
  });

  it("returns only pending outbound connector tasks", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("integrationEvents", {
        eventId: "order-1",
        direction: "outbound",
        eventType: "sales-order.submit",
        status: "pending",
        attempts: 0,
        payload: { orderNumber: "SP-1" },
        receivedAt: Date.now(),
      });
    });
    const tasks = await t.query(internal.integration.sap.pendingTasks, {
      limit: 10,
      now: Date.now(),
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.eventId).toBe("order-1");
  });

  it("posts an approved SAP movement through the same inventory ledger", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const uomId = await ctx.db.insert("unitsOfMeasure", {
        organizationId: "sunpride",
        code: "CASE",
        name: "Case",
        dimension: "count",
        decimalPlaces: 3,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      const productId = await ctx.db.insert("products", {
        code: "SAP-PRODUCT-1",
        name: "SAP Product",
        category: "Juice",
        uom: "CASE",
        unitPrice: 100,
        active: true,
        quantityScale: 1_000n,
        updatedAt: now,
      });
      const locationId = await ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        siteCode: "MAIN",
        code: "SAP-WH-1",
        name: "SAP Warehouse",
        type: "warehouse",
        active: true,
        allowsPicking: true,
        allowsReceiving: true,
        allowsSale: false,
        allowsProduction: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("productInventoryPolicies", {
        organizationId: "sunpride",
        productId,
        baseUomId: uomId,
        quantityScale: 1_000n,
        quantityPrecision: 3,
        trackingMode: "lot",
        allocationPolicy: "fefo",
        allowMixedLotsPerLine: true,
        allowNegativeStock: false,
        qualityReleaseRequired: false,
        expiryDateRequired: true,
        manufactureDateRequired: false,
        minimumRemainingShelfLifeDays: 0,
        costingMethod: "weighted_average",
        version: 1,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      return { productId, locationId };
    });
    await t.mutation(internal.integration.sap.recordInbound, {
      eventId: "sap-movement-001",
      eventType: "inventory.movement.approved",
      occurredAt: Date.now(),
      payload: {
        movementType: "goods_receipt",
        documentId: "500000001",
        lines: [
          {
            productCode: "SAP-PRODUCT-1",
            quantityBase: "10000",
            toLocationCode: "SAP-WH-1",
            toStatus: "available",
            lotNumber: "SAP-LOT-1",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            unitCostMinor: "2500",
          },
        ],
      },
    });
    const state = await t.run(async (ctx) => ({
      balance: await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", seeded.productId)
            .eq("locationId", seeded.locationId),
        )
        .unique(),
      movement: await ctx.db.query("inventoryMovements").unique(),
      event: await ctx.db
        .query("integrationEvents")
        .withIndex("by_event_id", (q) => q.eq("eventId", "sap-movement-001"))
        .unique(),
    }));
    expect(state.balance?.availableBase).toBe(10_000n);
    expect(state.balance?.weightedAverageCostMinor).toBe(2_500n);
    expect(state.balance?.inventoryValueMinor).toBe(25_000n);
    expect(state.event?.movementId).toBe(state.movement?._id);
  });
});
