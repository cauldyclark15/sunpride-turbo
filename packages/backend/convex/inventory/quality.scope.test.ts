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
  await superAdmin.mutation(internal.seed.demo, {});
  await superAdmin.mutation(api.inventory.setup.foundation, {});
  const [aUnit, bUnit, product, locations] = await t.run(async (ctx) => {
    const unit = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "AREA",
        parentId: root.rootUnitId,
        status: "active" as const,
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    return [
      await unit("AREA-SCOPE-A"),
      await unit("AREA-SCOPE-B"),
      await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", "SP-PJ-1L"))
        .unique(),
      await ctx.db.query("inventoryLocations").take(10),
    ] as const;
  });
  if (!product || locations.length < 4)
    throw new Error("Inventory fixture missing");
  const [a, a2, a3, b] = locations;
  if (!a || !a2 || !a3 || !b) throw new Error("Inventory fixture missing");
  await t.run(async (ctx) => {
    for (const loc of [a, a2, a3])
      await ctx.db.patch(loc._id, { orgUnitId: aUnit });
    await ctx.db.patch(b._id, { orgUnitId: bUnit });
    const policy = await ctx.db
      .query("productInventoryPolicies")
      .withIndex("by_organizationId_and_productId", (q) =>
        q.eq("organizationId", "sunpride").eq("productId", product._id),
      )
      .unique();
    if (!policy) throw new Error("Policy missing");
    await ctx.db.patch(policy._id, { trackingMode: "none" });
  });
  async function actor(
    email: string,
    role: "admin" | "manager" | "approver" | "viewer" | "sales",
    unit = aUnit,
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
      if (!profile) throw new Error("Missing profile");
      await ctx.db.patch(profile._id, { orgUnitId: unit });
    });
    return who;
  }
  return { t, superAdmin, product, a, a2, a3, b, aUnit, bUnit, actor };
}

describe("quality hold scope", () => {
  it("requires write to hold and approve to release at the stored location", async () => {
    const f = await fixture();
    const manager = await f.actor("quality-manager@example.test", "admin");
    const outsider = await f.actor(
      "quality-other@example.test",
      "admin",
      f.bUnit,
    );
    const approver = await f.actor("quality-approver@example.test", "approver");
    const viewer = await f.actor("quality-viewer@example.test", "viewer");
    await f.t.run(async (ctx) => {
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", f.product._id),
        )
        .unique();
      if (!policy) throw new Error("Policy missing");
      await ctx.db.patch(policy._id, { trackingMode: "lot" });
    });
    await f.superAdmin.mutation(api.inventory.receipts.post, {
      idempotencyKey: "quality-seed",
      receiptType: "unplanned",
      receivingLocationId: f.a._id,
      lines: [
        {
          productId: f.product._id,
          quantityBase: 10n,
          lotNumber: "QUALITY-LOT",
          manufacturedAt: 1,
          expiresAt: Date.now() + 86400000,
        },
      ],
    });
    const lot = await f.t.run((ctx) =>
      ctx.db
        .query("inventoryLots")
        .withIndex(
          "by_organizationId_and_productId_and_normalizedLotNumber",
          (q) =>
            q
              .eq("organizationId", "sunpride")
              .eq("productId", f.product._id)
              .eq("normalizedLotNumber", "QUALITY-LOT"),
        )
        .unique(),
    );
    if (!lot) throw new Error("Lot missing");
    const args = {
      idempotencyKey: "quality-hold",
      lotId: lot._id,
      locationId: f.a._id,
      fromStatus: "available" as const,
      toStatus: "quality_hold" as const,
      quantityBase: 1n,
      reasonCode: "inspection",
    };
    await expect(
      outsider.mutation(api.inventory.quality.changeStatus, args),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.quality.changeStatus, args),
    ).rejects.toThrow();
    await manager.mutation(api.inventory.quality.changeStatus, args);
    const release = {
      ...args,
      idempotencyKey: "quality-release",
      fromStatus: "quality_hold" as const,
      toStatus: "available" as const,
    };
    await expect(
      manager.mutation(api.inventory.quality.changeStatus, release),
    ).rejects.toThrow();
    await expect(
      outsider.mutation(api.inventory.quality.changeStatus, release),
    ).rejects.toThrow();
    await approver.mutation(api.inventory.quality.changeStatus, release);
  });
});
