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

describe("stock transfer scope", () => {
  it("gates all three locations on request and approval, retains no-self-approval, and filters both list branches", async () => {
    const f = await fixture();
    const manager = await f.actor("transfer-manager@example.test", "admin");
    const approver = await f.actor(
      "transfer-approver@example.test",
      "approver",
    );
    const outsider = await f.actor(
      "transfer-other@example.test",
      "admin",
      f.bUnit,
    );
    const outsideApprover = await f.actor(
      "transfer-outside-approver@example.test",
      "approver",
      f.bUnit,
    );
    const viewer = await f.actor("transfer-viewer@example.test", "viewer");
    const args = {
      sourceLocationId: f.a._id,
      destinationLocationId: f.a2._id,
      inTransitLocationId: f.a3._id,
      lines: [{ productId: f.product._id, quantityBase: 1n }],
    };
    await expect(
      manager.mutation(api.inventory.transfers.request, {
        ...args,
        inTransitLocationId: f.b._id,
      }),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.transfers.request, args),
    ).rejects.toThrow();
    const id = await manager.mutation(api.inventory.transfers.request, args);
    await expect(
      outsider.mutation(api.inventory.transfers.approve, { transferId: id }),
    ).rejects.toThrow();
    await expect(
      manager.mutation(api.inventory.transfers.approve, { transferId: id }),
    ).rejects.toThrow();
    await expect(
      outsideApprover.mutation(api.inventory.transfers.approve, {
        transferId: id,
      }),
    ).rejects.toThrow("outside your organizational scope");
    const self = await f.superAdmin.mutation(
      api.inventory.transfers.request,
      args,
    );
    await expect(
      f.superAdmin.mutation(api.inventory.transfers.approve, {
        transferId: self,
      }),
    ).rejects.toThrow("requester cannot approve");
    await approver.mutation(api.inventory.transfers.approve, {
      transferId: id,
    });
    const other = await f.superAdmin.mutation(api.inventory.transfers.request, {
      ...args,
      sourceLocationId: f.b._id,
    });
    for (const status of [undefined, "approved" as const]) {
      const rows = await manager.query(
        api.inventory.transfers.list,
        status ? { status } : {},
      );
      expect(rows.map((row) => row._id)).toContain(id);
      expect(rows.map((row) => row._id)).not.toContain(other);
    }
    await expect(
      outsider.mutation(api.inventory.transfers.cancel, { transferId: id }),
    ).rejects.toThrow();
    await expect(
      outsideApprover.mutation(api.inventory.transfers.cancel, {
        transferId: id,
      }),
    ).rejects.toThrow("outside your organizational scope");
    await approver.mutation(api.inventory.transfers.cancel, { transferId: id });
  });
  it("gates ship and receive from stored transfer locations", async () => {
    const f = await fixture();
    const manager = await f.actor("ship-manager@example.test", "admin");
    const outsider = await f.actor("ship-other@example.test", "admin", f.bUnit);
    const approver = await f.actor("ship-approver@example.test", "approver");
    await f.superAdmin.mutation(api.inventory.receipts.post, {
      idempotencyKey: "transfer-seed",
      receiptType: "unplanned",
      receivingLocationId: f.a._id,
      lines: [{ productId: f.product._id, quantityBase: 10n }],
    });
    const id = await manager.mutation(api.inventory.transfers.request, {
      sourceLocationId: f.a._id,
      destinationLocationId: f.a2._id,
      inTransitLocationId: f.a3._id,
      lines: [{ productId: f.product._id, quantityBase: 1n }],
    });
    await approver.mutation(api.inventory.transfers.approve, {
      transferId: id,
    });
    await expect(
      outsider.mutation(api.inventory.transfers.ship, {
        transferId: id,
        idempotencyKey: "ship-denied",
      }),
    ).rejects.toThrow();
    await manager.mutation(api.inventory.transfers.ship, {
      transferId: id,
      idempotencyKey: "ship-ok",
    });
    await expect(
      outsider.mutation(api.inventory.transfers.receive, {
        transferId: id,
        idempotencyKey: "receive-denied",
      }),
    ).rejects.toThrow();
    await manager.mutation(api.inventory.transfers.receive, {
      transferId: id,
      idempotencyKey: "receive-ok",
    });
  });
});
