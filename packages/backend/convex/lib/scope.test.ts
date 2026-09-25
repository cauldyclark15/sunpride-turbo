import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import schema from "../schema";
import { modules } from "../test.setup";

// Keep the schema generic: `ReturnType<typeof convexTest>` erases it and the in-test
// ctx loses table typing (indexes resolve to system tables only).
type Test = TestConvex<typeof schema>;
type Identity = ReturnType<Test["withIdentity"]>;

const BOOTSTRAP_EMAIL = "jcing.jc@gmail.com";

async function bootstrapSuperAdmin(t: Test) {
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const superAdmin = t.withIdentity({
    subject: "bootstrap-super-admin",
    email: BOOTSTRAP_EMAIL,
    name: "JC",
  });
  await superAdmin.mutation(api.domains.profiles.ensure);
  return superAdmin;
}

async function provisionProfile(
  t: Test,
  superAdmin: Identity,
  email: string,
  role: "admin" | "manager" | "approver" | "sales" | "viewer",
) {
  await superAdmin.mutation(api.domains.profiles.invite, {
    email,
    name: email,
    role,
  });
  const identity = t.withIdentity({ subject: email, email, name: email });
  await identity.mutation(api.domains.profiles.ensure);
  return identity;
}

async function insertOrgUnit(
  t: Test,
  input: {
    code: string;
    name: string;
    typeCode: string;
    parentId?: Id<"orgUnits">;
  },
) {
  const now = Date.now();
  return t.run(async (ctx) =>
    ctx.db.insert("orgUnits", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      code: input.code,
      name: input.name,
      typeCode: input.typeCode,
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    }),
  );
}

async function assignOrgUnit(
  t: Test,
  email: string,
  orgUnitId: Id<"orgUnits">,
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!profile) throw new Error(`profile not found for ${email}`);
    await ctx.db.patch(profile._id, {
      orgUnitId,
      effectiveFrom: now,
      updatedAt: now,
    });
  });
}

describe("organization foundation", () => {
  it("seeds configurable levels, a root unit, and scopes existing profiles", async () => {
    const t = convexTest(schema, modules);
    const superAdmin = await bootstrapSuperAdmin(t);
    void superAdmin;

    const first = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    expect(first.rootUnitCreated).toBe(true);
    expect(first.typeCount).toBe(4);
    expect(first.scopedProfileCount).toBe(1);

    const types = await t.run(async (ctx) =>
      ctx.db.query("orgUnitTypes").collect(),
    );
    expect(types.map((type) => type.code).sort()).toEqual([
      "AREA",
      "NATIONAL",
      "REGION",
      "TERRITORY",
    ]);

    const root = await t.run(async (ctx) => ctx.db.get(first.rootUnitId));
    expect(root?.code).toBe("SUNPRIDE");
    expect(root?.typeCode).toBe("NATIONAL");
    expect(root?.parentId).toBeUndefined();

    const profile = await t.run(async (ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", BOOTSTRAP_EMAIL))
        .unique(),
    );
    expect(profile?.orgUnitId).toBe(first.rootUnitId);

    const second = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    expect(second.rootUnitCreated).toBe(false);
    expect(second.rootUnitId).toBe(first.rootUnitId);
    expect(second.scopedProfileCount).toBe(0);
    const units = await t.run(async (ctx) =>
      ctx.db.query("orgUnits").collect(),
    );
    expect(units).toHaveLength(1);
  });

  it("seeds national scope only for unscoped super admins", async () => {
    const t = convexTest(schema, modules);
    const superAdmin = await bootstrapSuperAdmin(t);
    const manager = await provisionProfile(
      t,
      superAdmin,
      "foundation-manager@sunpride.local",
      "manager",
    );

    const first = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    expect(first.scopedProfileCount).toBe(1);

    const superAdminProfile = await superAdmin.query(
      api.domains.profiles.current,
    );
    const managerProfile = await manager.query(api.domains.profiles.current);
    expect(superAdminProfile?.orgUnitId).toBe(first.rootUnitId);
    expect(managerProfile?.orgUnitId).toBeUndefined();

    const second = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    expect(second.scopedProfileCount).toBe(0);
    expect(
      (await manager.query(api.domains.profiles.current))?.orgUnitId,
    ).toBeUndefined();
  });
});

describe("organizational scope", () => {
  async function seedHierarchy(t: Test) {
    const superAdmin = await bootstrapSuperAdmin(t);
    const root = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    const area = await insertOrgUnit(t, {
      code: "AREA-NCR-S",
      name: "NCR South",
      typeCode: "AREA",
      parentId: root.rootUnitId,
    });
    const territory = await insertOrgUnit(t, {
      code: "TER-MAKATI",
      name: "Makati",
      typeCode: "TERRITORY",
      parentId: area,
    });
    const otherArea = await insertOrgUnit(t, {
      code: "AREA-NCR-N",
      name: "NCR North",
      typeCode: "AREA",
      parentId: root.rootUnitId,
    });
    return {
      superAdmin,
      rootUnitId: root.rootUnitId,
      area,
      territory,
      otherArea,
    };
  }

  it("returns the caller's own unit and its descendants as scope", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, rootUnitId, area, territory } = await seedHierarchy(t);
    const admin = await provisionProfile(
      t,
      superAdmin,
      "area-admin@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "area-admin@sunpride.local", area);

    const scope = await admin.query(api.domains.profiles.myScope);
    expect(scope.orgUnitId).toBe(area);
    expect(scope.orgUnitCode).toBe("AREA-NCR-S");
    expect(scope.scopeUnitIds).toContain(area);
    expect(scope.scopeUnitIds).toContain(territory);
    expect(scope.scopeUnitIds).not.toContain(rootUnitId);
  });

  it("allows a target inside the caller's subtree", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, territory, area } = await seedHierarchy(t);
    const admin = await provisionProfile(
      t,
      superAdmin,
      "area-admin@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "area-admin@sunpride.local", area);

    const result = await admin.mutation(internal.lib.scope.assertScopeAccess, {
      roles: ["admin"],
      targetUnitId: territory,
    });
    expect(result.orgUnitId).toBe(area);
  });

  it("refuses a target outside the caller's subtree", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, otherArea, area } = await seedHierarchy(t);
    const admin = await provisionProfile(
      t,
      superAdmin,
      "area-admin@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "area-admin@sunpride.local", area);

    await expect(
      admin.mutation(internal.lib.scope.assertScopeAccess, {
        roles: ["admin"],
        targetUnitId: otherArea,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
  });

  it("refuses a role that is not allowed", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area } = await seedHierarchy(t);
    const viewer = await provisionProfile(
      t,
      superAdmin,
      "viewer@sunpride.local",
      "viewer",
    );
    await assignOrgUnit(t, "viewer@sunpride.local", area);

    await expect(
      viewer.mutation(internal.lib.scope.assertScopeAccess, {
        roles: ["admin"],
        targetUnitId: area,
      }),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("refuses a scoped target when the profile has no organizational scope", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area } = await seedHierarchy(t);
    const admin = await provisionProfile(
      t,
      superAdmin,
      "branch-admin@sunpride.local",
      "admin",
    );

    await expect(
      admin.mutation(internal.lib.scope.assertScopeAccess, {
        roles: ["admin"],
        targetUnitId: area,
      }),
    ).rejects.toThrow(/no organizational scope/);

    const unscoped = await admin.query(api.domains.profiles.myScope);
    expect(unscoped.orgUnitId).toBeNull();
    expect(unscoped.scopeUnitIds).toHaveLength(0);
  });

  it("provisions an invited manager without national scope and refuses scoped access", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area } = await seedHierarchy(t);
    const manager = await provisionProfile(
      t,
      superAdmin,
      "new-manager@sunpride.local",
      "manager",
    );
    const scope = await manager.query(api.domains.profiles.myScope);
    expect(scope.orgUnitId).toBeNull();
    await expect(
      manager.mutation(internal.lib.scope.assertScopeAccess, {
        roles: ["manager"],
        targetUnitId: area,
      }),
    ).rejects.toThrow(/no organizational scope/);
    // Re-provisioning must not silently assign the root either.
    await manager.mutation(api.domains.profiles.ensure);
    expect(
      (await manager.query(api.domains.profiles.myScope)).orgUnitId,
    ).toBeNull();
  });

  it("checks both current and destination scope on persona moves", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area, territory, otherArea, rootUnitId } =
      await seedHierarchy(t);
    const admin = await provisionProfile(
      t,
      superAdmin,
      "scoped-admin@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "scoped-admin@sunpride.local", area);
    const outsider = await provisionProfile(
      t,
      superAdmin,
      "outsider@sunpride.local",
      "viewer",
    );
    const outsiderId = (await outsider.query(api.domains.profiles.current))!
      ._id;
    await assignOrgUnit(t, "outsider@sunpride.local", otherArea);
    await expect(
      admin.mutation(api.domains.profiles.assignPersona, {
        profileId: outsiderId,
        orgUnitId: territory,
      }),
    ).rejects.toThrow(/outside your organizational scope/);

    const insider = await provisionProfile(
      t,
      superAdmin,
      "insider@sunpride.local",
      "viewer",
    );
    const insiderId = (await insider.query(api.domains.profiles.current))!._id;
    await assignOrgUnit(t, "insider@sunpride.local", territory);
    await expect(
      admin.mutation(api.domains.profiles.assignPersona, {
        profileId: insiderId,
        orgUnitId: otherArea,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await admin.mutation(api.domains.profiles.assignPersona, {
      profileId: insiderId,
      orgUnitId: area,
    });
    expect((await insider.query(api.domains.profiles.myScope)).orgUnitId).toBe(
      area,
    );

    const unassigned = await provisionProfile(
      t,
      superAdmin,
      "unassigned@sunpride.local",
      "viewer",
    );
    const unassignedId = (await unassigned.query(api.domains.profiles.current))!
      ._id;
    await expect(
      admin.mutation(api.domains.profiles.assignPersona, {
        profileId: unassignedId,
        orgUnitId: area,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    const rootAdmin = await provisionProfile(
      t,
      superAdmin,
      "root-admin@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "root-admin@sunpride.local", rootUnitId);
    await rootAdmin.mutation(api.domains.profiles.assignPersona, {
      profileId: unassignedId,
      orgUnitId: territory,
    });
    expect(
      (await unassigned.query(api.domains.profiles.myScope)).orgUnitId,
    ).toBe(territory);
  });

  it("allows only root-scoped admins or super admins to read national data", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area, rootUnitId } = await seedHierarchy(t);
    const regional = await provisionProfile(
      t,
      superAdmin,
      "regional@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "regional@sunpride.local", area);
    const rootAdmin = await provisionProfile(
      t,
      superAdmin,
      "national@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "national@sunpride.local", rootUnitId);
    await expect(
      regional.query(api.imports.products.validateProducts, { rows: [] }),
    ).rejects.toThrow(/outside your organizational scope/);
    expect(
      (
        await rootAdmin.query(api.imports.products.validateProducts, {
          rows: [],
        })
      ).rowCount,
    ).toBe(0);
  });

  it("lets the super admin reach any unit without a scope assignment", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area, otherArea } = await seedHierarchy(t);

    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", BOOTSTRAP_EMAIL))
        .unique();
      if (!profile) throw new Error("profile not found");
      await ctx.db.patch(profile._id, {
        orgUnitId: undefined,
        updatedAt: Date.now(),
      });
    });

    const withinArea = await superAdmin.mutation(
      internal.lib.scope.assertScopeAccess,
      { roles: ["admin"], targetUnitId: area },
    );
    expect(withinArea.role).toBe("super_admin");
    expect(withinArea.orgUnitId).toBeNull();

    const outside = await superAdmin.mutation(
      internal.lib.scope.assertScopeAccess,
      { roles: ["admin"], targetUnitId: otherArea },
    );
    expect(outside.role).toBe("super_admin");
  });
  it("filters historical tree by current scope and redacts outside parent ids", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area, territory, otherArea, rootUnitId } =
      await seedHierarchy(t);
    const admin = await provisionProfile(
      t,
      superAdmin,
      "tree-admin@sunpride.local",
      "admin",
    );
    await assignOrgUnit(t, "tree-admin@sunpride.local", area);
    const nodes = await admin.query(api.org.queries.tree, { asOf: Date.now() });
    expect(nodes.map((node) => node._id)).toContain(territory);
    expect(nodes.map((node) => node._id)).not.toContain(otherArea);
    expect(nodes.map((node) => node._id)).not.toContain(rootUnitId);
    expect(nodes.find((node) => node._id === area)?.parentId).toBeUndefined();
  });
});
