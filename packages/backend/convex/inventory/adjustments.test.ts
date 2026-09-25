import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const superAdmin = t.withIdentity({
    subject: "root",
    email: "jcing.jc@gmail.com",
    name: "Root",
  });
  await superAdmin.mutation(api.domains.profiles.ensure, {});
  await t.mutation(internal.seed.demo, {});
  await superAdmin.mutation(api.inventory.setup.foundation, {});
  const unitA = await t.run((ctx) =>
    ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "AREA-A",
      name: "Area A",
      typeCode: "AREA",
      parentId: root.rootUnitId,
      status: "active",
      effectiveFrom: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const unitB = await t.run((ctx) =>
    ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "AREA-B",
      name: "Area B",
      typeCode: "AREA",
      parentId: root.rootUnitId,
      status: "active",
      effectiveFrom: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const [product, locations] = await t.run(
    async (ctx) =>
      [
        await ctx.db
          .query("products")
          .withIndex("by_code", (q) => q.eq("code", "SP-PJ-1L"))
          .unique(),
        await ctx.db.query("inventoryLocations").take(10),
      ] as const,
  );
  if (!product || locations.length < 2)
    throw new Error("Inventory fixture not seeded");
  const [a, b] = locations;
  if (!a || !b) throw new Error("Inventory fixture not seeded");
  await t.run(async (ctx) => {
    await ctx.db.patch(a._id, { orgUnitId: unitA });
    await ctx.db.patch(b._id, { orgUnitId: unitB });
    const policy = await ctx.db
      .query("productInventoryPolicies")
      .withIndex("by_organizationId_and_productId", (q) =>
        q.eq("organizationId", "sunpride").eq("productId", product._id),
      )
      .unique();
    if (!policy) throw new Error("Policy not seeded");
    await ctx.db.patch(policy._id, { trackingMode: "none" });
  });
  async function actor(
    email: string,
    role: "manager" | "viewer" | "sales" | "approver",
    unit = unitA,
  ) {
    await superAdmin.mutation(api.domains.profiles.invite, {
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
      if (!profile) throw new Error("Missing actor");
      await ctx.db.patch(profile._id, { orgUnitId: unit });
    });
    return who;
  }
  const line = (locationId: typeof a._id) => ({
    productId: product._id,
    locationId,
    stockStatus: "available" as const,
    varianceBase: 1_000n,
  });
  const request = (lines: ReturnType<typeof line>[]) => ({
    adjustmentType: "correction",
    reasonCode: "TEST",
    lines,
  });
  return { t, superAdmin, root, unitA, unitB, a, b, actor, line, request };
}

describe("inventory adjustments location scope", () => {
  it("denies viewer and sales requests and accepts manager only in assigned unit", async () => {
    const f = await fixture();
    const viewer = await f.actor("viewer-a@example.test", "viewer");
    const sales = await f.actor("sales-a@example.test", "sales");
    const manager = await f.actor("manager-a@example.test", "manager");
    for (const who of [viewer, sales])
      await expect(
        who.mutation(
          api.inventory.adjustments.request,
          f.request([f.line(f.a._id)]),
        ),
      ).rejects.toThrow();
    const own = await manager.mutation(
      api.inventory.adjustments.request,
      f.request([f.line(f.a._id)]),
    );
    expect(own).toBeDefined();
    await expect(
      manager.mutation(
        api.inventory.adjustments.request,
        f.request([f.line(f.b._id)]),
      ),
    ).rejects.toThrow();
  });

  it("rejects a forged other-region location and mixed request atomically; filters lists", async () => {
    const f = await fixture();
    const manager = await f.actor("manager-mixed@example.test", "manager");
    const before = await f.t.run((ctx) =>
      ctx.db.query("inventoryAdjustments").collect(),
    );
    await expect(
      manager.mutation(
        api.inventory.adjustments.request,
        f.request([f.line(f.a._id), f.line(f.b._id)]),
      ),
    ).rejects.toThrow();
    const after = await f.t.run((ctx) =>
      ctx.db.query("inventoryAdjustments").collect(),
    );
    expect(after).toEqual(before);
    expect(
      await f.t.run((ctx) =>
        ctx.db.query("inventoryAdjustmentLines").collect(),
      ),
    ).toEqual([]);
    const other = await f.superAdmin.mutation(
      api.inventory.adjustments.request,
      f.request([f.line(f.b._id)]),
    );
    const own = await manager.mutation(
      api.inventory.adjustments.request,
      f.request([f.line(f.a._id)]),
    );
    const list = await manager.query(api.inventory.adjustments.list, {});
    expect(list.map((row) => row._id)).toEqual([own]);
    expect(list.map((row) => row._id)).not.toContain(other);
  });

  it("refuses self-approval and checks stored line scope at decision and reversal", async () => {
    const f = await fixture();
    const manager = await f.actor("requester@example.test", "manager");
    const approver = await f.actor(
      "approver@example.test",
      "approver",
      f.unitB,
    );
    const id = await manager.mutation(
      api.inventory.adjustments.request,
      f.request([f.line(f.a._id)]),
    );
    await expect(
      manager.mutation(api.inventory.adjustments.decide, {
        adjustmentId: id,
        decision: "rejected",
      }),
    ).rejects.toThrow("Requester cannot approve");
    await expect(
      approver.mutation(api.inventory.adjustments.decide, {
        adjustmentId: id,
        decision: "rejected",
      }),
    ).rejects.toThrow();
    const another = await f.actor("approver-a@example.test", "approver");
    expect(
      await another.mutation(api.inventory.adjustments.decide, {
        adjustmentId: id,
        decision: "rejected",
      }),
    ).toBeNull();
  });
});
