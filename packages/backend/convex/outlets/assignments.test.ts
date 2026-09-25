import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
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
  const now = Date.now() - 100000;
  const [east, west] = await t.run(async (ctx) => {
    const make = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "REGION",
        parentId: rootUnitId,
        status: "active" as const,
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
      });
    return [await make("D-EAST"), await make("D-WEST")] as const;
  });
  const from = Date.now() + 2000;
  const eastTerritory = await root.mutation(api.territories.mutations.create, {
    code: "D-E",
    name: "East",
    orgUnitId: east,
    effectiveFrom: from,
    reason: "coverage",
  });
  const westTerritory = await root.mutation(api.territories.mutations.create, {
    code: "D-W",
    name: "West",
    orgUnitId: west,
    effectiveFrom: from,
    reason: "coverage",
  });
  await t.run(async (ctx) => {
    for (const id of [eastTerritory, westTerritory]) {
      await ctx.db.patch(id, { effectiveFrom: now });
      const owner = await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", id),
        )
        .first();
      await ctx.db.patch(owner!._id, { effectiveFrom: now });
    }
  });
  const route = await root.mutation(api.territories.routes.create, {
    territoryId: eastTerritory,
    code: "D-R",
    name: "Route",
    effectiveFrom: from,
    reason: "coverage",
  });
  const outlet = async (code: string, custodianOrgUnitId = east) =>
    root.mutation(api.outlets.mutations.create, {
      code,
      name: code,
      custodianOrgUnitId,
      status: "active",
      reason: "site",
    });
  return {
    t,
    root,
    east,
    west,
    eastTerritory,
    westTerritory,
    route,
    from,
    outlet,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function admin(f: Fixture, unitId: Id<"orgUnits">, suffix: string) {
  const email = `${suffix}@example.test`;
  await f.root.mutation(api.domains.profiles.invite, { email, role: "admin" });
  const user = f.t.withIdentity({ subject: suffix, email });
  await user.mutation(api.domains.profiles.ensure, {});
  const id = (await user.query(api.domains.profiles.current, {}))!._id;
  await f.t.run((ctx) =>
    ctx.db.patch(id, {
      orgUnitId: unitId,
      role: "admin",
      updatedAt: Date.now(),
    }),
  );
  return user;
}
const args = (
  f: Fixture,
  outletId: Id<"outlets">,
  sequence: number,
  effectiveFrom = f.from + 1000,
) => ({
  outletId,
  territoryId: f.eastTerritory,
  routeId: f.route,
  sequence,
  effectiveFrom,
  reason: "route coverage",
});

describe("effective-dated outlet assignments", () => {
  it("appends a scoped mobile invalidation for an affected planned-visit owner", async () => {
    const f = await setup();
    const outletId = await f.outlet("D-FEED");
    const firstAssignment = await f.root.mutation(
      api.outlets.assignments.assign,
      {
        outletId,
        territoryId: f.eastTerritory,
        effectiveFrom: f.from + 1000,
        reason: "first",
      },
    );
    const owner = (await f.root.query(api.domains.profiles.current, {}))!._id;
    await f.t.run(async (ctx) => {
      const now = Date.now();
      const planId = await ctx.db.insert("coveragePlans", {
        organizationId: "sunpride",
        assigneeProfileId: owner,
        localMonth: "2026-09",
        version: 1,
        cycleType: "monthly",
        orgUnitId: f.east,
        territoryIds: [f.eastTerritory],
        requestedFrom: now,
        requestedTo: now + 86400000,
        effectiveFrom: now,
        effectiveTo: now + 86400000,
        status: "draft",
        preparedBy: "issuer|root",
        preparedAt: now,
        contentRevision: 1,
        createdBy: "issuer|root",
        createdAt: now,
        updatedBy: "issuer|root",
        updatedAt: now,
      });
      const slotId = await ctx.db.insert("coveragePlanSlots", {
        slotKey: "feed",
        planId,
        assigneeProfileId: owner,
        serviceDate: "2026-09-30",
        kind: "outlet_visit",
        outletId,
        requiredObjectives: [],
        intents: [],
        sequence: 1,
        expectedDurationMinutes: 30,
        contentRevision: 1,
        updatedBy: "issuer|root",
        updatedAt: now,
      });
      const assignment = await ctx.db.get(firstAssignment);
      const ownership = await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", f.eastTerritory),
        )
        .first();
      const employee = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", owner),
        )
        .first();
      await ctx.db.insert("plannedVisits", {
        generationKey: "feed",
        planId,
        planVersion: 1,
        planSlotId: slotId,
        assigneeProfileId: owner,
        outletId,
        serviceDate: "2026-09-30",
        status: "planned",
        approvedSnapshot: {
          outletId,
          outletCode: "D-FEED",
          outletName: "D-FEED",
          territoryId: f.eastTerritory,
          territoryCode: "D-E",
          outletAssignmentId: assignment!._id,
          territoryOwnershipId: ownership!._id,
          employeeAssignmentId: employee!._id,
          orgUnitId: f.east,
          activityKind: "outlet_visit",
          approvedAssigneeProfileId: owner,
        },
        requiredObjectives: [],
        intents: [],
        expectedDurationMinutes: 30,
        generatedAt: now,
      });
    });
    await f.root.mutation(api.outlets.assignments.assign, {
      outletId,
      territoryId: f.westTerritory,
      effectiveFrom: f.from + 2000,
      reason: "transfer",
    });
    const changes = await f.t.run((ctx) =>
      ctx.db.query("mobileChanges").collect(),
    );
    expect(changes).toMatchObject([
      { entity: "outletAssignment", ownerProfileId: owner, orgUnitId: f.east },
    ]);
  });
  it("gates the source owner at the effective date as well as current custodian scope", async () => {
    const f = await setup();
    const id = await f.outlet("D-OWNER");
    await f.root.mutation(api.outlets.assignments.assign, {
      outletId: id,
      territoryId: f.eastTerritory,
      effectiveFrom: f.from + 1000,
      reason: "east",
    });
    await f.t.run(async (ctx) => {
      const owner = await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", f.eastTerritory),
        )
        .first();
      await ctx.db.patch(owner!._id, { effectiveTo: f.from + 2000 });
      await ctx.db.insert("territoryOwnerships", {
        territoryId: f.eastTerritory,
        orgUnitId: f.west,
        effectiveFrom: f.from + 2000,
        actorSubject: "fixture",
        reason: "future transfer",
        createdAt: Date.now(),
      });
    });
    const east = await admin(f, f.east, "d-owner");
    await expect(
      east.mutation(api.outlets.assignments.assign, {
        outletId: id,
        territoryId: f.westTerritory,
        effectiveFrom: f.from + 3000,
        reason: "renumber",
      }),
    ).rejects.toThrow(/scope/);
    expect(
      await f.root.query(api.outlets.assignments.history, { outletId: id }),
    ).toHaveLength(1);
    expect(
      await east.query(api.outlets.assignments.territoryRoster, {
        territoryId: f.eastTerritory,
        asOf: f.from + 3000,
      }),
    ).toEqual([]);
    expect(
      await f.root.query(api.outlets.assignments.territoryRoster, {
        territoryId: f.eastTerritory,
        asOf: f.from + 3000,
      }),
    ).toHaveLength(1);
  });
  it("rejects cross-region source and destination without writes", async () => {
    const f = await setup();
    const id = await f.outlet("D-SOURCE");
    const east = await admin(f, f.east, "d-east");
    const west = await admin(f, f.west, "d-west");
    await expect(
      east.mutation(api.outlets.assignments.assign, {
        outletId: id,
        territoryId: f.westTerritory,
        effectiveFrom: f.from + 1000,
        reason: "move",
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      west.mutation(api.outlets.assignments.assign, {
        outletId: id,
        territoryId: f.westTerritory,
        effectiveFrom: f.from + 1000,
        reason: "move",
      }),
    ).rejects.toThrow(/scope/);
    expect(
      await f.root.query(api.outlets.assignments.history, { outletId: id }),
    ).toEqual([]);
  });
  it("rejects a route outside the destination territory and future sequence collisions", async () => {
    const f = await setup();
    const first = await f.outlet("D-FIRST"),
      second = await f.outlet("D-SECOND");
    await expect(
      f.root.mutation(api.outlets.assignments.assign, {
        ...args(f, first, 1),
        territoryId: f.westTerritory,
      }),
    ).rejects.toThrow(/Route not in/);
    await f.root.mutation(
      api.outlets.assignments.assign,
      args(f, first, 1, f.from + 100000),
    );
    await expect(
      f.root.mutation(api.outlets.assignments.assign, args(f, second, 1)),
    ).rejects.toThrow(/collision/);
    expect(
      await f.root.query(api.outlets.assignments.history, { outletId: second }),
    ).toEqual([]);
  });
  it("atomically reorders all stops and preserves history as-of", async () => {
    const f = await setup();
    const a = await f.outlet("D-A"),
      b = await f.outlet("D-B");
    await f.root.mutation(api.outlets.assignments.assign, args(f, a, 1));
    await f.root.mutation(api.outlets.assignments.assign, args(f, b, 2));
    const at = f.from + 2000;
    await expect(
      f.root.mutation(api.outlets.assignments.reorder, {
        routeId: f.route,
        outletIds: [a],
        effectiveFrom: at,
        reason: "swap",
      }),
    ).rejects.toThrow(/all stops/);
    await f.root.mutation(api.outlets.assignments.reorder, {
      routeId: f.route,
      outletIds: [b, a],
      effectiveFrom: at,
      reason: "swap",
    });
    expect(
      (
        await f.root.query(api.outlets.assignments.routeStops, {
          routeId: f.route,
          asOf: at,
        })
      ).map((row) => row.outletId),
    ).toEqual([b, a]);
    expect(
      (
        await f.root.query(api.outlets.assignments.routeStops, {
          routeId: f.route,
          asOf: at - 1,
        })
      ).map((row) => row.outletId),
    ).toEqual([a, b]);
    expect(
      (
        await f.root.query(api.outlets.assignments.history, {
          outletId: a,
          asOf: at - 1,
        })
      ).map((row) => row.sequence),
    ).toEqual([1]);
    expect(
      (
        await f.root.query(api.outlets.assignments.history, {
          outletId: a,
          asOf: at,
        })
      ).map((row) => row.sequence),
    ).toEqual([2]);
  });
  it("batch is all-or-nothing for an inaccessible outlet, and audits each successful outlet", async () => {
    const f = await setup();
    const a = await f.outlet("D-BA"),
      b = await f.outlet("D-BB"),
      inaccessible = await f.outlet("D-WB", f.west);
    const east = await admin(f, f.east, "d-batch");
    const choice = (outletId: Id<"outlets">, sequence: number) => ({
      outletId,
      territoryId: f.eastTerritory,
      routeId: f.route,
      sequence,
    });
    await expect(
      east.mutation(api.outlets.assignments.batchAssign, {
        assignments: [choice(a, 1), choice(inaccessible, 2)],
        effectiveFrom: f.from + 1000,
        reason: "batch",
      }),
    ).rejects.toThrow(/scope/);
    expect(
      await f.root.query(api.outlets.assignments.history, { outletId: a }),
    ).toEqual([]);
    await east.mutation(api.outlets.assignments.batchAssign, {
      assignments: [choice(a, 1), choice(b, 2)],
      effectiveFrom: f.from + 1000,
      reason: "batch",
    });
    const audits = await f.t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(
      audits.filter(
        (row) =>
          row.action === "outlet.assignment_changed" &&
          [a, b].includes(row.entityId as Id<"outlets">),
      ),
    ).toHaveLength(2);
    expect(
      (
        await f.root.query(api.outlets.assignments.history, {
          outletId: a,
          asOf: f.from + 1000,
        })
      ).map((row) => row.sequence),
    ).toEqual([1]);
  });
});
