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

describe("reservation scope", () => {
  it("gates every create line, refuses viewer and sales, and filters both list branches", async () => {
    const f = await fixture();
    const manager = await f.actor("reservation-manager@example.test", "admin");
    const outsider = await f.actor(
      "reservation-other@example.test",
      "admin",
      f.bUnit,
    );
    const viewer = await f.actor("reservation-viewer@example.test", "viewer");
    const sales = await f.actor("reservation-sales@example.test", "sales");
    for (const [key, locationId] of [
      ["stock-a", f.a._id],
      ["stock-b", f.b._id],
    ] as const)
      await f.superAdmin.mutation(api.inventory.receipts.post, {
        idempotencyKey: key,
        receiptType: "unplanned",
        receivingLocationId: locationId,
        lines: [{ productId: f.product._id, quantityBase: 10n }],
      });
    const args = {
      idempotencyKey: "reserve-a",
      reservationType: "hard",
      sourceType: "test",
      sourceDocumentId: "source-a",
      lines: [
        { productId: f.product._id, locationId: f.a._id, quantityBase: 1n },
      ],
    };
    await expect(
      manager.mutation(api.inventory.reservations.create, {
        ...args,
        lines: [...args.lines, { ...args.lines[0]!, locationId: f.b._id }],
      }),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.reservations.create, args),
    ).rejects.toThrow();
    await expect(
      sales.mutation(api.inventory.reservations.create, args),
    ).rejects.toThrow();
    const own = await manager.mutation(api.inventory.reservations.create, args);
    const other = await f.superAdmin.mutation(
      api.inventory.reservations.create,
      {
        ...args,
        idempotencyKey: "reserve-b",
        lines: [{ ...args.lines[0]!, locationId: f.b._id }],
      },
    );
    for (const status of [undefined, "active" as const]) {
      const rows = await manager.query(
        api.inventory.reservations.list,
        status ? { status } : {},
      );
      expect(rows.map((row) => row._id)).toContain(own);
      expect(rows.map((row) => row._id)).not.toContain(other);
    }
    await expect(
      outsider.mutation(api.inventory.reservations.consume, {
        reservationId: own,
        idempotencyKey: "consume-denied",
      }),
    ).rejects.toThrow();
    await manager.mutation(api.inventory.reservations.consume, {
      reservationId: own,
      idempotencyKey: "consume-ok",
    });
    await expect(
      outsider.mutation(api.inventory.reservations.release, {
        reservationId: other,
        idempotencyKey: "release-other-region",
      }),
    ).resolves.toBeNull();
    const second = await manager.mutation(api.inventory.reservations.create, {
      ...args,
      idempotencyKey: "reserve-a2",
    });
    await expect(
      outsider.mutation(api.inventory.reservations.release, {
        reservationId: second,
        idempotencyKey: "release-denied",
      }),
    ).rejects.toThrow();
    await manager.mutation(api.inventory.reservations.release, {
      reservationId: second,
      idempotencyKey: "release-ok",
    });
  });
});
