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
  const admin = t.withIdentity({
    subject: "root-location",
    email: "jcing.jc@gmail.com",
    name: "Root",
  });
  await admin.mutation(api.domains.profiles.ensure, {});
  await t.mutation(internal.seed.demo, {});
  await admin.mutation(api.inventory.setup.foundation, {});
  const unit = await t.run((ctx) =>
    ctx.db.insert("orgUnits", {
      organizationId: "sunpride",
      code: "AREA-LOCATION",
      name: "Area location",
      typeCode: "AREA",
      parentId: root.rootUnitId,
      status: "active",
      effectiveFrom: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const location = (
    await t.run((ctx) => ctx.db.query("inventoryLocations").take(1))
  )[0];
  if (!location) throw new Error("Location not seeded");
  await admin.mutation(api.domains.profiles.invite, {
    email: "regional@example.test",
    name: "Regional",
    role: "manager",
  });
  const manager = t.withIdentity({
    subject: "regional@example.test",
    email: "regional@example.test",
    name: "Regional",
  });
  await manager.mutation(api.domains.profiles.ensure, {});
  await t.run(async (ctx) => {
    const p = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", "regional@example.test"))
      .unique();
    if (!p) throw new Error("Profile not seeded");
    await ctx.db.patch(p._id, { orgUnitId: unit });
  });
  return { t, admin, manager, location, unit, root };
}

describe("inventory location ownership", () => {
  it("fails closed for scoped users on unmapped locations but permits super admin", async () => {
    const f = await fixture();
    await expect(
      f.manager.mutation(api.inventory.counts.start, {
        locationId: f.location._id,
        countType: "cycle",
        blindCount: true,
      }),
    ).rejects.toThrow();
    const id = await f.admin.mutation(api.inventory.counts.start, {
      locationId: f.location._id,
      countType: "cycle",
      blindCount: true,
    });
    expect(id).toBeDefined();
    expect(
      (await f.manager.query(api.inventory.queries.locations, {})).map(
        (l) => l._id,
      ),
    ).not.toContain(f.location._id);
  });

  it("backfills unmapped locations to root idempotently", async () => {
    const f = await fixture();
    const first = await f.t.mutation(
      internal.inventory.location_scope.backfillNational,
      {},
    );
    expect(first.mapped).toBeGreaterThan(0);
    expect(first.remaining).toBe(false);
    const second = await f.t.mutation(
      internal.inventory.location_scope.backfillNational,
      {},
    );
    expect(second.mapped).toBe(0);
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.location._id)))?.orgUnitId,
    ).toBe(f.root.rootUnitId);
  });

  it("requires national scope to move a mapped location across regions", async () => {
    const f = await fixture();
    const other = await f.t.run((ctx) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "AREA-OTHER",
        name: "Other",
        typeCode: "AREA",
        parentId: f.root.rootUnitId,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await f.admin.mutation(api.inventory.location_scope.assign, {
      locationId: f.location._id,
      orgUnitId: f.unit,
      reason: "initial",
    });
    await f.admin.mutation(api.domains.profiles.invite, {
      email: "regional-admin@example.test",
      name: "Regional admin",
      role: "admin",
    });
    const regional = f.t.withIdentity({
      subject: "regional-admin@example.test",
      email: "regional-admin@example.test",
      name: "Regional admin",
    });
    await regional.mutation(api.domains.profiles.ensure, {});
    await f.t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) =>
          q.eq("email", "regional-admin@example.test"),
        )
        .unique();
      if (!p) throw new Error("Missing profile");
      await ctx.db.patch(p._id, { orgUnitId: f.unit });
    });
    await expect(
      regional.mutation(api.inventory.location_scope.assign, {
        locationId: f.location._id,
        orgUnitId: other,
        reason: "cross region",
      }),
    ).rejects.toThrow();
    await f.admin.mutation(api.inventory.location_scope.assign, {
      locationId: f.location._id,
      orgUnitId: other,
      reason: "national transfer",
    });
    expect(
      (await f.t.run((ctx) => ctx.db.get(f.location._id)))?.orgUnitId,
    ).toBe(other);
  });

  it("refuses an area admin pulling a sibling area's location but permits their regional admin", async () => {
    const f = await fixture();
    const { region, areaA1, areaA2 } = await f.t.run(async (ctx) => {
      const insertUnit = (
        code: string,
        typeCode: string,
        parentId: typeof f.unit,
      ) =>
        ctx.db.insert("orgUnits", {
          organizationId: "sunpride",
          code,
          name: code,
          typeCode,
          parentId,
          status: "active" as const,
          effectiveFrom: 0,
          createdAt: 1,
          updatedAt: 1,
        });
      const region = await insertUnit(
        "REGION-ASSIGN",
        "REGION",
        f.root.rootUnitId,
      );
      const areaA1 = await insertUnit("AREA-A1-ASSIGN", "AREA", region);
      const areaA2 = await insertUnit("AREA-A2-ASSIGN", "AREA", region);
      return { region, areaA1, areaA2 };
    });
    await f.admin.mutation(api.inventory.location_scope.assign, {
      locationId: f.location._id,
      orgUnitId: areaA2,
      reason: "initial ownership",
    });
    async function scopedAdmin(email: string, orgUnitId: typeof region) {
      await f.admin.mutation(api.domains.profiles.invite, {
        email,
        name: email,
        role: "admin",
      });
      const actor = f.t.withIdentity({ subject: email, email, name: email });
      await actor.mutation(api.domains.profiles.ensure, {});
      await f.t.run(async (ctx) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_email", (q) => q.eq("email", email))
          .unique();
        if (!profile) throw new Error("Missing profile");
        await ctx.db.patch(profile._id, { orgUnitId });
      });
      return actor;
    }
    const areaAdmin = await scopedAdmin("area-a1-admin@example.test", areaA1);
    const regionalAdmin = await scopedAdmin(
      "region-admin@example.test",
      region,
    );
    const state = () =>
      f.t.run(async (ctx) => ({
        location: await ctx.db.get(f.location._id),
        audit: await ctx.db
          .query("auditLogs")
          .withIndex("by_entity", (q) =>
            q
              .eq("entityType", "inventoryLocation")
              .eq("entityId", f.location._id),
          )
          .collect(),
      }));
    const before = await state();
    expect(before.audit).toHaveLength(1);
    await expect(
      areaAdmin.mutation(api.inventory.location_scope.assign, {
        locationId: f.location._id,
        orgUnitId: areaA1,
        reason: "pull from sibling",
      }),
    ).rejects.toThrow("Requested scope is outside your organizational scope");
    const refused = await state();
    expect(refused.location?.orgUnitId).toBe(areaA2);
    expect(refused.audit).toEqual(before.audit);

    await regionalAdmin.mutation(api.inventory.location_scope.assign, {
      locationId: f.location._id,
      orgUnitId: areaA1,
      reason: "regional transfer",
    });
    const transferred = await state();
    expect(transferred.location?.orgUnitId).toBe(areaA1);
    expect(transferred.audit).toHaveLength(2);
    expect(transferred.audit[1]?.details).toContain("regional transfer");
  });

  it("requires national scope for mapping unmapped or cross-region locations and audits assignment", async () => {
    const f = await fixture();
    await expect(
      f.admin.mutation(api.inventory.location_scope.assign, {
        locationId: f.location._id,
        orgUnitId: f.unit,
        reason: "  ",
      }),
    ).rejects.toThrow();
    await expect(
      f.manager.mutation(api.inventory.location_scope.assign, {
        locationId: f.location._id,
        orgUnitId: f.unit,
        reason: "map",
      }),
    ).rejects.toThrow();
    await f.admin.mutation(api.inventory.location_scope.assign, {
      locationId: f.location._id,
      orgUnitId: f.unit,
      reason: "ownership",
    });
    const state = await f.t.run(async (ctx) => ({
      location: await ctx.db.get(f.location._id),
      audit: await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q
            .eq("entityType", "inventoryLocation")
            .eq("entityId", f.location._id),
        )
        .collect(),
    }));
    expect(state.location?.orgUnitId).toBe(f.unit);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]?.details).toContain("ownership");
    await f.admin.mutation(api.inventory.location_scope.assign, {
      locationId: f.location._id,
      orgUnitId: f.unit,
      reason: "no change",
    });
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("auditLogs")
          .withIndex("by_entity", (q) =>
            q
              .eq("entityType", "inventoryLocation")
              .eq("entityId", f.location._id),
          )
          .collect(),
      ),
    ).toHaveLength(1);
  });
});
