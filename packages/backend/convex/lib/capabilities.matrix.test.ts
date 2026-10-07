import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  CAPABILITIES,
  type Capability,
  isReadOnlyCapability,
  TESTER_FEEDBACK_CAPABILITIES,
} from "./capabilities";
import type { AppRole } from "./roles";

/**
 * QSR-006 role × capability × organizational-level matrix.
 *
 * `EXPECTED` restates `docs/architecture/RBAC_SCOPE_MATRIX.md` independently of
 * `CAPABILITIES`, so a silent grant change fails here until the documented matrix
 * changes with it. The runtime half then proves every grant at five organizational
 * levels (national, region, area, supervisor unit, field unit) against the caller's
 * own unit, a descendant, an ancestor and a sibling region, and after a reorg.
 */
const ROLES: readonly AppRole[] = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
];

// Columns: super_admin admin operations manager approver sales analyst viewer.
// "x" = role holds the capability (G/T/O in the documented matrix), "-" = denied.
const EXPECTED: Record<Capability, string> = {
  "admin.manage": "xx------",
  "org.read": "xxxxxxxx",
  "people.read": "xx-x--xx",
  "territory.read": "xxxxxxxx",
  "route.read": "xxxxxxxx",
  "outlet.read": "xxxxxxxx",
  "territory.manage": "xx------",
  "route.manage": "xxx-----",
  "outlet.manage": "xxx-----",
  "outlet.verify": "xx-x----",
  "outlet.enrol.propose": "x--x-x--",
  "outlet.enrol.approve": "x--x----",
  "outlet.assign": "xxx-----",
  "masterdata.manage": "xxx-----",
  "inventory.read": "xxxxxxxx",
  "inventory.write": "xxx-----",
  "inventory.approve": "x---x---",
  "inventory.adjustment.request": "xxxx----",
  "inventory.count.submit": "xxxx----",
  "inventory.adjustment.approve": "xx-xx---",
  "inventory.count.approve": "xx-xx---",
  "mcp.read": "xxxxxxxx",
  "mcp.plan": "xx-x-x--",
  "mcp.approve": "x--x----",
  "visit.record": "x--x-x--",
  "visit.locationException.approve": "x--x----",
  "visit.read": "xxxxxxxx",
  "order.create": "x--x-x--",
  "order.approve": "x--xx---",
  "order.encode": "xxx-----",
  "deliverable.submit": "x--x-x--",
  "deliverable.review": "x--x----",
  "perdiem.submit": "x--x-x--",
  "perdiem.approve": "x--xx---",
  "report.read": "xxxxxxxx",
  "target.manage": "xx-x----",
  "integration.read": "xxx-----",
  "integration.manage": "xx------",
  "issues.read": "xxxxxxxx",
  "issues.write": "xxxxxxxx",
  "issues.triage": "xxxxx---",
  "issues.manage": "xx------",
  "van.read": "xxxxxxxx",
  "van.manage": "xxx-----",
  "van.operate": "x--x-x--",
  "van.load.approve": "x--xx---",
  "van.void.approve": "x--xx---",
  "van.cash.approve": "x--xx---",
  "van.stock.approve": "x--xx---",
};

const granted = (capability: Capability, role: AppRole) =>
  EXPECTED[capability][ROLES.indexOf(role)] === "x";

type T = TestConvex<typeof schema>;
const LEVELS = ["national", "region", "area", "supervisor", "field"] as const;
type Level = (typeof LEVELS)[number];

async function hierarchy() {
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const since = Date.now() - 86_400_000;
  const units = await t.run(async (ctx) => {
    const unit = (code: string, typeCode: string, parentId: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode,
        parentId,
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
      });
    const region = await unit("VIS", "REGION", rootUnitId);
    const area = await unit("VIS-CEBU", "AREA", region);
    const supervisor = await unit("VIS-CEBU-DS1", "TEAM", area);
    const field = await unit("VIS-CEBU-DS1-PSR1", "TERRITORY", supervisor);
    const sibling = await unit("MIN", "REGION", rootUnitId);
    const siblingArea = await unit("MIN-DVO", "AREA", sibling);
    return {
      national: rootUnitId,
      region,
      area,
      supervisor,
      field,
      sibling,
      siblingArea,
    };
  });
  let n = 0;
  async function person(role: AppRole, orgUnitId: Id<"orgUnits"> | null) {
    if (role === "super_admin") return root;
    const email = `matrix-${n++}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: email, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      await ctx.db.patch(profile!._id, {
        role,
        orgUnitId: orgUnitId ?? undefined,
      });
    });
    return actor;
  }
  return { t, units, person };
}

async function allowed(
  actor: ReturnType<T["withIdentity"]>,
  capability: Capability,
  targetUnitId?: Id<"orgUnits">,
) {
  try {
    await actor.mutation(internal.lib.capabilities.assertCapability, {
      capability,
      ...(targetUnitId ? { targetUnitId } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

const capabilities = Object.keys(CAPABILITIES) as Capability[];

describe("role × capability matrix (QSR-006)", () => {
  it("grants exactly the documented matrix, and nothing undocumented", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...capabilities].sort());
    for (const capability of capabilities)
      for (const role of ROLES)
        expect(
          role === "super_admin" ||
            (CAPABILITIES[capability] as readonly string[]).includes(role),
          `${capability} for ${role}`,
        ).toBe(granted(capability, role));
  });

  it("keeps every cross-scope analyst grant read-only and viewer write-free", () => {
    for (const capability of capabilities) {
      // Beta (SP-0123): filing tester feedback is the one listed, unscoped exception.
      if (TESTER_FEEDBACK_CAPABILITIES.includes(capability)) continue;
      if (granted(capability, "analyst"))
        expect(isReadOnlyCapability(capability), capability).toBe(true);
      if (granted(capability, "viewer"))
        expect(isReadOnlyCapability(capability), capability).toBe(true);
    }
  });

  it(
    "enforces each grant at five organizational levels, never upward or sideways",
    { timeout: 120_000 },
    async () => {
      const { units, person } = await hierarchy();
      const below: Record<Level, Id<"orgUnits"> | null> = {
        national: units.region,
        region: units.area,
        area: units.supervisor,
        supervisor: units.field,
        field: null,
      };
      const above: Record<Level, Id<"orgUnits"> | null> = {
        national: null,
        region: units.national,
        area: units.region,
        supervisor: units.area,
        field: units.supervisor,
      };
      const failures: string[] = [];
      for (const role of ROLES.filter((r) => r !== "super_admin"))
        for (const level of LEVELS) {
          if (role === "analyst" && level !== "field") continue;
          const actor = (await person(role, units[level])) as ReturnType<
            T["withIdentity"]
          >;
          for (const capability of capabilities) {
            const has = granted(capability, role);
            const global = role === "analyst";
            const check = async (
              label: string,
              target: Id<"orgUnits"> | null | undefined,
              expected: boolean,
            ) => {
              if (target === null) return;
              const got = await allowed(actor, capability, target);
              if (got !== expected)
                failures.push(
                  `${role}@${level} ${capability} ${label}: expected ${expected}, got ${got}`,
                );
            };
            await check("role only", undefined, has);
            await check("own unit", units[level], has);
            await check("descendant", below[level], has);
            await check("ancestor", above[level], has && global);
            await check(
              "sibling region",
              level === "national" ? null : units.sibling,
              has && global,
            );
          }
        }
      expect(failures).toEqual([]);
    },
  );

  it("super admin holds every capability everywhere", async () => {
    const { units, person } = await hierarchy();
    const root = (await person("super_admin", null)) as ReturnType<
      T["withIdentity"]
    >;
    for (const capability of capabilities)
      for (const target of [undefined, units.national, units.siblingArea])
        expect(await allowed(root, capability, target), capability).toBe(true);
  });

  it("an unassigned profile holds no scoped access", async () => {
    const { units, person } = await hierarchy();
    for (const role of ["admin", "manager", "sales", "viewer"] as const) {
      const actor = (await person(role, null)) as ReturnType<T["withIdentity"]>;
      for (const capability of capabilities)
        expect(
          await allowed(actor, capability, units.field),
          `${role} ${capability}`,
        ).toBe(false);
    }
  });

  it("scope follows a reorg: a moved area leaves its old region's reach", async () => {
    const { t, units, person } = await hierarchy();
    const regional = (await person("manager", units.region)) as ReturnType<
      T["withIdentity"]
    >;
    const otherRegional = (await person(
      "manager",
      units.sibling,
    )) as ReturnType<T["withIdentity"]>;
    expect(await allowed(regional, "mcp.approve", units.field)).toBe(true);
    expect(await allowed(otherRegional, "mcp.approve", units.field)).toBe(
      false,
    );
    await t.run((ctx) =>
      ctx.db.patch(units.area, {
        parentId: units.sibling,
        updatedAt: Date.now(),
      }),
    );
    expect(await allowed(regional, "mcp.approve", units.field)).toBe(false);
    expect(await allowed(otherRegional, "mcp.approve", units.field)).toBe(true);
  });
});
