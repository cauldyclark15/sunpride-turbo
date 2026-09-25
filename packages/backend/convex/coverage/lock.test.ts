import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { localDate, manilaDate } from "./validation";

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const month = manilaDate(Date.now() + 40 * 86400000).slice(0, 7);
  const date = `${month}-15`;
  const now = Date.now() - 100000000;
  const [east, west, position] = await t.run(async (ctx) => {
    const unit = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "REGION",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
      });
    return [
      await unit("COV-E"),
      await unit("COV-W"),
      await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "KAS",
        label: "KAS",
        category: "field",
        active: true,
        createdAt: now,
        updatedAt: now,
      }),
    ] as const;
  });
  async function person(
    role: "sales" | "manager" | "admin" | "analyst",
    unit: Id<"orgUnits">,
    name: string,
  ) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const id = (await actor.query(api.domains.profiles.current, {}))!._id;
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { orgUnitId: unit, role, updatedAt: Date.now() });
      for (const prior of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", id),
        )
        .collect())
        await ctx.db.delete(prior._id);
      await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId: unit,
        role,
        positionId: position,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    });
    return { actor, id };
  }
  const sales = await person("sales", east, "cov-sales");
  const other = await person("sales", east, "cov-other");
  const manager = await person("manager", east, "cov-manager");
  const westManager = await person("manager", west, "cov-west-manager");
  const outsider = await person("analyst", east, "cov-analyst");
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("positionStandards", {
      organizationId: "sunpride",
      positionId: position,
      effectiveFrom: now,
      dailyCallsTarget: 5,
      sourceRef: "memo §I",
      createdAt: now,
      updatedAt: now,
    });
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "E",
      name: "East territory",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const westTerritory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "W",
      name: "West territory",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    for (const [territoryId, orgUnitId] of [
      [territory, east],
      [westTerritory, west],
    ] as const)
      await ctx.db.insert("territoryOwnerships", {
        territoryId,
        orgUnitId,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    const route = await ctx.db.insert("routes", {
      organizationId: "sunpride",
      code: "R",
      name: "Route",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const badRoute = await ctx.db.insert("routes", {
      organizationId: "sunpride",
      code: "X",
      name: "Bad Route",
      status: "active",
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    for (const [routeId, territoryId] of [
      [route, territory],
      [badRoute, westTerritory],
    ] as const)
      await ctx.db.insert("routeTerritories", {
        routeId,
        territoryId,
        effectiveFrom: now,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: now,
      });
    await ctx.db.insert("routeSalespeople", {
      routeId: route,
      profileId: sales.id,
      primary: true,
      effectiveFrom: now,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    await ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: sales.id,
      kind: "primary",
      effectiveFrom: now,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const outlet = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "O",
      name: "Outlet",
      status: "active",
      custodianOrgUnitId: east,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const foreign = await ctx.db.insert("outlets", {
      organizationId: "sunpride",
      code: "W-O",
      name: "West",
      status: "active",
      custodianOrgUnitId: west,
      createdAt: now,
      updatedAt: now,
      createdBy: "fixture",
    });
    const outletAssignment = await ctx.db.insert("outletAssignments", {
      outletId: outlet,
      territoryId: territory,
      routeId: route,
      sequence: 1,
      effectiveFrom: now,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    const customer = await ctx.db.insert("customers", {
      code: "C",
      name: "Customer",
      channel: "KA",
      territory: "E",
      creditLimit: 0,
      active: true,
      updatedAt: now,
    });
    const link = await ctx.db.insert("outletCustomerLinks", {
      outletId: outlet,
      customerId: customer,
      source: "fixture",
      effectiveFrom: now,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: now,
    });
    return {
      territory,
      westTerritory,
      route,
      badRoute,
      outlet,
      foreign,
      outletAssignment,
      customer,
      link,
    };
  });
  async function create() {
    return sales.actor.mutation(api.coverage.plans.create, {
      assigneeProfileId: sales.id,
      localMonth: month,
    });
  }
  const slot = (routeId: Id<"routes"> = ids.route) => ({
    slotKey: "visit-1",
    serviceDate: date,
    kind: "outlet_visit" as const,
    outletId: ids.outlet,
    routeId,
    activityKind: "sell",
    requiredObjectives: ["merchandise"],
    intents: ["sell"],
    sequence: 1,
    expectedDurationMinutes: 30,
  });
  async function schedule(planId: Id<"coveragePlans">, routeId = ids.route) {
    await sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId,
      slots: [slot(routeId)],
    });
    await sales.actor.mutation(api.coverage.plans.submit, { planId });
  }
  return {
    t,
    root,
    east,
    west,
    position,
    month,
    date,
    sales,
    other,
    manager,
    westManager,
    outsider,
    person,
    ...ids,
    create,
    slot,
    schedule,
  };
}

describe("approved coverage lock and pending assignments", () => {
  it("refuses assign, batch, reorder and route move without writing; permits edits after the plan interval", async () => {
    const f = await setup();
    const plan = await f.create();
    await f.schedule(plan._id);
    await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: plan._id,
    });
    const target = {
      outletId: f.outlet,
      territoryId: f.territory,
      routeId: f.route,
      sequence: 2,
      effectiveFrom: plan.effectiveFrom,
      reason: "Adjust",
    };
    const state = () =>
      f.t.run(async (ctx) => ({
        assignments: await ctx.db
          .query("outletAssignments")
          .withIndex("by_outletId_and_effectiveFrom", (q) =>
            q.eq("outletId", f.outlet),
          )
          .collect(),
        route: await ctx.db.get(f.route),
        slot: await ctx.db
          .query("coveragePlanSlots")
          .withIndex("by_planId_and_serviceDate", (q) =>
            q.eq("planId", plan._id),
          )
          .first(),
      }));
    const before = await state();
    await expect(
      f.root.mutation(api.outlets.assignments.assign, target),
    ).rejects.toThrow(/Revise the approved coverage plan first/);
    await expect(
      f.root.mutation(api.outlets.assignments.batchAssign, {
        assignments: [
          {
            outletId: f.outlet,
            territoryId: f.territory,
            routeId: f.route,
            sequence: 2,
          },
        ],
        effectiveFrom: plan.effectiveFrom,
        reason: "Adjust",
      }),
    ).rejects.toThrow(/Revise the approved coverage plan first/);
    await expect(
      f.root.mutation(api.outlets.assignments.reorder, {
        routeId: f.route,
        outletIds: [f.outlet],
        effectiveFrom: plan.effectiveFrom,
        reason: "Adjust",
      }),
    ).rejects.toThrow(/Revise the approved coverage plan first/);
    await expect(
      f.root.mutation(api.territories.routes.move, {
        routeId: f.route,
        territoryId: f.westTerritory,
        effectiveFrom: plan.effectiveFrom,
        reason: "Adjust",
      }),
    ).rejects.toThrow(/Revise the approved coverage plan first/);
    const salesperson = await f.t.run((ctx) =>
      ctx.db
        .query("routeSalespeople")
        .withIndex("by_routeId_and_effectiveFrom", (q) =>
          q.eq("routeId", f.route),
        )
        .first(),
    );
    await expect(
      f.root.mutation(api.territories.routes.endSalespersonAssignment, {
        assignmentId: salesperson!._id,
        effectiveTo: plan.effectiveFrom,
        reason: "End",
      }),
    ).rejects.toThrow(/Revise the approved coverage plan first/);
    expect(await state()).toEqual(before);
    await f.root.mutation(api.outlets.assignments.assign, {
      ...target,
      effectiveFrom: plan.effectiveTo + 1000,
    });
    expect((await state()).assignments).toHaveLength(2);
    expect((await state()).slot?.approvedSnapshot).toEqual(
      before.slot?.approvedSnapshot,
    );
  });
  it("replaces an unapproved future assignment with an auditable zero-length tombstone", async () => {
    const f = await setup();
    const from = localDate(f.date);
    const old = await f.root.mutation(api.outlets.assignments.assign, {
      outletId: f.outlet,
      territoryId: f.territory,
      routeId: f.route,
      sequence: 2,
      effectiveFrom: from,
      reason: "Original",
    });
    const replacement = await f.root.mutation(api.outlets.assignments.assign, {
      outletId: f.outlet,
      territoryId: f.territory,
      routeId: f.route,
      sequence: 3,
      effectiveFrom: from,
      reason: "Replace pending",
    });
    const history = await f.root.query(api.outlets.assignments.history, {
      outletId: f.outlet,
    });
    expect(history.find((row) => row._id === old)).toMatchObject({
      effectiveFrom: from,
      effectiveTo: from,
    });
    expect(history.find((row) => row._id === replacement)?.sequence).toBe(3);
    const audit = await f.t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(
      audit.some((row) => row.action === "outlet.pending_assignment_replaced"),
    ).toBe(true);
  });
});
