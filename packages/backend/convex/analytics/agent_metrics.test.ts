import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { append } from "../visits/events";
import { queueAgentDay, queueAgentDayForOrder } from "./agent_metrics";
import { summarizeAgentDay, type VisitInput } from "./agent_metrics_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const date = "2026-09-28"; // a Monday
const now = Date.parse("2026-09-28T03:00:00Z"); // 11:00 Manila
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+08:00`);
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

const closed = (extra: Partial<VisitInput> = {}): VisitInput => ({
  state: "checked-out",
  source: "planned",
  plannedVisitId: "p1",
  activityKinds: [],
  collections: [],
  ...extra,
});

describe("summarizeAgentDay", () => {
  const base = {
    serviceDate: date,
    organizationId: "sunpride",
    rule: "any_listed_activity" as const,
    plannedVisitIds: ["p1", "p2", "p3"],
    orders: [],
    dailyCallsTarget: 30,
    productiveCallTargetPct: 85,
  };

  it("counts calls, productive calls and visit figures like the DSR", () => {
    const m = summarizeAgentDay({
      ...base,
      visits: [
        closed({
          activityKinds: ["order_intent"],
          startedAt: at(date, "08:00"),
          endedAt: at(date, "08:20"),
          callDurationMs: 20 * 60_000,
        }),
        closed({
          plannedVisitId: "p2",
          collections: [{ status: "pending_review", amountMinor: 25_000n }],
          lateSyncAt: at(date, "23:00"),
          startedAt: at(date, "09:00"),
          endedAt: at(date, "09:10"),
          callDurationMs: 10 * 60_000,
        }),
        {
          state: "in-progress",
          source: "unplanned",
          activityKinds: ["merchandising"],
          collections: [{ status: "rejected", amountMinor: 99_900n }],
          missingActivities: ["merchandising"],
        },
      ],
    });
    expect(m).toMatchObject({
      plannedCalls: 3,
      calls: 2,
      productiveCalls: 2,
      nonproductiveCalls: 0,
      productivePct: 100,
      plannedNotVisited: 1,
      visits: 3,
      unplannedVisits: 1,
      openVisits: 1,
      lateSyncVisits: 1,
      visitsMissingActivities: 1,
      callDurationMs: 30 * 60_000,
      timedVisits: 2,
      firstStartAt: at(date, "08:00"),
      lastEndAt: at(date, "09:10"),
      collections: 1,
      collectionsPendingReview: 1,
      collectionsValue: 25_000,
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
    });
  });

  it("applies the truck seller rule: merchandising alone needs the no-sales marker", () => {
    const visits = [
      closed({ activityKinds: ["merchandising"] }),
      closed({
        plannedVisitId: "p2",
        activityKinds: ["merchandising"],
        reasonCode: "no_sales_due_to_inventory",
      }),
    ];
    const m = summarizeAgentDay({ ...base, rule: "truck_seller", visits });
    expect([m.calls, m.productiveCalls, m.productivePct]).toEqual([2, 1, 50]);
    const any = summarizeAgentDay({ ...base, visits });
    expect(any.productiveCalls).toBe(2);
  });

  it("dates orders by when they were written and nets returns", () => {
    const order = (
      total: number,
      createdAt: number,
      extra: Record<string, unknown> = {},
    ) => ({
      customerCode: "C1",
      status: "posted" as const,
      total,
      createdAt,
      ...extra,
    });
    const m = summarizeAgentDay({
      ...base,
      visits: [],
      orders: [
        order(1500.5, at(date, "08:15")),
        order(200, at(date, "10:00"), { customerCode: "C9" }),
        order(-100, at(date, "10:30")),
        order(999, at(date, "09:00"), { status: "voided" }),
        // Written offline today, synced tomorrow: today.
        order(50, at("2026-09-29", "07:00"), {
          offlineCreatedAt: at(date, "16:00"),
        }),
        // Written yesterday offline, synced today: not today.
        order(500, at(date, "07:00"), {
          offlineCreatedAt: at("2026-09-27", "16:00"),
        }),
        order(70, at(date, "09:00"), { organizationId: "other" }),
      ],
    });
    expect(m).toMatchObject({
      orders: 3,
      returnOrders: 1,
      buyingAccounts: 2,
      salesValue: 150_050 + 20_000 - 10_000 + 5_000,
      plannedNotVisited: 3,
      calls: 0,
      productivePct: null,
    });
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 90 * DAY;
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: parentId ? "REGION" : "NATIONAL",
        ...(parentId ? { parentId } : {}),
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
      });
    const root = await unit("SUNPRIDE");
    const regionA = await unit("A", root);
    const regionB = await unit("B", root);
    const position = await ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "RS",
      label: "Route Sales",
      category: "field",
      active: true,
      createdAt: since,
      updatedAt: since,
    });
    await ctx.db.insert("positionStandards", {
      organizationId: "sunpride",
      positionId: position,
      effectiveFrom: since,
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
      productiveCallRule: "any_listed_activity",
      sellingWeekdays: [1, 2, 3, 4, 5, 6],
      sourceRef: "memo-2026-01-20",
      createdAt: since,
      updatedAt: since,
    });
    const person = async (
      name: string,
      role: "sales" | "manager" | "analyst",
      orgUnitId: Id<"orgUnits">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        ...(role === "sales" ? { positionId: position } : {}),
        updatedAt: since,
      });
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        ...(role === "sales" ? { positionId: position } : {}),
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    await person("managerA", "manager", regionA);
    await person("managerB", "manager", regionB);
    await person("analyst", "analyst", root);
    const ana = await person("Ana", "sales", regionA);
    const cara = await person("Cara", "sales", regionB);
    const customer = await ctx.db.insert("customers", {
      code: "C1",
      name: "Store One",
      channel: "GT",
      territory: "T-A",
      creditLimit: 0,
      active: true,
      updatedAt: since,
    });
    const territory = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T-A",
      name: "Territory A",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    const ownership = await ctx.db.insert("territoryOwnerships", {
      territoryId: territory,
      orgUnitId: regionA,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const route = await ctx.db.insert("routes", {
      organizationId: "sunpride",
      code: "R-01",
      name: "Route 1",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [territory],
      requestedFrom: since,
      requestedTo: now + 30 * DAY,
      effectiveFrom: since,
      effectiveTo: now + 30 * DAY,
      status: "active",
      preparedBy: subject("Ana"),
      preparedAt: since,
      approvedBy: subject("managerA"),
      approvedAt: since,
      approvalSignature: "signed",
      contentRevision: 1,
      createdBy: subject("Ana"),
      createdAt: since,
      updatedBy: subject("managerA"),
      updatedAt: since,
    });
    const outlets: Id<"outlets">[] = [];
    const planned: Id<"plannedVisits">[] = [];
    for (const n of [1, 2, 3]) {
      const outletId = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${n}`,
        name: `Outlet ${n}`,
        status: "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      outlets.push(outletId);
      const outletAssignmentId = await ctx.db.insert("outletAssignments", {
        outletId,
        territoryId: territory,
        routeId: route,
        sequence: n,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      const approvedSnapshot = {
        outletId,
        outletCode: `O${n}`,
        outletName: `Outlet ${n}`,
        territoryId: territory,
        territoryCode: "T-A",
        routeId: route,
        routeCode: "R-01",
        sequence: n,
        outletAssignmentId,
        territoryOwnershipId: ownership,
        employeeAssignmentId: ana.assignment,
        orgUnitId: regionA,
        activityKind: "sell",
        approvedAssigneeProfileId: ana.id,
      };
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: `slot-${n}`,
        planId: plan,
        assigneeProfileId: ana.id,
        serviceDate: date,
        kind: "outlet_visit",
        outletId,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: n,
        expectedDurationMinutes: 20,
        approvedSnapshot,
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: since,
      });
      planned.push(
        await ctx.db.insert("plannedVisits", {
          generationKey: `gen-${n}`,
          planId: plan,
          planVersion: 1,
          planSlotId: slot,
          assigneeProfileId: ana.id,
          outletId,
          serviceDate: date,
          status: "planned",
          approvedSnapshot,
          requiredObjectives: [],
          intents: ["sell"],
          expectedDurationMinutes: 20,
          generatedAt: since,
        }),
      );
    }
    const visit = (
      n: number,
      fields: {
        plannedVisitId?: Id<"plannedVisits">;
        state?: "checked-out" | "in-progress";
        reasonCode?: string;
      },
    ) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${n}`,
        assigneeProfileId: ana.id,
        outletId: outlets[n - 1]!,
        orgUnitId: regionA,
        routeId: route,
        serviceDate: date,
        source: fields.plannedVisitId ? "planned" : "unplanned",
        ...(fields.plannedVisitId
          ? { plannedVisitId: fields.plannedVisitId, planId: plan }
          : {}),
        intents: ["sell"],
        state: fields.state ?? "checked-out",
        productivity: "pending",
        createdAt: at(date, "08:00"),
        lastServerTime: at(date, "08:30"),
        checkedInAt: at(date, "08:00"),
        startedAt: at(date, "08:00") + n * HOUR,
        endedAt: at(date, "08:15") + n * HOUR,
        callDurationMs: 15 * 60_000,
        ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
      });
    const v1 = await visit(1, { plannedVisitId: planned[0]! });
    const v2 = await visit(2, {
      plannedVisitId: planned[1]!,
      reasonCode: "store_closed",
    });
    const v3 = await visit(3, { state: "in-progress" });
    const activityId = await ctx.db.insert("visitActivities", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      visitId: v1,
      assigneeProfileId: ana.id,
      outletId: outlets[0]!,
      activity: { kind: "order_intent", clientOrderId: "ord-1" },
      evidenceIds: [],
      deviceTime: at(date, "08:10"),
      serverTime: at(date, "08:10"),
    });
    const collection = await ctx.db.insert("fieldCollections", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      customerId: customer,
      outletId: outlets[2]!,
      visitId: v3,
      assigneeProfileId: ana.id,
      amountMinor: 25_000n,
      currency: "PHP",
      method: "cash",
      reference: "OR-1",
      status: "recorded",
      deviceTime: at(date, "10:00"),
      serverTime: at(date, "10:00"),
    });
    let n = 0;
    const order = async (
      who: string,
      total: number,
      createdAt: number,
      status: "posted" | "voided" = "posted",
    ) => {
      n++;
      return await ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${n}`,
        orderNumber: `SI-${n}`,
        customerCode: "C1",
        salespersonSubject: subject(who),
        status,
        subtotal: total,
        total,
        createdAt,
        updatedAt: createdAt,
      });
    };
    const anaOrder = await order("Ana", 1500.5, at(date, "08:15"));
    await order("Ana", -100, at(date, "10:30"));
    await order("Ana", 999, at(date, "09:00"), "voided");
    await order("Ana", 1000, at("2026-09-10", "10:00"));
    await order("Cara", 4444, at(date, "09:00"));
    return {
      ana: ana.id,
      cara: cara.id,
      regionA,
      v1,
      v2,
      activityId,
      collection,
      anaOrder,
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

describe("analytics.agent_metrics", () => {
  it("precomputes the day and agrees with the Daily Sales Report", async () => {
    const { t, ids, as } = await fixture();
    await t.mutation(internal.analytics.agent_metrics.refreshDay, {
      profileId: ids.ana,
      serviceDate: date,
    });
    const [row] = await as("managerA").query(
      api.analytics.agent_metrics.forPerson,
      { profileId: ids.ana, fromDate: date, toDate: date },
    );
    expect(row).toMatchObject({
      serviceDate: date,
      localMonth: "2026-09",
      orgUnitId: ids.regionA,
      plannedCalls: 3,
      calls: 2,
      productiveCalls: 1,
      nonproductiveCalls: 1,
      productivePct: 50,
      plannedNotVisited: 1,
      visits: 3,
      unplannedVisits: 1,
      openVisits: 1,
      callDurationMs: 45 * 60_000,
      timedVisits: 3,
      firstStartAt: at(date, "09:00"),
      lastEndAt: at(date, "11:15"),
      orders: 1,
      returnOrders: 1,
      buyingAccounts: 1,
      salesValue: 140_050,
      collections: 1,
      collectionsValue: 25_000,
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
      complete: true,
      ruleVersion: "productive-call/2026-10-02",
    });
    const dsr = await as("managerA").query(api.dsr.report.day, {
      profileId: ids.ana,
      serviceDate: date,
    });
    expect([
      dsr.calls.planned,
      dsr.calls.calls,
      dsr.calls.productiveCalls,
    ]).toEqual([row!.plannedCalls, row!.calls, row!.productiveCalls]);
    expect(dsr.totals.todaySales).toBe(row!.salesValue);
  });

  it("debounces refreshes per person and day, then recomputes once", async () => {
    const { t, ids } = await fixture();
    await t.run(async (ctx) => {
      await queueAgentDay(ctx, ids.ana, date);
      await queueAgentDay(ctx, ids.ana, date);
      await queueAgentDayForOrder(ctx, ids.anaOrder);
    });
    const before = await t.run(async (ctx) => ({
      pending: await ctx.db.query("agentMetricRefreshes").collect(),
      jobs: await ctx.db.system.query("_scheduled_functions").collect(),
      rows: await ctx.db.query("agentDailyMetrics").collect(),
    }));
    expect(before.pending).toHaveLength(1);
    expect(before.jobs).toHaveLength(1);
    expect(before.rows).toHaveLength(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ({
      pending: await ctx.db.query("agentMetricRefreshes").collect(),
      rows: await ctx.db.query("agentDailyMetrics").collect(),
    }));
    expect(after.pending).toHaveLength(0);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({ profileId: ids.ana, calls: 2 });
  });

  it("queues the visit's day from execution events and keeps the row current", async () => {
    const { t, ids } = await fixture();
    await t.mutation(internal.analytics.agent_metrics.refreshDay, {
      profileId: ids.ana,
      serviceDate: date,
    });
    const first = await t.run(async (ctx) =>
      ctx.db.query("agentDailyMetrics").first(),
    );
    // A collection lands on the nonproductive visit: the call becomes productive.
    vi.setSystemTime(now + HOUR);
    await t.run(async (ctx) => {
      const visit = (await ctx.db.get(ids.v2))!;
      const collectionId = await ctx.db.insert("fieldCollections", {
        organizationId: "sunpride",
        orgUnitId: visit.orgUnitId,
        customerId: (await ctx.db.query("customers").first())!._id,
        outletId: visit.outletId,
        visitId: visit._id,
        assigneeProfileId: ids.ana,
        amountMinor: 10_000n,
        currency: "PHP",
        method: "cash",
        reference: "OR-2",
        status: "recorded",
        deviceTime: now + HOUR,
        serverTime: now + HOUR,
      });
      await append(ctx, {
        orgUnitId: visit.orgUnitId,
        entityType: "collection",
        entityId: collectionId,
        kind: "collection.recorded",
        actorSubject: subject("Ana"),
        actorRole: "sales",
        actorOrgUnitId: visit.orgUnitId,
        source: "mobile",
        occurredAt: now + HOUR,
        serverAt: now + HOUR,
        summary: { after: "recorded" },
      });
      // Events for other entities never queue anything.
      await append(ctx, {
        orgUnitId: visit.orgUnitId,
        entityType: "device",
        entityId: "device-1",
        kind: "device.bound",
        actorSubject: subject("Ana"),
        actorRole: "sales",
        actorOrgUnitId: visit.orgUnitId,
        source: "mobile",
        occurredAt: now + HOUR,
        serverAt: now + HOUR,
        summary: {},
      });
    });
    const pending = await t.run(async (ctx) =>
      ctx.db.query("agentMetricRefreshes").collect(),
    );
    expect(pending.map((row) => [row.profileId, row.serviceDate])).toEqual([
      [ids.ana, date],
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const second = await t.run(async (ctx) =>
      ctx.db.query("agentDailyMetrics").collect(),
    );
    expect(second).toHaveLength(1);
    expect(second[0]!._id).toBe(first!._id);
    expect(second[0]).toMatchObject({
      productiveCalls: 2,
      productivePct: 100,
      collections: 2,
      collectionsValue: 35_000,
    });
    expect(second[0]!.computedAt).toBeGreaterThan(first!.computedAt);

    // An unchanged recompute does not rewrite the row.
    vi.setSystemTime(now + 2 * HOUR);
    await t.mutation(internal.analytics.agent_metrics.refreshDay, {
      profileId: ids.ana,
      serviceDate: date,
    });
    const third = await t.run(async (ctx) =>
      ctx.db.query("agentDailyMetrics").first(),
    );
    expect(third!.computedAt).toBe(second[0]!.computedAt);
  });

  it("backfills a date for everyone with work that day only", async () => {
    const { t, ids } = await fixture();
    await t.mutation(internal.analytics.agent_metrics.backfillDay, {
      serviceDate: date,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("agentDailyMetrics").collect(),
    );
    expect(
      rows.map((row) => [row.profileId, row.orders, row.salesValue]).sort(),
    ).toEqual(
      [
        [ids.ana, 1, 140_050],
        [ids.cara, 1, 444_400],
      ].sort(),
    );
  });

  it("limits readers to their scope and field sales to themselves", async () => {
    const { t, ids, as } = await fixture();
    await t.mutation(internal.analytics.agent_metrics.backfillDay, {
      serviceDate: date,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const range = { fromDate: "2026-09-01", toDate: "2026-09-30" };
    await expect(
      as("managerB").query(api.analytics.agent_metrics.forPerson, {
        profileId: ids.ana,
        ...range,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("Cara").query(api.analytics.agent_metrics.forPerson, {
        profileId: ids.ana,
        ...range,
      }),
    ).rejects.toThrow(/only read their own/);
    expect(
      await as("Ana").query(api.analytics.agent_metrics.forPerson, {
        profileId: ids.ana,
        ...range,
      }),
    ).toHaveLength(1);
    await expect(
      as("managerA").query(api.analytics.agent_metrics.forPerson, {
        profileId: ids.ana,
        fromDate: "2026-08-01",
        toDate: "2026-10-31",
      }),
    ).rejects.toThrow(/At most 62 days/);

    const day = (name: string) =>
      as(name).query(api.analytics.agent_metrics.forDay, {
        serviceDate: date,
        paginationOpts: { numItems: 50, cursor: null },
      });
    expect((await day("managerA")).page.map((row) => row.profileId)).toEqual([
      ids.ana,
    ]);
    expect((await day("managerB")).page.map((row) => row.profileId)).toEqual([
      ids.cara,
    ]);
    expect((await day("Cara")).page.map((row) => row.profileId)).toEqual([
      ids.cara,
    ]);
    expect((await day("analyst")).page).toHaveLength(2);
  });
});
