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
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.eventId).toBe("order-1");
  });
});
