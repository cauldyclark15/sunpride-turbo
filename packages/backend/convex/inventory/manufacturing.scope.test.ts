import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const rootUnit = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const root = t.withIdentity({
    subject: "root",
    email: "jcing.jc@gmail.com",
    name: "Root",
  });
  await root.mutation(api.domains.profiles.ensure, {});
  await root.mutation(internal.seed.demo, {});
  await root.mutation(api.inventory.setup.foundation, {});
  const [aUnit, bUnit] = await t.run(async (ctx) => {
    const add = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "AREA",
        parentId: rootUnit.rootUnitId,
        status: "active" as const,
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    return [await add("SCOPE-A"), await add("SCOPE-B")] as const;
  });
  const state = await t.run(async (ctx) => {
    const product = await ctx.db.query("products").take(1);
    const locations = await ctx.db.query("inventoryLocations").take(3);
    const uoms = await ctx.db.query("unitsOfMeasure").take(2);
    return {
      product: product[0],
      a: locations[0],
      b: locations[1],
      wip: locations[2],
      uom: uoms[0],
      otherUom: uoms[1],
    };
  });
  if (
    !state.product ||
    !state.a ||
    !state.b ||
    !state.wip ||
    !state.uom ||
    !state.otherUom
  )
    throw new Error("Missing inventory fixture");
  await t.run(async (ctx) => {
    await ctx.db.patch(state.a!._id, { orgUnitId: aUnit });
    await ctx.db.patch(state.b!._id, { orgUnitId: bUnit });
    await ctx.db.patch(state.wip!._id, { orgUnitId: aUnit });
  });
  async function actor(
    email: string,
    role: "admin" | "operations" | "approver" | "viewer" | "sales",
    unit = aUnit,
  ) {
    await root.mutation(api.domains.profiles.invite, {
      email,
      name: email,
      role,
    });
    const who = t.withIdentity({ subject: email, email, name: email });
    await who.mutation(api.domains.profiles.ensure, {});
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (!profile) throw new Error("Missing profile");
      await ctx.db.patch(profile._id, { orgUnitId: unit });
    });
    return who;
  }
  return {
    t,
    root,
    rootUnit: rootUnit.rootUnitId,
    aUnit,
    bUnit,
    product: state.product!,
    a: state.a!,
    b: state.b!,
    wip: state.wip!,
    uom: state.uom!,
    otherUom: state.otherUom!,
    actor,
  };
}

describe("manufacturing scope", () => {
  it("national-gates BOM creation and approval, retaining author separation", async () => {
    const f = await fixture();
    const regional = await f.actor("regional-bom@test.local", "admin");
    const national = await f.actor(
      "national-bom@test.local",
      "admin",
      f.rootUnit,
    );
    const bom = {
      code: "BOM-SCOPE",
      name: "Scope",
      outputProductId: f.product._id,
      outputQuantityBase: 1n,
      effectiveFrom: 0,
      yieldTargetBps: 10000,
      components: [
        {
          productId: f.product._id,
          quantityBase: 1n,
          issuePolicy: "backflush" as const,
        },
      ],
    };
    await expect(
      regional.mutation(api.inventory.manufacturing.createBomVersion, bom),
    ).rejects.toThrow();
    const id = await f.root.mutation(
      api.inventory.manufacturing.createBomVersion,
      bom,
    );
    await expect(
      f.root.mutation(api.inventory.manufacturing.approveBomVersion, {
        bomVersionId: id,
      }),
    ).rejects.toThrow("author");
    await expect(
      regional.mutation(api.inventory.manufacturing.approveBomVersion, {
        bomVersionId: id,
      }),
    ).rejects.toThrow();
    await national.mutation(api.inventory.manufacturing.approveBomVersion, {
      bomVersionId: id,
    });
    expect((await f.t.run((ctx) => ctx.db.get(id)))?.status).toBe("active");
  });

  it("gates all three order locations, stored completion/scrap locations, and both list branches", async () => {
    const f = await fixture();
    const ops = await f.actor("ops-manufacturing@test.local", "operations");
    const viewer = await f.actor("viewer-manufacturing@test.local", "viewer");
    const { versionId, orderA, orderB } = await f.t.run(async (ctx) => {
      const now = Date.now();
      const bomId = await ctx.db.insert("billOfMaterials", {
        organizationId: "sunpride",
        productId: f.product._id,
        code: "SCOPE-PRODUCTION",
        name: "Test",
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      const versionId = await ctx.db.insert("billOfMaterialVersions", {
        organizationId: "sunpride",
        bomId,
        version: 1,
        outputQuantityBase: 1n,
        status: "active",
        effectiveFrom: 0,
        yieldTargetBps: 10000,
        createdBy: "root",
        createdAt: now,
        updatedAt: now,
      });
      const order = (
        sourceLocationId: typeof f.a._id,
        wipLocationId: typeof f.a._id,
        outputLocationId: typeof f.a._id,
        code: string,
      ) =>
        ctx.db.insert("productionOrders", {
          organizationId: "sunpride",
          productionOrderNumber: code,
          productId: f.product._id,
          bomVersionId: versionId,
          plannedBase: 1000n,
          completedBase: 0n,
          scrappedBase: 0n,
          sourceLocationId,
          wipLocationId,
          outputLocationId,
          status: "released",
          createdBy: "root",
          createdAt: now,
          updatedAt: now,
        });
      return {
        versionId,
        orderA: await order(f.a._id, f.wip._id, f.a._id, "SCOPE-A"),
        orderB: await order(f.b._id, f.b._id, f.b._id, "SCOPE-B"),
      };
    });
    const create = {
      productId: f.product._id,
      bomVersionId: versionId,
      plannedBase: 1n,
      sourceLocationId: f.a._id,
      wipLocationId: f.wip._id,
      outputLocationId: f.a._id,
    };
    await expect(
      ops.mutation(api.inventory.manufacturing.createProductionOrder, {
        ...create,
        outputLocationId: f.b._id,
      }),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(
        api.inventory.manufacturing.createProductionOrder,
        create,
      ),
    ).rejects.toThrow();
    const created = await ops.mutation(
      api.inventory.manufacturing.createProductionOrder,
      create,
    );
    expect(created).toBeDefined();
    for (const args of [{}, { status: "released" as const }]) {
      const rows = await ops.query(api.inventory.manufacturing.list, args);
      expect(rows.map((row) => row._id)).toContain(orderA);
      expect(rows.map((row) => row._id)).not.toContain(orderB);
    }
    const complete = (productionOrderId: typeof orderA) => ({
      productionOrderId,
      idempotencyKey: `complete-${productionOrderId}`,
      outputQuantityBase: 1n,
      outputLotNumber: `LOT-${productionOrderId}`,
      manufacturedAt: Date.now(),
      expiresAt: Date.now() + 86400000 * 365,
    });
    await expect(
      ops.mutation(api.inventory.manufacturing.complete, complete(orderB)),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.manufacturing.complete, complete(orderA)),
    ).rejects.toThrow();
    const completed = await ops.mutation(
      api.inventory.manufacturing.complete,
      complete(orderA),
    );
    expect(completed.movementId).toBeDefined();
    const scrap = (productionOrderId: typeof orderA) => ({
      productionOrderId,
      lotId: completed.outputLotId,
      quantityBase: 1n,
      idempotencyKey: `scrap-${productionOrderId}`,
      reason: "test",
    });
    await expect(
      ops.mutation(api.inventory.manufacturing.recordScrap, scrap(orderB)),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.manufacturing.recordScrap, scrap(orderA)),
    ).rejects.toThrow();
    expect(
      await ops.mutation(
        api.inventory.manufacturing.recordScrap,
        scrap(orderA),
      ),
    ).toBeDefined();
  });
});
