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
      expect(capability).toMatch(/^[a-z]+\.[a-z]+$/);
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
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) =>
          q.eq("email", "unscoped-manager@sunpride.local"),
        )
        .unique();
      if (!profile) throw new Error("profile not found");
      await ctx.db.patch(profile._id, {
        orgUnitId: undefined,
        updatedAt: Date.now(),
      });
    });

    await expect(
      manager.mutation(internal.lib.capabilities.assertCapability, {
        capability: "mcp.approve",
        targetUnitId: area,
      }),
    ).rejects.toThrow(/no organizational scope/);
  });
});
