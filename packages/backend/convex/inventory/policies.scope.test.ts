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

describe("inventory master policy scope", () => {
  it("national-gates policy/UOM writes and permits explicit inventory.read catalog queries", async () => {
    const f = await fixture();
    const regional = await f.actor("regional-policy@test.local", "admin");
    const sales = await f.actor("sales-policy@test.local", "sales");
    const input = {
      productId: f.product._id,
      baseUomId: f.uom._id,
      quantityScale: 1000n,
      quantityPrecision: 3,
      trackingMode: "lot" as const,
      allocationPolicy: "fefo" as const,
      allowMixedLotsPerLine: true,
      qualityReleaseRequired: false,
      expiryDateRequired: false,
      manufactureDateRequired: false,
      minimumRemainingShelfLifeDays: 0,
      costingMethod: "weighted_average" as const,
    };
    await expect(
      regional.mutation(api.inventory.policies.upsertProductPolicy, input),
    ).rejects.toThrow();
    await expect(
      sales.mutation(api.inventory.policies.upsertProductPolicy, input),
    ).rejects.toThrow();
    expect(
      await f.root.mutation(api.inventory.policies.upsertProductPolicy, input),
    ).toBeDefined();
    const conversion = {
      fromUomId: f.uom._id,
      toUomId: f.otherUom._id,
      numerator: 2n,
      denominator: 1n,
      roundingMode: "exact" as const,
      effectiveFrom: 0,
    };
    await expect(
      regional.mutation(api.inventory.policies.addUomConversion, conversion),
    ).rejects.toThrow();
    // Conversion fixture must use compatible UOM dimensions.
    await f.t.run((ctx) =>
      ctx.db.patch(f.otherUom._id, { dimension: f.uom.dimension }),
    );
    await f.root.mutation(api.inventory.policies.addUomConversion, conversion);
    expect(
      (await sales.query(api.inventory.policies.list, {})).length,
    ).toBeGreaterThan(0);
    expect(
      await sales.query(api.inventory.policies.convert, {
        fromUomId: conversion.fromUomId,
        toUomId: conversion.toUomId,
        quantityBase: 3n,
      }),
    ).toBe(6n);
  });
});
