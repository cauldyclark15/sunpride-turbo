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
  await root.mutation(api.seed.demo, {});
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

describe("inventory setup national scope", () => {
  it("refuses regional/admin and viewer setup writes; records foundation actor and national opening balance", async () => {
    const f = await fixture();
    const regional = await f.actor("regional-setup@test.local", "admin");
    const viewer = await f.actor("viewer-setup@test.local", "viewer");
    await expect(
      regional.mutation(api.inventory.setup.foundation, {}),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.setup.foundation, {}),
    ).rejects.toThrow();
    await f.root.mutation(api.inventory.setup.foundation, {});
    const logs = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "inventoryFoundation").eq("entityId", "sunpride"),
        )
        .take(10),
    );
    expect(logs).toHaveLength(2);
    expect(logs[1]?.subject).toBeDefined();
    const opening = {
      idempotencyKey: "national-opening",
      sourceReference: "SCOPE-OPEN",
      lines: [
        {
          productId: f.product._id,
          locationId: f.b._id,
          quantityBase: 1000n,
          lotNumber: "SCOPE-LOT",
          manufacturedAt: Date.now() - 86400000,
          expiresAt: Date.now() + 86400000 * 365,
        },
      ],
    };
    await expect(
      regional.mutation(api.inventory.setup.postOpeningBalances, opening),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.setup.postOpeningBalances, opening),
    ).rejects.toThrow();
    expect(
      (await f.root.mutation(api.inventory.setup.postOpeningBalances, opening))
        .movementId,
    ).toBeDefined();
  });
});
