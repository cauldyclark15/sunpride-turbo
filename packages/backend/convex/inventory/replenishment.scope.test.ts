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

describe("replenishment scope", () => {
  it("gates location writes, national global policies, audits updates, and filters suggestions", async () => {
    const f = await fixture();
    const ops = await f.actor("ops-replenishment@test.local", "operations");
    const viewer = await f.actor("viewer-replenishment@test.local", "viewer");
    const policy = {
      productId: f.product._id,
      enabled: true,
      reorderPointBase: 10n,
      targetLevelBase: 20n,
      safetyStockBase: 0n,
      alertCooldownMs: 0,
    };
    await expect(
      ops.mutation(api.inventory.replenishment.upsertPolicy, {
        ...policy,
        locationId: f.b._id,
      }),
    ).rejects.toThrow();
    await expect(
      ops.mutation(api.inventory.replenishment.upsertPolicy, policy),
    ).rejects.toThrow();
    await expect(
      viewer.mutation(api.inventory.replenishment.upsertPolicy, {
        ...policy,
        locationId: f.a._id,
      }),
    ).rejects.toThrow();
    const own = await ops.mutation(api.inventory.replenishment.upsertPolicy, {
      ...policy,
      locationId: f.a._id,
    });
    await ops.mutation(api.inventory.replenishment.upsertPolicy, {
      ...policy,
      locationId: f.a._id,
      reorderPointBase: 11n,
    });
    const other = await f.root.mutation(
      api.inventory.replenishment.upsertPolicy,
      { ...policy, locationId: f.b._id },
    );
    const global = await f.root.mutation(
      api.inventory.replenishment.upsertPolicy,
      policy,
    );
    const audit = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "replenishmentPolicy").eq("entityId", own),
        )
        .take(10),
    );
    expect(audit).toHaveLength(2);
    const rows = await viewer.query(
      api.inventory.replenishment.suggestions,
      {},
    );
    expect(rows.map((row) => row.policyId)).toContain(own);
    expect(rows.map((row) => row.policyId)).not.toContain(other);
    expect(rows.map((row) => row.policyId)).not.toContain(global);
    expect(
      (await f.root.query(api.inventory.replenishment.suggestions, {})).map(
        (row) => row.policyId,
      ),
    ).toContain(global);
  });
});
