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
  await superAdmin.mutation(api.seed.demo, {});
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

describe("goods receipt scope", () => {
  it("gates post and reverse at the stored receiving location and filters both list branches", async () => {
    const f = await fixture();
    const manager = await f.actor("receipt-manager@example.test", "admin");
    const outsider = await f.actor(
      "receipt-other@example.test",
      "admin",
      f.bUnit,
    );
    const viewer = await f.actor("receipt-viewer@example.test", "viewer");
    const args = {
      idempotencyKey: "receipt-a",
      receiptType: "unplanned" as const,
      receivingLocationId: f.a._id,
      lines: [{ productId: f.product._id, quantityBase: 10n }],
    };
    await expect(
      outsider.mutation(api.inventory.receipts.post, args),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.receipts.post, args),
    ).rejects.toThrow();
    const own = await manager.mutation(api.inventory.receipts.post, args);
    const other = await f.superAdmin.mutation(api.inventory.receipts.post, {
      ...args,
      idempotencyKey: "receipt-b",
      receivingLocationId: f.b._id,
    });
    for (const status of [undefined, "posted" as const]) {
      const rows = await manager.query(
        api.inventory.receipts.list,
        status ? { status } : {},
      );
      expect(rows.map((row) => row._id)).toContain(own.receiptId);
      expect(rows.map((row) => row._id)).not.toContain(other.receiptId);
    }
    await expect(
      outsider.mutation(api.inventory.receipts.reverse, {
        receiptId: own.receiptId,
        idempotencyKey: "rev-denied",
        reason: "test",
      }),
    ).rejects.toThrow();
    await manager.mutation(api.inventory.receipts.reverse, {
      receiptId: own.receiptId,
      idempotencyKey: "rev-ok",
      reason: "test",
    });
  });
});
