import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { localDate, manilaDate, monthBounds, monthDates } from "./validation";

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

describe("coverage activation", () => {
  it("refuses future approved plans, then activates once due and generates only signed outlet visits", async () => {
    const f = await setup();
    const plan = await f.create();
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [
        f.slot(),
        {
          slotKey: "admin",
          serviceDate: f.date,
          kind: "non_visit",
          activityKind: "admin",
          requiredObjectives: [],
          intents: [],
          sequence: 2,
          expectedDurationMinutes: 20,
        },
      ],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: plan._id,
    });
    await expect(
      f.manager.actor.mutation(api.coverage.activation.activate, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/not yet effective/);
    expect((await f.t.run((ctx) => ctx.db.get(plan._id)))?.status).toBe(
      "approved",
    );
    vi.useFakeTimers();
    try {
      vi.setSystemTime(localDate(f.date));
      expect(
        await f.t.mutation(internal.coverage.activation.activateDue, {}),
      ).toBe(1);
      expect(
        await f.t.mutation(internal.coverage.activation.activateDue, {}),
      ).toBe(0);
      const result = await f.manager.actor.mutation(
        api.coverage.activation.activate,
        { planId: plan._id },
      );
      expect(result.count).toBe(1);
      expect(
        await f.manager.actor.mutation(api.coverage.activation.activate, {
          planId: plan._id,
        }),
      ).toEqual(result);
      const visits = await f.sales.actor.query(
        api.coverage.activation.plannedForMonth,
        { assigneeProfileId: f.sales.id, localMonth: f.month },
      );
      expect(visits.map((v) => v._id)).toEqual(result.visitIds);
      expect(visits[0]?.approvedSnapshot.outletCode).toBe("O");
      const signed = visits[0]?.approvedSnapshot;
      await f.t.run(async (ctx) => {
        await ctx.db.patch(f.outlet, { name: "Renamed", code: "O2" });
        await ctx.db.patch(f.route, { code: "R2" });
      });
      expect(
        (
          await f.sales.actor.query(api.coverage.activation.plannedForMonth, {
            assigneeProfileId: f.sales.id,
            localMonth: f.month,
          })
        )[0]?.approvedSnapshot,
      ).toEqual(signed);
      const page = await f.sales.actor.query(api.coverage.history.list, {
        planId: plan._id,
        paginationOpts: { numItems: 2, cursor: null },
      });
      expect(page.page.map((e) => e.action)).toContain("visits.generated");
      expect(page.isDone).toBe(false);
      const following = await f.sales.actor.query(api.coverage.history.list, {
        planId: plan._id,
        paginationOpts: { numItems: 2, cursor: page.continueCursor },
      });
      expect(following.page.length).toBeGreaterThan(0);
      expect(page.page[0]!._creationTime).toBeGreaterThanOrEqual(
        following.page[0]!._creationTime,
      );
      vi.setSystemTime(localDate(f.date) + 86400000);
      expect(
        await f.manager.actor.mutation(api.coverage.activation.activate, {
          planId: plan._id,
        }),
      ).toEqual(result);
      await expect(
        f.westManager.actor.query(api.coverage.history.list, {
          planId: plan._id,
          paginationOpts: { numItems: 2, cursor: null },
        }),
      ).rejects.toThrow(/scope/);
      await expect(
        f.other.actor.query(api.coverage.history.list, {
          planId: plan._id,
          paginationOpts: { numItems: 2, cursor: null },
        }),
      ).rejects.toThrow(/own/);
    } finally {
      vi.useRealTimers();
    }
  });
  it("supersedes only future visits, retains past IDs and links matching replacement", async () => {
    const f = await setup();
    const first = await f.create();
    const firstDay = manilaDate(localDate(f.date) - 86400000);
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: first._id,
      slots: [
        { ...f.slot(), serviceDate: firstDay, slotKey: "past" },
        { ...f.slot(), sequence: 2, slotKey: "future" },
      ],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: first._id,
    });
    await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: first._id,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(localDate(firstDay));
      const initial = await f.manager.actor.mutation(
        api.coverage.activation.activate,
        { planId: first._id },
      );
      expect(initial.count).toBe(2);
      const revision = await f.sales.actor.mutation(
        api.coverage.plans.createRevision,
        { planId: first._id, effectiveFromDate: f.date, reason: "New route" },
      );
      await f.sales.actor.mutation(api.coverage.plans.submit, {
        planId: revision._id,
      });
      await f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: revision._id,
      });
      vi.setSystemTime(localDate(f.date));
      const next = await f.manager.actor.mutation(
        api.coverage.activation.activate,
        { planId: revision._id },
      );
      const old = await f.t.run((ctx) =>
        Promise.all(initial.visitIds.map((id) => ctx.db.get(id))),
      );
      expect(old[0]?.status).toBe("planned");
      expect(old[1]?.status).toBe("replaced");
      expect(old[1]?.replacedByVisitId).toBe(next.visitIds[0]);
      expect(
        (await f.t.run((ctx) => ctx.db.get(next.visitIds[0]!)))
          ?.replacementOfVisitId,
      ).toBe(old[1]?._id);
      expect(
        (await f.t.run((ctx) => ctx.db.get(first._id)))?.activeThrough,
      ).toBe(revision.effectiveFrom);
    } finally {
      vi.useRealTimers();
    }
  });
  it("includes today's signed visit when activation runs after Manila midnight", async () => {
    const f = await setup();
    const plan = await f.create();
    await f.schedule(plan._id);
    await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: plan._id,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(localDate(f.date) + 12 * 3600000);
      expect(
        (
          await f.manager.actor.mutation(api.coverage.activation.activate, {
            planId: plan._id,
          })
        ).count,
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("clips signed slots at the Manila month-end and never backfills yesterday", async () => {
    const f = await setup();
    const dates = monthDates(f.month);
    const yesterday = dates.at(-2)!;
    const lastDay = dates.at(-1)!;
    const plan = await f.create();
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [
        { ...f.slot(), slotKey: "yesterday", serviceDate: yesterday },
        { ...f.slot(), slotKey: "last", serviceDate: lastDay },
      ],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: plan._id,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(localDate(lastDay) + 12 * 3600000);
      const result = await f.manager.actor.mutation(
        api.coverage.activation.activate,
        { planId: plan._id },
      );
      expect(result.count).toBe(1);
      expect(
        (await f.t.run((ctx) => ctx.db.get(result.visitIds[0]!)))?.serviceDate,
      ).toBe(lastDay);
      expect(manilaDate(monthBounds(f.month).to)).not.toBe(lastDay);
    } finally {
      vi.useRealTimers();
    }
  });
  it("Manila date boundary crosses UTC month without backfilling elapsed visits", () => {
    expect(manilaDate(Date.parse("2026-09-30T15:59:59Z"))).toBe("2026-09-30");
    expect(manilaDate(Date.parse("2026-09-30T16:00:00Z"))).toBe("2026-10-01");
    expect(monthBounds("2026-09").to).toBe(Date.parse("2026-09-30T16:00:00Z"));
  });
});
