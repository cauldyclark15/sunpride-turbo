import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { append } from "../visits/events";
import {
  emptyMetrics,
  orderFigures,
  plannedFigures,
  rollupHeadline,
  sameContribution,
  visitFigures,
  type Contribution,
} from "./rollups_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Wednesday 2026-09-30, 15:00 Manila.
const date = "2026-09-30";
const now = Date.parse("2026-09-30T07:00:00Z");
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("rollup counting rules", () => {
  it("counts sales and returns like the DSR and folds lines per SKU", () => {
    expect(
      orderFigures({ status: "draft", total: 100 }, [], "sunpride"),
    ).toBeNull();
    expect(
      orderFigures({ status: "voided", total: 100 }, [], "sunpride"),
    ).toBeNull();
    expect(
      orderFigures(
        { organizationId: "other", status: "posted", total: 100 },
        [],
        "sunpride",
      ),
    ).toBeNull();
    const sale = orderFigures(
      { status: "pending_approval", total: 150.25 },
      [
        { productCode: "SKU-B", quantity: 2, lineTotal: 100 },
        { productCode: "SKU-A", quantity: 1, lineTotal: 25.25 },
        { productCode: "SKU-B", quantity: 1, lineTotal: 25 },
      ],
      "sunpride",
    )!;
    expect(sale.metrics).toMatchObject({ orders: 1, salesMinor: 15_025 });
    expect(sale.skus).toEqual([
      {
        productCode: "SKU-A",
        orders: 1,
        quantity: 1,
        salesMinor: 2_525,
        returnOrders: 0,
        returnQuantity: 0,
        returnsMinor: 0,
      },
      {
        productCode: "SKU-B",
        orders: 1,
        quantity: 3,
        salesMinor: 12_500,
        returnOrders: 0,
        returnQuantity: 0,
        returnsMinor: 0,
      },
    ]);
    const ret = orderFigures(
      { status: "posted", total: -50 },
      [{ productCode: "SKU-B", quantity: -2, lineTotal: -50 }],
      "sunpride",
    )!;
    expect(ret.metrics).toMatchObject({
      orders: 0,
      returnOrders: 1,
      returnsMinor: 5_000,
    });
    expect(ret.skus[0]).toMatchObject({
      orders: 0,
      returnOrders: 1,
      returnQuantity: 2,
      returnsMinor: 5_000,
    });
  });

  it("judges calls per visit exactly as the DAR does", () => {
    const base = {
      state: "checked-out",
      source: "planned" as const,
      plannedVisitId: "pv" as Id<"plannedVisits">,
      collections: [],
    };
    // A truck seller's merchandising-only visit is a call but not productive.
    expect(
      visitFigures({
        ...base,
        activityKinds: ["merchandising"],
        rule: "truck_seller",
      }),
    ).toMatchObject({
      visits: 1,
      completedVisits: 1,
      calls: 1,
      productiveCalls: 0,
    });
    expect(
      visitFigures({
        ...base,
        activityKinds: ["merchandising"],
        rule: "any_listed_activity",
      }),
    ).toMatchObject({ calls: 1, productiveCalls: 1 });
    // Off-plan: a visit, never a call.
    expect(
      visitFigures({
        ...base,
        source: "unplanned",
        plannedVisitId: undefined,
        activityKinds: ["order_intent"],
        rule: "any_listed_activity",
      }),
    ).toMatchObject({ visits: 1, unplannedVisits: 1, calls: 0 });
    // A rejected collection neither counts nor makes the call productive.
    expect(
      visitFigures({
        ...base,
        activityKinds: [],
        collections: [
          { status: "rejected", amountMinor: 900 },
          { status: "recorded", amountMinor: 1_000 },
        ],
        rule: "any_listed_activity",
      }),
    ).toMatchObject({
      collections: 1,
      collectionsMinor: 1_000,
      productiveCalls: 1,
    });
    expect(plannedFigures({ status: "cancelled", done: false })).toBeNull();
    expect(plannedFigures({ status: "planned", done: true })).toMatchObject({
      plannedCalls: 1,
      plannedCallsDone: 1,
    });
  });

  it("compares contributions independently of key order and sums before dividing", () => {
    const a: Contribution = {
      serviceDate: date,
      orgUnitId: "u" as Id<"orgUnits">,
      metrics: { ...emptyMetrics(), orders: 1 },
      skus: [
        {
          productCode: "X",
          orders: 1,
          quantity: 1,
          salesMinor: 1,
          returnOrders: 0,
          returnQuantity: 0,
          returnsMinor: 0,
        },
      ],
      complete: true,
    };
    const reordered = {
      ...a,
      skus: [
        {
          returnsMinor: 0,
          returnQuantity: 0,
          returnOrders: 0,
          salesMinor: 1,
          quantity: 1,
          orders: 1,
          productCode: "X",
        },
      ],
    };
    expect(sameContribution(a, reordered)).toBe(true);
    expect(
      sameContribution(a, { ...a, territoryId: "t" as Id<"territories"> }),
    ).toBe(false);
    expect(sameContribution(null, null)).toBe(true);
    expect(
      rollupHeadline({
        ...emptyMetrics(),
        calls: 35,
        productiveCalls: 30,
        salesMinor: 1_000,
        returnsMinor: 250,
      }),
    ).toEqual({
      netSalesMinor: 750,
      productivePct: 85,
      planCompletionPct: null,
    });
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 60 * DAY;
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: `Unit ${code}`,
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
    const rds = await ctx.db.insert("positions", {
      organizationId: "sunpride",
      code: "RDS",
      label: "Route Distribution Salesman (RDS)",
      category: "field",
      active: true,
      createdAt: since,
      updatedAt: since,
    });
    await ctx.db.insert("positionStandards", {
      organizationId: "sunpride",
      positionId: rds,
      effectiveFrom: since,
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
      productiveCallRule: "truck_seller",
      sellingWeekdays: [1, 2, 3, 4, 5, 6],
      sourceRef: "call 2026-10-02",
      createdAt: since,
      updatedAt: since,
    });
    const person = async (
      name: string,
      role: "sales" | "manager" | "analyst",
      orgUnitId: Id<"orgUnits">,
      positionId?: Id<"positions">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        ...(positionId ? { positionId } : {}),
        updatedAt: since,
      });
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        ...(positionId ? { positionId } : {}),
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
    const ana = await person("Ana", "sales", regionA, rds);
    const territory = async (code: string, owner: Id<"orgUnits">) => {
      const id = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code,
        name: `Territory ${code}`,
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const ownership = await ctx.db.insert("territoryOwnerships", {
        territoryId: id,
        orgUnitId: owner,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, ownership };
    };
    const ta = await territory("T-A", regionA);
    const tb = await territory("T-B", regionB);
    const store = async (
      code: string,
      t: typeof ta,
      custodian: Id<"orgUnits">,
    ) => {
      const outletId = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O-${code}`,
        name: `Outlet ${code}`,
        status: "active",
        custodianOrgUnitId: custodian,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const outletAssignment = await ctx.db.insert("outletAssignments", {
        outletId,
        territoryId: t.id,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      const customerId = await ctx.db.insert("customers", {
        code,
        name: `Customer ${code}`,
        channel: "GT",
        territory: t === ta ? "T-A" : "T-B",
        creditLimit: 0,
        active: true,
        updatedAt: since,
      });
      await ctx.db.insert("outletCustomerLinks", {
        outletId,
        customerId,
        source: "fixture",
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { outletId, outletAssignment, customerId };
    };
    const c1 = await store("C-1", ta, regionA);
    const c2 = await store("C-2", ta, regionA);
    const c3 = await store("C-3", tb, regionB);
    await ctx.db.insert("salesAssignments", {
      salespersonSubject: subject("Ana"),
      customerCode: "C-1",
      territory: "T-A",
      active: true,
      updatedAt: since,
    });
    return { root, regionA, regionB, ana, ta, tb, c1, c2, c3 };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  const order = (args: {
    n: number;
    customer: string;
    total: number;
    lines: { productCode: string; quantity: number; lineTotal: number }[];
    status?: "posted" | "draft" | "voided";
    createdAt?: number;
    offlineCreatedAt?: number;
  }) =>
    t.run(async (ctx) => {
      const createdAt = args.createdAt ?? now - HOUR;
      const id = await ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${args.n}`,
        orderNumber: `SI-${args.n}`,
        customerCode: args.customer,
        salespersonSubject: subject("Ana"),
        status: args.status ?? "posted",
        subtotal: args.total,
        total: args.total,
        ...(args.offlineCreatedAt
          ? { offlineCreatedAt: args.offlineCreatedAt }
          : {}),
        createdAt,
        updatedAt: createdAt,
      });
      for (const line of args.lines)
        await ctx.db.insert("orderLines", {
          orderId: id,
          productCode: line.productCode,
          description: line.productCode,
          quantity: line.quantity,
          unitPrice: line.quantity ? line.lineTotal / line.quantity : 0,
          lineTotal: line.lineTotal,
        });
      return id;
    });
  const refresh = (
    sourceKind: "order" | "visit" | "planned",
    sourceId: string,
  ) => t.mutation(internal.analytics.rollups.refresh, { sourceKind, sourceId });
  const rows = () =>
    t.run(async (ctx) => ({
      territory: await ctx.db.query("dailyTerritoryMetrics").collect(),
      customer: await ctx.db.query("dailyCustomerMetrics").collect(),
      sku: await ctx.db.query("dailySkuMetrics").collect(),
      contributions: await ctx.db.query("rollupContributions").collect(),
    }));
  return { t, ids, as, order, refresh, rows };
}

describe("territory/customer/SKU rollups", () => {
  it("adds orders to their territory, customer and SKU rows and stays exact on change", async () => {
    const { t, ids, order, refresh, rows } = await fixture();
    const o1 = await order({
      n: 1,
      customer: "C-1",
      total: 300,
      lines: [
        { productCode: "SKU-A", quantity: 2, lineTotal: 200 },
        { productCode: "SKU-B", quantity: 1, lineTotal: 100 },
      ],
    });
    const o2 = await order({
      n: 2,
      customer: "C-2",
      total: 50,
      lines: [{ productCode: "SKU-A", quantity: 1, lineTotal: 50 }],
    });
    const draft = await order({
      n: 3,
      customer: "C-1",
      total: 999,
      status: "draft",
      lines: [{ productCode: "SKU-A", quantity: 9, lineTotal: 999 }],
    });
    // Written offline yesterday, synced today: yesterday's sale.
    const late = await order({
      n: 4,
      customer: "C-3",
      total: 70,
      offlineCreatedAt: now - DAY,
      lines: [{ productCode: "SKU-A", quantity: 1, lineTotal: 70 }],
    });
    expect(await refresh("order", o1)).toBe("updated");
    expect(await refresh("order", o2)).toBe("updated");
    expect(await refresh("order", draft)).toBe("none");
    expect(await refresh("order", late)).toBe("updated");
    // Refreshing again changes nothing.
    expect(await refresh("order", o1)).toBe("unchanged");

    let r = await rows();
    const ta = r.territory.find(
      (row) => row.territoryId === ids.ta.id && row.serviceDate === date,
    )!;
    expect(ta).toMatchObject({
      orgUnitId: ids.regionA,
      orders: 2,
      salesMinor: 35_000,
      buyingCustomers: 2,
    });
    const tb = r.territory.find((row) => row.territoryId === ids.tb.id)!;
    expect(tb).toMatchObject({
      serviceDate: "2026-09-29",
      orgUnitId: ids.regionB,
      orders: 1,
    });
    expect(r.customer.find((row) => row.customerCode === "C-1")).toMatchObject({
      territoryId: ids.ta.id,
      customerId: ids.c1.customerId,
      orders: 1,
      salesMinor: 30_000,
    });
    const skuA = r.sku.find(
      (row) =>
        row.productCode === "SKU-A" &&
        row.serviceDate === date &&
        row.orgUnitId === ids.regionA,
    )!;
    expect(skuA).toMatchObject({ orders: 2, quantity: 3, salesMinor: 25_000 });

    // A return against C-1 nets off; voiding o2 removes it everywhere.
    const ret = await order({
      n: 5,
      customer: "C-1",
      total: -100,
      lines: [{ productCode: "SKU-A", quantity: -1, lineTotal: -100 }],
    });
    await refresh("order", ret);
    await t.run(async (ctx) => {
      await ctx.db.patch(o2, { status: "voided" });
    });
    expect(await refresh("order", o2)).toBe("removed");
    r = await rows();
    expect(
      r.territory.find(
        (row) => row.territoryId === ids.ta.id && row.serviceDate === date,
      ),
    ).toMatchObject({
      orders: 1,
      salesMinor: 30_000,
      returnOrders: 1,
      returnsMinor: 10_000,
      buyingCustomers: 1,
    });
    expect(
      r.customer.find((row) => row.customerCode === "C-2"),
    ).toBeUndefined();
    expect(
      r.sku.find(
        (row) => row.productCode === "SKU-A" && row.serviceDate === date,
      ),
    ).toMatchObject({
      orders: 1,
      quantity: 2,
      salesMinor: 20_000,
      returnOrders: 1,
      returnQuantity: 1,
      returnsMinor: 10_000,
    });
    expect(r.contributions.map((row) => row.sourceId).sort()).toEqual(
      [o1, late, ret].sort(),
    );
  });

  it("moves a contribution when the outlet changes territory", async () => {
    const { t, ids, order, refresh, rows } = await fixture();
    const o1 = await order({
      n: 1,
      customer: "C-1",
      total: 100,
      lines: [{ productCode: "SKU-A", quantity: 1, lineTotal: 100 }],
    });
    await refresh("order", o1);
    // Correct the assignment retroactively (as a data fix would) to territory B.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.c1.outletAssignment, { territoryId: ids.tb.id });
    });
    expect(await refresh("order", o1)).toBe("updated");
    const r = await rows();
    expect(r.territory).toHaveLength(1);
    expect(r.territory[0]).toMatchObject({
      territoryId: ids.tb.id,
      orgUnitId: ids.regionB,
      orders: 1,
      buyingCustomers: 1,
    });
    expect(r.customer).toHaveLength(1);
    expect(r.customer[0]).toMatchObject({ territoryId: ids.tb.id });
    expect(r.sku).toHaveLength(1);
    expect(r.sku[0]).toMatchObject({ orgUnitId: ids.regionB });
  });

  it("counts planned stops, calls and productive calls per territory and customer", async () => {
    const { t, ids, refresh, rows } = await fixture();
    const { plan, planned, visitId, offPlan } = await t.run(async (ctx) => {
      const since = now - 60 * DAY;
      const plan = await ctx.db.insert("coveragePlans", {
        organizationId: "sunpride",
        assigneeProfileId: ids.ana.id,
        localMonth: "2026-09",
        version: 1,
        cycleType: "monthly",
        orgUnitId: ids.regionA,
        territoryIds: [ids.ta.id],
        requestedFrom: since,
        requestedTo: now + 10 * DAY,
        effectiveFrom: since,
        effectiveTo: now + 10 * DAY,
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
      const planned: Id<"plannedVisits">[] = [];
      for (const [n, stop] of [ids.c1, ids.c2].entries()) {
        const approvedSnapshot = {
          outletId: stop.outletId,
          outletCode: `O-${n}`,
          outletName: `Outlet ${n}`,
          customerId: stop.customerId,
          territoryId: ids.ta.id,
          territoryCode: "T-A",
          outletAssignmentId: stop.outletAssignment,
          territoryOwnershipId: ids.ta.ownership,
          employeeAssignmentId: ids.ana.assignment,
          orgUnitId: ids.regionA,
          activityKind: "sell",
          approvedAssigneeProfileId: ids.ana.id,
        };
        const slot = await ctx.db.insert("coveragePlanSlots", {
          slotKey: `slot-${n}`,
          planId: plan,
          assigneeProfileId: ids.ana.id,
          serviceDate: date,
          kind: "outlet_visit",
          outletId: stop.outletId,
          activityKind: "sell",
          requiredObjectives: [],
          intents: ["sell"],
          sequence: n + 1,
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
            assigneeProfileId: ids.ana.id,
            outletId: stop.outletId,
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
        key: string,
        outletId: Id<"outlets">,
        plannedVisitId?: Id<"plannedVisits">,
      ) =>
        ctx.db.insert("visitExecutions", {
          organizationId: "sunpride",
          clientVisitId: key,
          assigneeProfileId: ids.ana.id,
          outletId,
          orgUnitId: ids.regionA,
          serviceDate: date,
          source: plannedVisitId ? "planned" : "unplanned",
          ...(plannedVisitId ? { plannedVisitId, planId: plan } : {}),
          intents: ["sell"],
          state: "checked-out",
          productivity: "pending",
          createdAt: now - 3 * HOUR,
          lastServerTime: now - 2 * HOUR,
        });
      const visitId = await visit("v1", ids.c1.outletId, planned[0]);
      await ctx.db.insert("visitActivities", {
        organizationId: "sunpride",
        orgUnitId: ids.regionA,
        visitId,
        assigneeProfileId: ids.ana.id,
        outletId: ids.c1.outletId,
        activity: { kind: "order_intent", clientOrderId: "order-v1" },
        evidenceIds: [],
        deviceTime: now - 3 * HOUR,
        serverTime: now - 3 * HOUR,
      });
      const offPlan = await visit("v9", ids.c3.outletId);
      return { plan, planned, visitId, offPlan };
    });
    await t.mutation(internal.analytics.rollups.refreshPlan, { planId: plan });
    let r = await rows();
    // The plan refresh already sees the checked-out visit; the visit itself is not
    // counted until its own refresh.
    expect(r.territory[0]).toMatchObject({
      plannedCalls: 2,
      plannedCallsDone: 1,
      visits: 0,
    });
    // The visit refresh also refreshes the planned stop it fulfils (no double count).
    await refresh("visit", visitId);
    await refresh("visit", offPlan);
    r = await rows();
    expect(
      r.territory.find((row) => row.territoryId === ids.ta.id),
    ).toMatchObject({
      plannedCalls: 2,
      plannedCallsDone: 1,
      visits: 1,
      completedVisits: 1,
      calls: 1,
      productiveCalls: 1,
    });
    expect(
      r.territory.find((row) => row.territoryId === ids.tb.id),
    ).toMatchObject({ visits: 1, unplannedVisits: 1, calls: 0 });
    expect(r.customer.find((row) => row.customerCode === "C-1")).toMatchObject({
      plannedCalls: 1,
      plannedCallsDone: 1,
      calls: 1,
    });
    // Superseding the plan cancels the remaining stop.
    await t.run(async (ctx) => {
      await ctx.db.patch(planned[1]!, { status: "cancelled" });
    });
    await t.mutation(internal.analytics.rollups.refreshPlan, { planId: plan });
    r = await rows();
    expect(
      r.territory.find((row) => row.territoryId === ids.ta.id),
    ).toMatchObject({ plannedCalls: 1, plannedCallsDone: 1 });
    expect(
      r.customer.find((row) => row.customerCode === "C-2"),
    ).toBeUndefined();
  });

  it("refreshes from the order and visit-event hooks after the debounce", async () => {
    const { t, ids, as, rows } = await fixture();
    const orderId = await as("Ana").mutation(api.domains.orders.create, {
      clientRequestId: "hook-1",
      customerCode: "C-1",
      lines: [
        { productCode: "SKU-A", description: "A", quantity: 2, unitPrice: 60 },
      ],
    });
    // Nothing until the scheduled refresh runs.
    expect((await rows()).territory).toHaveLength(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let r = await rows();
    expect(r.territory[0]).toMatchObject({
      territoryId: ids.ta.id,
      orders: 1,
      salesMinor: 12_000,
    });
    expect(r.sku[0]).toMatchObject({ productCode: "SKU-A", quantity: 2 });
    await as("managerA").mutation(api.domains.orders.decide, {
      orderId,
      decision: "rejected",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await rows();
    expect(r.territory).toHaveLength(0);
    expect(r.customer).toHaveLength(0);
    expect(r.sku).toHaveLength(0);
    expect(r.contributions).toHaveLength(0);

    // A visit event queues its visit; repeated events share one pending refresh.
    await t.run(async (ctx) => {
      const visitId = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: "ev-1",
        assigneeProfileId: ids.ana.id,
        outletId: ids.c2.outletId,
        orgUnitId: ids.regionA,
        serviceDate: date,
        source: "unplanned",
        intents: ["sell"],
        state: "checked-in",
        productivity: "pending",
        createdAt: now,
        lastServerTime: now,
      });
      for (const kind of ["visit.checked_in", "visit.note"])
        await append(ctx, {
          orgUnitId: ids.regionA,
          entityType: "visit",
          entityId: visitId,
          kind,
          actorSubject: subject("Ana"),
          actorRole: "sales",
          actorOrgUnitId: ids.regionA,
          source: "mobile",
          occurredAt: now,
          serverAt: now,
          summary: {},
        });
      expect(await ctx.db.query("rollupRefreshes").collect()).toHaveLength(1);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await rows();
    expect(r.customer[0]).toMatchObject({ customerCode: "C-2", visits: 1 });
    expect(
      await t.run((ctx) => ctx.db.query("rollupRefreshes").collect()),
    ).toHaveLength(0);
  });

  it("backfills a whole source table idempotently", async () => {
    const { t, order, rows } = await fixture();
    for (let n = 1; n <= 30; n++)
      await order({
        n,
        customer: n % 2 ? "C-1" : "C-3",
        total: 10,
        lines: [{ productCode: "SKU-A", quantity: 1, lineTotal: 10 }],
      });
    const first = await t.mutation(internal.analytics.rollups.backfill, {
      source: "order",
    });
    expect(first).toMatchObject({ processed: 25, updated: 25, isDone: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let r = await rows();
    expect(r.contributions).toHaveLength(30);
    expect(r.sku.reduce((sum, row) => sum + row.quantity, 0)).toBe(30);
    // A second pass finds nothing to change.
    const again = await t.mutation(internal.analytics.rollups.backfill, {
      source: "order",
    });
    expect(again.updated).toBe(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await rows();
    expect(r.sku.reduce((sum, row) => sum + row.quantity, 0)).toBe(30);
    expect(r.territory.reduce((sum, row) => sum + row.buyingCustomers, 0)).toBe(
      2,
    );
  });

  it("limits readers to their scope and keeps field sales out", async () => {
    const { ids, as, order, refresh } = await fixture();
    for (const [n, customer] of [
      [1, "C-1"],
      [2, "C-3"],
    ] as const)
      await refresh(
        "order",
        await order({
          n,
          customer,
          total: 10,
          lines: [{ productCode: "SKU-A", quantity: 1, lineTotal: 10 }],
        }),
      );
    const page = { numItems: 50, cursor: null };
    const day = { serviceDate: date, paginationOpts: page };
    const a = await as("managerA").query(
      api.analytics.rollups.territoriesForDay,
      day,
    );
    expect(a.page.map((row) => row.territoryId)).toEqual([ids.ta.id]);
    const all = await as("analyst").query(
      api.analytics.rollups.skusForDay,
      day,
    );
    expect(all.page.reduce((sum, row) => sum + row.quantity, 0)).toBe(2);
    const own = await as("managerB").query(
      api.analytics.rollups.customersForDay,
      { ...day, orgUnitId: ids.regionB },
    );
    expect(own.page.map((row) => row.customerCode)).toEqual(["C-3"]);
    await expect(
      as("managerB").query(api.analytics.rollups.customersForDay, {
        ...day,
        orgUnitId: ids.regionA,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    const history = await as("managerB").query(
      api.analytics.rollups.territoryDays,
      { territoryId: ids.ta.id, fromDate: "2026-09-01", toDate: date },
    );
    expect(history).toEqual({ rows: [], truncated: false });
    const sku = await as("managerA").query(api.analytics.rollups.skuDays, {
      productCode: "SKU-A",
      fromDate: "2026-09-01",
      toDate: date,
    });
    expect(sku.rows.map((row) => row.orgUnitId)).toEqual([ids.regionA]);
    const customer = await as("managerA").query(
      api.analytics.rollups.customerDays,
      { customerCode: "C-1", fromDate: date, toDate: date },
    );
    expect(customer.rows).toHaveLength(1);
    await expect(
      as("Ana").query(api.analytics.rollups.territoriesForDay, day),
    ).rejects.toThrow(/Daily Sales Report/);
    await expect(
      as("managerA").query(api.analytics.rollups.territoryDays, {
        territoryId: ids.ta.id,
        fromDate: "2026-07-01",
        toDate: date,
      }),
    ).rejects.toThrow(/At most 62 days/);
  });
});
