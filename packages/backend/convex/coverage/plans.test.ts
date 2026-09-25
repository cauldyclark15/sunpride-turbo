import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { localDate, manilaDate, monthBounds } from "./validation";

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
type Fixture = Awaited<ReturnType<typeof setup>>;
const read = (f: Fixture, planId: Id<"coveragePlans">) =>
  f.sales.actor.query(api.coverage.plans.detail, { planId });

describe("MCP authoring and approval", () => {
  it("allocates monotonic versions under concurrent creates and rejects sales preparing for another person", async () => {
    const f = await setup();
    await expect(
      f.sales.actor.mutation(api.coverage.plans.create, {
        assigneeProfileId: f.other.id,
        localMonth: f.month,
      }),
    ).rejects.toThrow(/own/);
    const plans = await Promise.all([f.create(), f.create(), f.create()]);
    expect(plans.map((p) => p.version).sort()).toEqual([1, 2, 3]);
    expect(
      (
        await f.sales.actor.query(api.coverage.plans.list, {
          assigneeProfileId: f.sales.id,
          localMonth: f.month,
        })
      ).map((p) => p.version),
    ).toEqual([1, 2, 3]);
  });
  it("enforces current plan and outlet scope, and analyst remains read-only", async () => {
    const f = await setup();
    const plan = await f.create();
    await expect(
      f.westManager.actor.query(api.coverage.plans.detail, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      f.westManager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      f.outsider.actor.mutation(api.coverage.plans.create, {
        assigneeProfileId: f.sales.id,
        localMonth: f.month,
      }),
    ).rejects.toThrow(/permission/);
    await expect(
      f.manager.actor.mutation(api.coverage.plans.saveSlots, {
        planId: plan._id,
        slots: [{ ...f.slot(), outletId: f.foreign }],
      }),
    ).rejects.toThrow(/scope/);
    expect((await read(f, plan._id)).slots).toEqual([]);
    await expect(
      f.sales.actor.query(api.coverage.plans.detail, {
        planId: (
          await f.manager.actor.mutation(api.coverage.plans.create, {
            assigneeProfileId: f.other.id,
            localMonth: f.month,
          })
        )._id,
      }),
    ).rejects.toThrow(/own/);
  });
  it("allows draft edits, freezes submission, requires return reason and resubmission", async () => {
    const f = await setup();
    const plan = await f.create();
    await f.schedule(plan._id);
    await expect(
      f.sales.actor.mutation(api.coverage.plans.saveSlots, {
        planId: plan._id,
        slots: [],
      }),
    ).rejects.toThrow(/draft/);
    await expect(
      f.manager.actor.mutation(api.coverage.plans.returnPlan, {
        planId: plan._id,
        reason: "  ",
      }),
    ).rejects.toThrow(/reason/);
    expect(
      (
        await f.manager.actor.mutation(api.coverage.plans.returnPlan, {
          planId: plan._id,
          reason: "Revise route",
        })
      ).status,
    ).toBe("draft");
    expect(
      await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
        planId: plan._id,
        slots: [f.slot()],
      }),
    ).toHaveLength(1);
    expect(
      (
        await f.sales.actor.mutation(api.coverage.plans.submit, {
          planId: plan._id,
        })
      ).status,
    ).toBe("submitted");
  });
  it("rejects self-approval by preparer and by submitter", async () => {
    const f = await setup();
    const plan = await f.manager.actor.mutation(api.coverage.plans.create, {
      assigneeProfileId: f.sales.id,
      localMonth: f.month,
    });
    await f.manager.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/Independent/);
    const draft = await f.root.mutation(api.coverage.plans.create, {
      assigneeProfileId: f.sales.id,
      localMonth: f.month,
    });
    await f.manager.actor.mutation(api.coverage.plans.submit, {
      planId: draft._id,
    });
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: draft._id,
      }),
    ).rejects.toThrow(/Independent/);
  });
  it("rejects approval and return by the assignee even when another person prepared and submitted", async () => {
    const f = await setup();
    const admin = await f.person("admin", f.east, "cov-admin");
    const independent = await f.person("manager", f.east, "cov-independent");
    const plan = await admin.actor.mutation(api.coverage.plans.create, {
      assigneeProfileId: f.manager.id,
      localMonth: f.month,
    });
    await admin.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [
        {
          slotKey: "meeting-1",
          serviceDate: f.date,
          kind: "non_visit",
          activityKind: "meeting",
          requiredObjectives: ["review"],
          intents: [],
          sequence: 1,
          expectedDurationMinutes: 30,
        },
      ],
    });
    await admin.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    const state = () =>
      f.t.run(async (ctx) => ({
        plan: await ctx.db.get(plan._id),
        audit: await ctx.db
          .query("coverageAuditEvents")
          .withIndex("by_planId_and_createdAt", (q) => q.eq("planId", plan._id))
          .collect(),
      }));
    const before = await state();
    expect(before.plan?.status).toBe("submitted");
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/Independent approver required/);
    expect(await state()).toEqual(before);
    await expect(
      f.manager.actor.mutation(api.coverage.plans.returnPlan, {
        planId: plan._id,
        reason: "Review",
      }),
    ).rejects.toThrow(/Independent approver required/);
    expect(await state()).toEqual(before);
    expect(
      (
        await independent.actor.mutation(api.coverage.plans.approve, {
          planId: plan._id,
        })
      ).status,
    ).toBe("approved");
  });
  it("freezes customer/link/route/outlet snapshots and refuses approved edits", async () => {
    const f = await setup();
    const plan = await f.create();
    await f.schedule(plan._id);
    const signed = await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: plan._id,
    });
    expect(signed.approvedBy).toBeDefined();
    expect(signed.approvalSignature).toContain(signed.contentHash!);
    const snapshot = (await read(f, plan._id)).slots[0]!.approvedSnapshot!;
    expect(snapshot).toMatchObject({
      outletId: f.outlet,
      outletCode: "O",
      outletName: "Outlet",
      customerId: f.customer,
      outletCustomerLinkId: f.link,
      territoryId: f.territory,
      territoryCode: "E",
      routeId: f.route,
      routeCode: "R",
      sequence: 1,
      outletAssignmentId: f.outletAssignment,
      orgUnitId: f.east,
      activityKind: "sell",
      approvedAssigneeProfileId: f.sales.id,
    });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.outlet, { name: "Changed", code: "O2" });
      await ctx.db.patch(f.route, { code: "R2" });
      await ctx.db.patch(f.link, { effectiveTo: localDate(f.date) });
      await ctx.db.patch(f.customer, { name: "Changed customer" });
    });
    expect((await read(f, plan._id)).slots[0]!.approvedSnapshot).toEqual(
      snapshot,
    );
    await expect(
      f.sales.actor.mutation(api.coverage.plans.saveSlots, {
        planId: plan._id,
        slots: [],
      }),
    ).rejects.toThrow(/draft/);
    await expect(
      f.sales.actor.mutation(api.coverage.plans.setAssignment, {
        planId: plan._id,
        effectiveFrom: plan.effectiveFrom,
        effectiveTo: plan.effectiveTo,
        reason: "edit",
      }),
    ).rejects.toThrow(/draft/);
  });
  it("rejects invalid route, inactive outlet, and duplicate sequence atomically", async () => {
    const f = await setup();
    const plan = await f.create();
    await f.schedule(plan._id, f.badRoute);
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/route|Route/);
    expect((await read(f, plan._id)).plan.status).toBe("submitted");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.outletAssignment, { routeId: f.badRoute });
      await ctx.db.insert("routeSalespeople", {
        routeId: f.badRoute,
        profileId: f.sales.id,
        primary: true,
        effectiveFrom: Date.now() - 100000000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: Date.now(),
      });
    });
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/Route not in territory/);
    expect(
      (await read(f, plan._id)).slots.every((s) => !s.approvedSnapshot),
    ).toBe(true);
    await f.t.run((ctx) =>
      ctx.db.patch(f.outletAssignment, { routeId: f.route }),
    );
    await f.manager.actor.mutation(api.coverage.plans.returnPlan, {
      planId: plan._id,
      reason: "Fix route",
    });
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [f.slot(), { ...f.slot(), slotKey: "visit-2" }],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/Duplicate sequence/);
    await f.manager.actor.mutation(api.coverage.plans.returnPlan, {
      planId: plan._id,
      reason: "Fix sequence",
    });
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [f.slot()],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    await f.t.run((ctx) => ctx.db.patch(f.outlet, { status: "inactive" }));
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/Inactive/);
    expect(
      (await read(f, plan._id)).slots.every((s) => !s.approvedSnapshot),
    ).toBe(true);
  });
  it("refuses unrelated approved overlap while a named successor preserves the signed predecessor", async () => {
    const f = await setup();
    const first = await f.create();
    await f.schedule(first._id);
    await f.manager.actor.mutation(api.coverage.plans.approve, {
      planId: first._id,
    });
    const competing = await f.create();
    await f.schedule(competing._id);
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: competing._id,
      }),
    ).rejects.toThrow(/Overlapping/);
    const revision = await f.sales.actor.mutation(
      api.coverage.plans.createRevision,
      { planId: first._id, effectiveFromDate: f.date, reason: "New itinerary" },
    );
    expect(revision.version).toBe(3);
    expect(revision.basedOnPlanId).toBe(first._id);
    expect(
      (await read(f, revision._id)).slots[0]!.approvedSnapshot,
    ).toBeUndefined();
    expect((await read(f, first._id)).plan.status).toBe("approved");
    expect((await read(f, first._id)).slots[0]!.approvedSnapshot).toBeDefined();
  });
  it("creates a v2 draft successor without changing the v1 signature or frozen slot", async () => {
    const f = await setup();
    const first = await f.create();
    await f.schedule(first._id);
    const approved = await f.manager.actor.mutation(
      api.coverage.plans.approve,
      { planId: first._id },
    );
    const second = await f.sales.actor.mutation(
      api.coverage.plans.createRevision,
      {
        planId: first._id,
        effectiveFromDate: f.date,
        reason: "Prospective revision",
      },
    );
    expect(second).toMatchObject({
      version: 2,
      status: "draft",
      basedOnPlanId: first._id,
    });
    expect(
      (await read(f, second._id)).slots[0]!.approvedSnapshot,
    ).toBeUndefined();
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: second._id,
    });
    expect(
      (
        await f.manager.actor.mutation(api.coverage.plans.approve, {
          planId: second._id,
        })
      ).status,
    ).toBe("approved");
    const stillSigned = await read(f, first._id);
    expect(stillSigned.plan.approvalSignature).toBe(approved.approvalSignature);
    expect(stillSigned.slots[0]!.approvedSnapshot).toBeDefined();
  });
  it("copies effective route defaults into draft outlet rows and audits assignment edits", async () => {
    const f = await setup();
    const plan = await f.create();
    const outlets = await f.sales.actor.mutation(
      api.coverage.plans.saveOutlets,
      {
        planId: plan._id,
        outlets: [
          {
            outletId: f.outlet,
            territoryId: f.territory,
            frequency: "weekly",
            preferredWeekdays: [],
            customLocalDates: [],
            priority: 1,
            expectedDurationMinutes: 30,
            requiredObjectives: ["sell"],
          },
        ],
      },
    );
    expect(outlets[0]).toMatchObject({
      routeId: f.route,
      sequence: 1,
      territoryId: f.territory,
    });
    const assignment = await f.sales.actor.mutation(
      api.coverage.plans.setAssignment,
      {
        planId: plan._id,
        effectiveFrom: plan.effectiveFrom,
        effectiveTo: plan.effectiveTo,
        reason: "Confirm primary",
      },
    );
    expect(assignment).toMatchObject({
      assigneeProfileId: f.sales.id,
      orgUnitId: f.east,
      primary: true,
    });
    const events = await f.t.run((ctx) =>
      ctx.db
        .query("coverageAuditEvents")
        .withIndex("by_planId_and_createdAt", (q) => q.eq("planId", plan._id))
        .collect(),
    );
    expect(events.map((e) => e.action)).toEqual([
      "plan.created",
      "outlets.saved",
      "assignment.changed",
    ]);
  });
  it("requires a named truck for Distributor Specialist Work-With without a POS session", async () => {
    const f = await setup();
    const plan = await f.create();
    await f.t.run(async (ctx) => {
      const ds = await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "DS",
        label: "Distributor Specialist",
        category: "specialist",
        active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const assignment = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", f.sales.id),
        )
        .first();
      await ctx.db.patch(assignment!._id, { positionId: ds });
    });
    const nonvisit = {
      slotKey: "work-with",
      serviceDate: f.date,
      kind: "non_visit" as const,
      activityKind: "Work-With",
      requiredObjectives: ["coaching"],
      intents: [],
      sequence: 1,
      expectedDurationMinutes: 60,
    };
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [nonvisit],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    await expect(
      f.manager.actor.mutation(api.coverage.plans.approve, {
        planId: plan._id,
      }),
    ).rejects.toThrow(/named truck/);
    await f.manager.actor.mutation(api.coverage.plans.returnPlan, {
      planId: plan._id,
      reason: "Name truck",
    });
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [{ ...nonvisit, namedTruckRef: "TRUCK-01" }],
    });
    await f.sales.actor.mutation(api.coverage.plans.submit, {
      planId: plan._id,
    });
    expect(
      (
        await f.manager.actor.mutation(api.coverage.plans.approve, {
          planId: plan._id,
        })
      ).status,
    ).toBe("approved");
  });
  it("uses Manila calendar boundaries, not server timezone", () => {
    expect(monthBounds("2026-09")).toEqual({
      from: Date.parse("2026-08-31T16:00:00Z"),
      to: Date.parse("2026-09-30T16:00:00Z"),
    });
    expect(localDate("2026-09-30")).toBe(Date.parse("2026-09-29T16:00:00Z"));
    expect(manilaDate(Date.parse("2026-09-30T15:59:59Z"))).toBe("2026-09-30");
    expect(manilaDate(Date.parse("2026-09-30T16:00:00Z"))).toBe("2026-10-01");
    expect(() => localDate("2026-02-30")).toThrow();
  });
  it("applies provisional weekly routine, warns on missing template and advisory target, audits each mutation", async () => {
    const f = await setup();
    const plan = await f.create();
    expect(
      (
        await f.sales.actor.query(api.coverage.routines.listForPosition, {
          planId: plan._id,
        })
      ).warning,
    ).toMatch(/No weekly routine/);
    expect(
      (
        await f.sales.actor.mutation(api.coverage.routines.applyToDraft, {
          planId: plan._id,
        })
      ).warning,
    ).toMatch(/No weekly routine/);
    expect(
      await f.t.mutation(internal.coverage.routines.seedProvisional, {}),
    ).toBeGreaterThan(0);
    expect(
      await f.t.mutation(internal.coverage.routines.seedProvisional, {}),
    ).toBe(0);
    const applied = await f.sales.actor.mutation(
      api.coverage.routines.applyToDraft,
      { planId: plan._id },
    );
    expect(applied.created).toBeGreaterThan(0);
    const detail = await read(f, plan._id);
    expect(detail.slots.some((s) => s.activityKind === "day_off")).toBe(true);
    await f.sales.actor.mutation(api.coverage.plans.saveSlots, {
      planId: plan._id,
      slots: [
        f.slot(),
        ...detail.slots
          .filter((s) => s.kind === "non_visit")
          .map((s) => ({
            slotKey: s.slotKey,
            serviceDate: s.serviceDate,
            kind: s.kind,
            activityKind: s.activityKind,
            requiredObjectives: s.requiredObjectives,
            intents: s.intents,
            sequence: s.sequence,
            expectedDurationMinutes: s.expectedDurationMinutes,
          })),
      ],
    });
    expect((await read(f, plan._id)).warnings).toContainEqual(
      expect.stringMatching(/position standard 5\/day/),
    );
    const events = await f.t.run((ctx) =>
      ctx.db
        .query("coverageAuditEvents")
        .withIndex("by_planId_and_createdAt", (q) => q.eq("planId", plan._id))
        .collect(),
    );
    expect(events.map((e) => e.action)).toEqual([
      "plan.created",
      "routine.applied",
      "routine.applied",
      "slots.saved",
    ]);
    expect(events.every((e) => e.before && e.after && e.actorSubject)).toBe(
      true,
    );
  });
});
