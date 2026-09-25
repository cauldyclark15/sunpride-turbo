import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { CAPABILITIES, isReadOnlyCapability } from "./capabilities";
import type { AssignableRole } from "./roles";
import schema from "../schema";
import { modules } from "../test.setup";

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
  role: AssignableRole,
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
  await t.run(async (ctx) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!profile) throw new Error(`profile not found for ${email}`);
    await ctx.db.patch(profile._id, { orgUnitId, updatedAt: Date.now() });
  });
}

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
  return { superAdmin, area, territory, otherArea };
}

describe("capability table", () => {
  it("serves a versioned server-derived permission view", async () => {
    const t = convexTest(schema, modules);
    const superAdmin = await bootstrapSuperAdmin(t);
    const root = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    const view = await superAdmin.query(
      api.lib.capabilities.currentPermissions,
      {},
    );
    expect(view.version).toBe(1);
    expect(view.scopeUnitIds).toContain(root.rootUnitId);
    expect(view.capabilities).toContain("admin.manage");
    const viewer = await provisionProfile(
      t,
      superAdmin,
      "view-permission@sunpride.local",
      "viewer",
    );
    const denied = await viewer.query(
      api.lib.capabilities.currentPermissions,
      {},
    );
    expect(denied.scopeUnitIds).toEqual([]);
    expect(denied.capabilities).not.toContain("admin.manage");
  });

  it("grants only operational inventory workflow roles", () => {
    for (const capability of [
      "inventory.adjustment.request",
      "inventory.count.submit",
    ] as const)
      expect(CAPABILITIES[capability]).toEqual([
        "super_admin",
        "admin",
        "operations",
        "manager",
      ]);
    for (const capability of [
      "inventory.adjustment.approve",
      "inventory.count.approve",
    ] as const)
      expect(CAPABILITIES[capability]).toEqual([
        "super_admin",
        "admin",
        "manager",
        "approver",
      ]);
  });

  it("matches the group-04 grants and server permission view", async () => {
    const all = [
      "super_admin",
      "admin",
      "operations",
      "manager",
      "approver",
      "sales",
      "analyst",
      "viewer",
    ];
    for (const key of ["territory.read", "route.read", "outlet.read"] as const)
      expect(CAPABILITIES[key]).toEqual(all);
    expect(CAPABILITIES["territory.manage"]).toEqual(["super_admin", "admin"]);
    for (const key of [
      "route.manage",
      "outlet.manage",
      "outlet.assign",
    ] as const)
      expect(CAPABILITIES[key]).toEqual(["super_admin", "admin", "operations"]);
    expect(CAPABILITIES["outlet.verify"]).toEqual([
      "super_admin",
      "admin",
      "manager",
    ]);
    const t = convexTest(schema, modules);
    const root = await bootstrapSuperAdmin(t);
    await t.mutation(internal.migrations.seedOrganizationFoundation, {});
    const analyst = await provisionProfile(
      t,
      root,
      "g04-analyst@example.test",
      "analyst",
    );
    const permissions = await analyst.query(
      api.lib.capabilities.currentPermissions,
      {},
    );
    expect(permissions.capabilities).toEqual(
      Object.entries(CAPABILITIES)
        .filter(([, roles]) => (roles as readonly string[]).includes("analyst"))
        .map(([key]) => key),
    );
    expect(permissions.capabilities).toContain("territory.read");
    expect(permissions.capabilities).not.toContain("outlet.verify");
  });

  it("keeps cross-scope analyst access read-only", () => {
    const analystCapabilities = Object.entries(CAPABILITIES)
      .filter(([, roles]) => (roles as readonly string[]).includes("analyst"))
      .map(([capability]) => capability);
    expect(analystCapabilities.length).toBeGreaterThan(0);
    for (const capability of analystCapabilities)
      expect(
        isReadOnlyCapability(capability as keyof typeof CAPABILITIES),
      ).toBe(true);
  });

  it("defines at least one role for every capability", () => {
    for (const [capability, roles] of Object.entries(CAPABILITIES)) {
      expect(roles.length).toBeGreaterThan(0);
      expect(capability).toMatch(/^[a-z]+(?:\.[a-z]+)+$/);
    }
  });
});

describe("capability gate", () => {
  it("lets a manager approve inside their subtree", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area, territory } = await seedHierarchy(t);
    const manager = await provisionProfile(
      t,
      superAdmin,
      "ds@sunpride.local",
      "manager",
    );
    await assignOrgUnit(t, "ds@sunpride.local", area);

    const result = await manager.mutation(
      internal.lib.capabilities.assertCapability,
      { capability: "mcp.approve", targetUnitId: territory },
    );
    expect(result.role).toBe("manager");
    expect(result.orgUnitId).toBe(area);
  });

  it("refuses a manager approving outside their subtree", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area, otherArea } = await seedHierarchy(t);
    const manager = await provisionProfile(
      t,
      superAdmin,
      "ds@sunpride.local",
      "manager",
    );
    await assignOrgUnit(t, "ds@sunpride.local", area);

    await expect(
      manager.mutation(internal.lib.capabilities.assertCapability, {
        capability: "mcp.approve",
        targetUnitId: otherArea,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
  });

  it("refuses a seller approving an MCP", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area } = await seedHierarchy(t);
    const seller = await provisionProfile(
      t,
      superAdmin,
      "route-sales@sunpride.local",
      "sales",
    );
    await assignOrgUnit(t, "route-sales@sunpride.local", area);

    await expect(
      seller.mutation(internal.lib.capabilities.assertCapability, {
        capability: "mcp.approve",
        targetUnitId: area,
      }),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("lets an analyst read cross-scope and nothing else", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area, otherArea } = await seedHierarchy(t);
    const analyst = await provisionProfile(
      t,
      superAdmin,
      "finance@sunpride.local",
      "analyst",
    );
    await assignOrgUnit(t, "finance@sunpride.local", area);

    const read = await analyst.mutation(
      internal.lib.capabilities.assertCapability,
      { capability: "report.read", targetUnitId: otherArea },
    );
    expect(read.role).toBe("analyst");

    await expect(
      analyst.mutation(internal.lib.capabilities.assertCapability, {
        capability: "mcp.plan",
        targetUnitId: area,
      }),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("refuses an operations user an admin capability", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area } = await seedHierarchy(t);
    const operations = await provisionProfile(
      t,
      superAdmin,
      "warehouse@sunpride.local",
      "operations",
    );
    await assignOrgUnit(t, "warehouse@sunpride.local", area);

    await expect(
      operations.mutation(internal.lib.capabilities.assertCapability, {
        capability: "admin.manage",
        targetUnitId: area,
      }),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("rejects an unknown capability name", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin } = await seedHierarchy(t);

    await expect(
      superAdmin.mutation(internal.lib.capabilities.assertCapability, {
        capability: "mcp.destroy",
      }),
    ).rejects.toThrow(/Unknown capability/);
  });

  it("refuses a scoped capability for a profile with no organizational scope", async () => {
    const t = convexTest(schema, modules);
    const { superAdmin, area } = await seedHierarchy(t);
    const manager = await provisionProfile(
      t,
      superAdmin,
      "unscoped-manager@sunpride.local",
      "manager",
    );
    await expect(
      manager.mutation(internal.lib.capabilities.assertCapability, {
        capability: "mcp.approve",
        targetUnitId: area,
      }),
    ).rejects.toThrow(/no organizational scope/);
  });
});
