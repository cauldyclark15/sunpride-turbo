import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const from = Date.now() + 10000;
  const a = await root.mutation(api.org.mutations.create, {
    code: "EAST",
    name: "East",
    typeCode: "REGION",
    parentId: rootUnitId,
    effectiveFrom: from,
    reason: "New unit",
  });
  const b = await root.mutation(api.org.mutations.create, {
    code: "WEST",
    name: "West",
    typeCode: "REGION",
    parentId: rootUnitId,
    effectiveFrom: from,
    reason: "New unit",
  });
  // Current projections are needed for authorization now; advance insertion's start in the test fixture.
  await t.run(async (ctx) => {
    for (const id of [a, b]) {
      await ctx.db.patch(id, {
        effectiveFrom: Date.now() - 10,
        parentId: rootUnitId,
      });
      const edge = await ctx.db
        .query("orgUnitParentEdges")
        .withIndex("by_unitId_and_effectiveFrom", (q) => q.eq("unitId", id))
        .first();
      if (edge)
        await ctx.db.patch(edge._id, { effectiveFrom: Date.now() - 10 });
    }
  });
  return { t, root, a, b };
}

async function person(
  t: Awaited<ReturnType<typeof setup>>["t"],
  root: Awaited<ReturnType<typeof setup>>["root"],
  email: string,
  role: "admin" | "manager" | "viewer" | "sales",
) {
  await root.mutation(api.domains.profiles.invite, { email, role });
  const actor = t.withIdentity({ subject: email, email });
  await actor.mutation(api.domains.profiles.ensure, {});
  return actor;
}

describe("current-scope people history reads", () => {
  it("hides out-of-area ancestors from supervisor picker and historical assignments", async () => {
    const { t, root, a, b } = await setup();
    const regional = await person(t, root, "regional@example.test", "admin");
    const outsider = await person(t, root, "outside@example.test", "manager");
    const target = await person(t, root, "target@example.test", "viewer");
    const regionalId = (await regional.query(api.domains.profiles.current, {}))!
      ._id;
    const outsiderId = (await outsider.query(api.domains.profiles.current, {}))!
      ._id;
    const targetId = (await target.query(api.domains.profiles.current, {}))!
      ._id;
    await root.mutation(api.people.mutations.assign, {
      profileId: regionalId,
      orgUnitId: a,
      role: "admin",
      reason: "scope",
    });
    await root.mutation(api.people.mutations.assign, {
      profileId: outsiderId,
      orgUnitId: b,
      role: "manager",
      reason: "scope",
    });
    await root.mutation(api.people.mutations.assign, {
      profileId: targetId,
      orgUnitId: b,
      role: "viewer",
      reason: "first",
    });
    await root.mutation(api.people.mutations.assign, {
      profileId: targetId,
      orgUnitId: a,
      role: "viewer",
      reason: "move",
    });
    const history = await regional.query(api.people.queries.history, {
      profileId: targetId,
    });
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((row) => row.orgUnitId === a)).toBe(true);
    await t.run(async (ctx) => {
      const national = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", "jcing.jc@gmail.com"))
        .unique();
      if (!national) throw new Error("Missing national profile");
      const rootUnit = await ctx.db
        .query("orgUnits")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", "sunpride").eq("code", "SUNPRIDE"),
        )
        .unique();
      if (!rootUnit) throw new Error("Missing root unit");
      await ctx.db.patch(national._id, { orgUnitId: rootUnit._id });
    });
    const options = await regional.query(api.people.queries.supervisorOptions, {
      orgUnitId: a,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    expect(options.page.map((row) => row._id)).toContain(regionalId);
    expect(options.page.map((row) => row._id)).not.toContain(outsiderId);
    expect(options.page.every((row) => row.orgUnitId === a)).toBe(true);
  });
});

describe("person assignment history and scope", () => {
  it("moves atomically and retains half-open history, actor and audit", async () => {
    const { t, root, a, b } = await setup();
    const employee = await person(t, root, "employee@example.test", "viewer");
    const id = (await employee.query(api.domains.profiles.current, {}))!._id;
    await root.mutation(api.people.mutations.assign, {
      profileId: id,
      orgUnitId: a,
      role: "viewer",
      reason: "hire",
    });
    await root.mutation(api.people.mutations.assign, {
      profileId: id,
      orgUnitId: b,
      role: "sales",
      reason: "move",
    });
    const history = await root.query(api.people.queries.history, {
      profileId: id,
    });
    expect(history).toHaveLength(3);
    expect(history[1]!.effectiveTo).toBe(history[2]!.effectiveFrom);
    expect(history[2]!.orgUnitId).toBe(b);
    expect(history[2]!.actorSubject).toBeTruthy();
    expect(
      (await employee.query(api.domains.profiles.current, {}))?.orgUnitId,
    ).toBe(b);
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "profile").eq("entityId", id),
        )
        .collect(),
    );
    expect(audit.some((e) => e.action === "person.assigned")).toBe(true);
  });
  it("rejects cross-region pulls, unassigned admins, and viewer writes", async () => {
    const { t, root, a, b } = await setup();
    const admin = await person(t, root, "east@example.test", "admin");
    const viewer = await person(t, root, "west@example.test", "viewer");
    const adminId = (await admin.query(api.domains.profiles.current, {}))!._id;
    const viewerId = (await viewer.query(api.domains.profiles.current, {}))!
      ._id;
    await expect(
      admin.mutation(api.people.mutations.assign, {
        profileId: viewerId,
        orgUnitId: a,
        role: "viewer",
        reason: "pull",
      }),
    ).rejects.toThrow(/scope/);
    await root.mutation(api.people.mutations.assign, {
      profileId: adminId,
      orgUnitId: a,
      role: "admin",
      reason: "assign",
    });
    await root.mutation(api.people.mutations.assign, {
      profileId: viewerId,
      orgUnitId: b,
      role: "viewer",
      reason: "assign",
    });
    await expect(
      admin.mutation(api.people.mutations.assign, {
        profileId: viewerId,
        orgUnitId: a,
        role: "viewer",
        reason: "pull",
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      viewer.mutation(api.people.mutations.assign, {
        profileId: viewerId,
        orgUnitId: b,
        role: "viewer",
        reason: "write",
      }),
    ).rejects.toThrow(/permission/);
    expect(
      (
        await admin.query(api.people.queries.list, {
          paginationOpts: { cursor: null, numItems: 20 },
        })
      ).page.map((p) => p._id),
    ).not.toContain(viewerId);
  });
  it("rejects supervisor loops and immutable or duplicate employee codes", async () => {
    const { t, root, a } = await setup();
    const first = await person(t, root, "first@example.test", "viewer");
    const second = await person(t, root, "second@example.test", "viewer");
    const firstId = (await first.query(api.domains.profiles.current, {}))!._id;
    const secondId = (await second.query(api.domains.profiles.current, {}))!
      ._id;
    await root.mutation(api.people.mutations.assign, {
      profileId: firstId,
      orgUnitId: a,
      role: "viewer",
      employeeCode: "E-001",
      reason: "hire",
    });
    await root.mutation(api.people.mutations.assign, {
      profileId: secondId,
      orgUnitId: a,
      role: "viewer",
      reason: "hire",
    });
    await expect(
      root.mutation(api.people.mutations.assign, {
        profileId: firstId,
        orgUnitId: a,
        role: "viewer",
        supervisorId: firstId,
        reason: "loop",
      }),
    ).rejects.toThrow(/cycle/);
    await expect(
      root.mutation(api.people.mutations.assign, {
        profileId: secondId,
        orgUnitId: a,
        role: "viewer",
        employeeCode: "E-001",
        reason: "duplicate",
      }),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      root.mutation(api.people.mutations.assign, {
        profileId: firstId,
        orgUnitId: a,
        role: "viewer",
        employeeCode: "E-002",
        reason: "rename",
      }),
    ).rejects.toThrow(/immutable/);
  });
  it("limits supervisor options to the current ancestor chain, role and prefix", async () => {
    const { t, root, a, b } = await setup();
    const east = await person(t, root, "east.manager@example.test", "manager");
    const west = await person(t, root, "west.manager@example.test", "manager");
    const viewer = await person(t, root, "east.viewer@example.test", "viewer");
    const sales = await person(t, root, "east.sales@example.test", "sales");
    const eastId = (await east.query(api.domains.profiles.current, {}))!._id;
    const westId = (await west.query(api.domains.profiles.current, {}))!._id;
    for (const [id, unit, role] of [
      [eastId, a, "manager"],
      [westId, b, "manager"],
      [
        (await viewer.query(api.domains.profiles.current, {}))!._id,
        a,
        "viewer",
      ],
      [(await sales.query(api.domains.profiles.current, {}))!._id, a, "sales"],
    ] as const)
      await root.mutation(api.people.mutations.assign, {
        profileId: id,
        orgUnitId: unit,
        role,
        reason: "placement",
      });
    await t.run((ctx) => ctx.db.patch(eastId, { employeeCode: "MGR-001" }));
    const page = { cursor: null, numItems: 50 };
    const all = await root.query(api.people.queries.supervisorOptions, {
      orgUnitId: a,
      paginationOpts: page,
    });
    expect(all.page.map((p) => p._id)).toContain(eastId);
    const rootProfile = (await root.query(api.domains.profiles.current, {}))!;
    expect(all.page.map((p) => p._id)).toContain(rootProfile._id);
    expect(all.page.map((p) => p._id)).not.toContain(westId);
    expect(
      all.page.every((p) =>
        ["manager", "admin", "super_admin"].includes(p.role),
      ),
    ).toBe(true);
    for (const search of ["EAST.MAN", "east.manager@", "mgr-"]) {
      const matches = await root.query(api.people.queries.supervisorOptions, {
        orgUnitId: a,
        search,
        paginationOpts: page,
      });
      expect(matches.page.map((p) => p._id)).toEqual([eastId]);
    }
    await expect(
      east.query(api.people.queries.supervisorOptions, {
        orgUnitId: b,
        paginationOpts: page,
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      sales.query(api.people.queries.supervisorOptions, {
        orgUnitId: a,
        paginationOpts: page,
      }),
    ).rejects.toThrow(/permission/);
    await expect(
      root.query(api.people.queries.supervisorOptions, {
        orgUnitId: a,
        paginationOpts: { cursor: null, numItems: 51 },
      }),
    ).rejects.toThrow(/Page size/);
  });
});
