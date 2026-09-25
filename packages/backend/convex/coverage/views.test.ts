import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

const opts = (cursor: string | null = null, numItems = 20) => ({
  cursor,
  numItems,
});
async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const now = Date.now() - 100000;
  const [east, west] = await t.run(
    async (ctx) =>
      [
        await ctx.db.insert("orgUnits", {
          organizationId: "sunpride",
          code: "E",
          name: "E",
          typeCode: "REGION",
          parentId: rootUnitId,
          status: "active",
          effectiveFrom: now,
          createdAt: now,
          updatedAt: now,
        }),
        await ctx.db.insert("orgUnits", {
          organizationId: "sunpride",
          code: "W",
          name: "W",
          typeCode: "REGION",
          parentId: rootUnitId,
          status: "active",
          effectiveFrom: now,
          createdAt: now,
          updatedAt: now,
        }),
      ] as const,
  );
  async function person(
    name: string,
    role: "sales" | "manager",
    unit: Id<"orgUnits">,
  ) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const id = (await actor.query(api.domains.profiles.current, {}))!._id;
    const assignmentId = await t.run(async (ctx) => {
      await ctx.db.patch(id, { name, orgUnitId: unit, role, updatedAt: now });
      for (const row of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", id),
        )
        .collect())
        await ctx.db.delete(row._id);
      return ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId: unit,
        role,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    });
    return { actor, id, assignmentId };
  }
  const seller = await person("seller", "sales", east);
  const manager = await person("manager", "manager", east);
  const foreign = await person("foreign", "sales", west);
  const { territory, owner, outlets } = await t.run(async (ctx) => {
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T",
      name: "T",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const owner = await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: east,
      effectiveFrom: now,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const outlets = [];
    for (let i = 0; i < 7; i++) {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${i}`,
        name: `Outlet ${i}`,
        status: "active",
        custodianOrgUnitId: east,
        createdAt: now,
        updatedAt: now,
        createdBy: "fixture",
      });
      const assignment = await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId: territory,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
      outlets.push({ id, assignment });
    }
    await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "FOREIGN",
      name: "Foreign",
      status: "active",
      custodianOrgUnitId: west,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    return { territory, owner, outlets };
  });
  async function plan(
    version: number,
    status: "draft" | "active",
    assignee = seller,
    withRows = true,
  ) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("coveragePlans", {
        organizationId: "sunpride",
        assigneeProfileId: assignee.id,
        localMonth: "2026-09",
        version,
        cycleType: "monthly",
        orgUnitId: assignee === foreign ? west : east,
        territoryIds: [territory],
        requestedFrom: now,
        requestedTo: now + 86400000,
        effectiveFrom: now,
        effectiveTo: now + 86400000,
        status,
        preparedBy: "fixture",
        preparedAt: now,
        contentRevision: 1,
        createdBy: "fixture",
        createdAt: now,
        updatedBy: "fixture",
        updatedAt: now,
      });
      if (!withRows) return id;
      for (let i = 0; i < 6; i++) {
        const outlet = outlets[i]!;
        await ctx.db.insert("coveragePlanOutlets", {
          planId: id,
          outletId: outlet.id,
          territoryId: territory,
          frequency: "weekly",
          preferredWeekdays: [],
          customLocalDates: [],
          priority: 1,
          expectedDurationMinutes: 20,
          requiredObjectives: [],
          contentRevision: 1,
          updatedBy: "fixture",
          updatedAt: now,
        });
        for (const date of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
          const snapshot = {
            outletId: outlet.id,
            outletCode: `O${i}`,
            outletName: `Outlet ${i}`,
            territoryId: territory,
            territoryCode: "T",
            outletAssignmentId: outlet.assignment,
            territoryOwnershipId: owner,
            employeeAssignmentId: assignee.assignmentId,
            orgUnitId: east,
            activityKind: "outlet_visit",
            approvedAssigneeProfileId: assignee.id,
          };
          const slotId = await ctx.db.insert("coveragePlanSlots", {
            planId: id,
            assigneeProfileId: assignee.id,
            slotKey: `${date}-${i}`,
            serviceDate: date,
            kind: "outlet_visit",
            outletId: outlet.id,
            requiredObjectives: [],
            intents: [],
            sequence: i,
            expectedDurationMinutes: 20,
            approvedSnapshot: status === "active" ? snapshot : undefined,
            contentRevision: 1,
            updatedBy: "fixture",
            updatedAt: now,
          });
          if (status === "active")
            await ctx.db.insert("plannedVisits", {
              generationKey: `${id}-${slotId}`,
              planId: id,
              planVersion: version,
              planSlotId: slotId,
              assigneeProfileId: assignee.id,
              outletId: outlet.id,
              serviceDate: date,
              status: "planned",
              approvedSnapshot: snapshot,
              requiredObjectives: [],
              intents: [],
              expectedDurationMinutes: 20,
              generatedAt: now,
            });
        }
      }
      await ctx.db.insert("coveragePlanSlots", {
        planId: id,
        assigneeProfileId: assignee.id,
        slotKey: "admin",
        serviceDate: "2026-09-30",
        kind: "non_visit",
        activityKind: "Admin",
        requiredObjectives: [],
        intents: [],
        sequence: 7,
        expectedDurationMinutes: 60,
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: now,
      });
      return id;
    });
  }
  return { t, seller, manager, foreign, west, territory, outlets, plan };
}

describe("coverage views", () => {
  it("projects 18 generated visits, not 36 slots plus visits, and preserves non-visit entries", async () => {
    const f = await fixture();
    const id = await f.plan(1, "active");
    await f.t.run(async (ctx) => {
      const positionId = await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "REP",
        label: "Rep",
        category: "field",
        active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(f.seller.assignmentId, { positionId });
      await ctx.db.insert("positionStandards", {
        organizationId: "sunpride",
        positionId,
        effectiveFrom: Date.now() - 100000,
        dailyCallsTarget: 5,
        sourceRef: "fixture",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const first = await f.manager.actor.query(api.coverage.views.calendar, {
      planId: id,
      paginationOpts: opts(),
    });
    const next = await f.manager.actor.query(api.coverage.views.calendar, {
      planId: id,
      paginationOpts: opts(first.continueCursor),
    });
    const rows = [...first.page, ...next.page];
    expect(rows.filter((x) => x.kind === "outlet_visit")).toHaveLength(18);
    expect(rows.filter((x) => x.kind === "non_visit")).toHaveLength(1);
    expect(rows.filter((x) => x.visitStatus === "planned")).toHaveLength(18);
    expect(next.isDone).toBe(true);
    const route = await f.manager.actor.query(api.coverage.views.byRoute, {
      planId: id,
      paginationOpts: opts(),
    });
    expect(route.page[0]).toMatchObject({
      slotCount: 18,
      visitCount: 18,
      coveredCount: 6,
      uncoveredCount: 1,
      routeCode: "No route",
    });
    const load = await f.manager.actor.query(api.coverage.views.workload, {
      localMonth: "2026-09",
      paginationOpts: opts(),
    });
    expect(load.page).toMatchObject([
      {
        version: 1,
        visitCount: 18,
        durationMinutes: 420,
        dailyCallsTarget: 5,
        variance: 3,
        workingDays: ["2026-09-28", "2026-09-29", "2026-09-30"],
      },
    ]);
  });
  it("selects one version, supports empty pages and status filtering", async () => {
    const f = await fixture();
    await f.plan(1, "draft");
    const active = await f.plan(2, "active");
    const result = await f.manager.actor.query(api.coverage.views.workload, {
      localMonth: "2026-09",
      paginationOpts: opts(),
    });
    expect(result.page).toHaveLength(1);
    expect(result.page[0]).toMatchObject({
      planId: active,
      version: 2,
      visitCount: 18,
    });
    const empty = await f.manager.actor.query(api.coverage.views.calendar, {
      planId: active,
      visitStatus: "cancelled",
      paginationOpts: opts(),
    });
    expect(empty.page).toEqual([]);
    expect(empty.isDone).toBe(true);
    const unusedRoute = await f.t.run((ctx) =>
      ctx.db.insert("routes", {
        organizationId: "sunpride",
        code: "EMPTY",
        name: "Empty",
        status: "active",
        effectiveFrom: Date.now() - 100000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "fixture",
      }),
    );
    const filtered = await f.manager.actor.query(api.coverage.views.workload, {
      localMonth: "2026-09",
      routeId: unusedRoute,
      paginationOpts: opts(),
    });
    expect(filtered.page).toEqual([]);
    await f.t.run(async (ctx) => {
      const visit = await ctx.db
        .query("plannedVisits")
        .withIndex("by_planId_and_serviceDate", (q) => q.eq("planId", active))
        .first();
      await ctx.db.patch(visit!._id, { status: "cancelled" });
    });
    const cancelled = await f.manager.actor.query(api.coverage.views.calendar, {
      planId: active,
      visitStatus: "cancelled",
      paginationOpts: opts(),
    });
    expect(cancelled.page).toHaveLength(1);
    expect(
      (
        await f.manager.actor.query(api.coverage.views.byRoute, {
          planId: active,
          paginationOpts: opts(),
        })
      ).page[0]?.visitCount,
    ).toBe(17);
    expect(
      (
        await f.manager.actor.query(api.coverage.views.workload, {
          localMonth: "2026-09",
          paginationOpts: opts(),
        })
      ).page[0]?.visitCount,
    ).toBe(17);
  });
  it("sales sees only own workload and refuses another plan or changed outlet owner", async () => {
    const f = await fixture();
    const id = await f.plan(1, "active");
    await f.plan(1, "draft", f.foreign, false);
    const own = await f.seller.actor.query(api.coverage.views.workload, {
      localMonth: "2026-09",
      paginationOpts: opts(),
    });
    expect(own.page.map((x) => x.assigneeName)).toEqual(["seller"]);
    await expect(
      f.foreign.actor.query(api.coverage.views.calendar, {
        planId: id,
        paginationOpts: opts(),
      }),
    ).rejects.toThrow();
    await f.t.run((ctx) =>
      ctx.db.patch(f.outlets[0]!.id, { custodianOrgUnitId: f.west }),
    );
    // The effective assignment remains east; current persisted ownership, not custodian, governs.
    const assigned = await f.manager.actor.query(api.coverage.views.calendar, {
      planId: id,
      paginationOpts: opts(),
    });
    expect(assigned.page.length).toBeGreaterThan(0);
    await f.t.run(async (ctx) => {
      for (const row of await ctx.db
        .query("outletAssignments")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", f.outlets[0]!.id),
        )
        .collect())
        await ctx.db.delete(row._id);
    });
    await expect(
      f.manager.actor.query(api.coverage.views.calendar, {
        planId: id,
        paginationOpts: opts(),
      }),
    ).rejects.toThrow();
  });
});
