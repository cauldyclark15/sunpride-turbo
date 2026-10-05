import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  addDays,
  customerPeriod,
  daysBetween,
  distributionSummary,
  MAX_CUSTOMER_WEEKS,
  orderTrend,
  plannedCallSummary,
  visitRegularity,
  weekIndex,
  weeksError,
} from "./customer_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const AS_OF = "2026-09-29"; // Tuesday
// 11:00 Manila on AS_OF: that day is still open, the 26th has closed.
const now = Date.parse("2026-09-29T03:00:00Z");
const at = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00+08:00`);
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 120 * 24 * HOUR;
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code === "SUNPRIDE" ? "National" : `Region ${code}`,
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
    const person = async (
      name: string,
      role: "sales" | "manager" | "viewer",
      orgUnitId: Id<"orgUnits">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: since,
      });
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    await person("managerA", "manager", regionA);
    await person("managerB", "manager", regionB);
    await person("viewerA", "viewer", regionA);
    const ana = await person("Ana", "sales", regionA);

    const territory = async (code: string, orgUnitId: Id<"orgUnits">) => {
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
        orgUnitId,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, ownership };
    };
    const tA = await territory("T-A", regionA);
    const tB = await territory("T-B", regionB);
    const customer = (code: string) =>
      ctx.db.insert("customers", {
        code,
        name: `Customer ${code}`,
        channel: "GT",
        territory: "T-A",
        creditLimit: 0,
        active: true,
        updatedAt: since,
      });
    const c1 = await customer("C1");
    const c3 = await customer("C3");
    const outlet = async (
      code: string,
      t: { id: Id<"territories"> },
      customerId: Id<"customers">,
      cycleDays?: number,
    ) => {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code,
        name: `Store ${code}`,
        status: "active",
        channel: "General Trade",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const assignment = await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId: t.id,
        sequence: 1,
        ...(cycleDays ? { cycleDays } : {}),
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      await ctx.db.insert("outletCustomerLinks", {
        outletId: id,
        customerId,
        source: "fixture",
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    const o1 = await outlet("O1", tA, c1, 7);
    // O2 shares O1's accounting customer; O3 belongs to region B.
    const o2 = await outlet("O2", tA, c1);
    const o3 = await outlet("O3", tB, c3);

    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [tA.id],
      requestedFrom: since,
      requestedTo: now + 10 * 24 * HOUR,
      effectiveFrom: since,
      effectiveTo: now + 10 * 24 * HOUR,
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
    let n = 0;
    const stop = async (
      serviceDate: string,
      status: "planned" | "cancelled" = "planned",
    ) => {
      const approvedSnapshot = {
        outletId: o1.id,
        outletCode: "O1",
        outletName: "Store O1",
        territoryId: tA.id,
        territoryCode: "T-A",
        routeCode: "R-1",
        sequence: 1,
        outletAssignmentId: o1.assignment,
        territoryOwnershipId: tA.ownership,
        employeeAssignmentId: ana.assignment,
        orgUnitId: regionA,
        activityKind: "sell",
        approvedAssigneeProfileId: ana.id,
      };
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: `slot-${++n}`,
        planId: plan,
        assigneeProfileId: ana.id,
        serviceDate,
        kind: "outlet_visit",
        outletId: o1.id,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: 1,
        expectedDurationMinutes: 20,
        approvedSnapshot,
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: since,
      });
      return await ctx.db.insert("plannedVisits", {
        generationKey: `gen-${n}`,
        planId: plan,
        planVersion: 1,
        planSlotId: slot,
        assigneeProfileId: ana.id,
        outletId: o1.id,
        serviceDate,
        status,
        approvedSnapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 20,
        generatedAt: since,
      });
    };
    const visit = (
      serviceDate: string,
      fields: {
        outletId?: Id<"outlets">;
        plannedVisitId?: Id<"plannedVisits">;
        state?: "checked-out" | "checked-in";
      } = {},
    ) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${++n}`,
        assigneeProfileId: ana.id,
        outletId: fields.outletId ?? o1.id,
        orgUnitId: regionA,
        serviceDate,
        source: fields.plannedVisitId ? "planned" : "unplanned",
        intents: ["sell"],
        state: fields.state ?? "checked-out",
        productivity: "pending",
        createdAt: at(serviceDate, "09:00"),
        lastServerTime: at(serviceDate, "09:20"),
        checkedInAt: at(serviceDate, "09:00"),
        ...(fields.state === "checked-in"
          ? {}
          : { checkedOutAt: at(serviceDate, "09:20") }),
        ...(fields.plannedVisitId
          ? { plannedVisitId: fields.plannedVisitId, planId: plan }
          : {}),
      });

    // Visits: one before the period, then 25 Aug, 8, 15 and 22 Sep (22 Sep twice).
    await visit("2026-07-28");
    await visit("2026-08-25");
    for (const date of ["2026-09-08", "2026-09-15", "2026-09-22"])
      await visit(date, { plannedVisitId: await stop(date) });
    await visit("2026-09-22");
    // 26 Sep planned but not visited (closed: missed); 29 Sep still open; 27 Sep cancelled.
    await stop("2026-09-26");
    const today = await stop(AS_OF);
    await visit(AS_OF, { plannedVisitId: today, state: "checked-in" });
    await stop("2026-09-27", "cancelled");
    // Another store's visit never counts here.
    await visit("2026-09-24", { outletId: o2.id });

    const product = (code: string) =>
      ctx.db.insert("products", {
        code,
        name: `Product ${code}`,
        category: "Canned",
        uom: "CS",
        unitPrice: 100,
        active: true,
        updatedAt: since,
      });
    const p1 = await product("P1");
    const p2 = await product("P2");
    const p3 = await product("P3");
    await product("P9");
    let r = 0;
    const order = async (
      date: string,
      total: number,
      lines: string[] = [],
      status: "submitted" | "draft" = "submitted",
    ) => {
      const id = await ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${++r}`,
        orderNumber: `SO-${r}`,
        customerCode: "C1",
        salespersonSubject: subject("Ana"),
        status,
        subtotal: total,
        total,
        createdAt: at(date, "10:00"),
        updatedAt: at(date, "10:00"),
      });
      for (const code of lines)
        await ctx.db.insert("orderLines", {
          orderId: id,
          productCode: code,
          description: code,
          quantity: 5,
          unitPrice: 100,
          lineTotal: 500,
        });
    };
    await order("2026-08-20", 2000, ["P2"]);
    await order("2026-09-08", 1000, ["P1", "P2", "P9"]);
    await order("2026-09-22", 500, ["P1"]);
    await order("2026-09-23", -100);
    await order("2026-09-25", 9000, ["P3"], "draft");

    await ctx.db.insert("outletAssortments", {
      organizationId: "sunpride",
      outletId: o1.id,
      productIds: [p1, p2, p3],
      effectiveFrom: since,
      sourceRef: "fixture",
      actorSubject: subject("managerA"),
      createdAt: since,
    });
    const auditVisit = await visit("2026-09-22");
    const audit = await ctx.db.insert("merchandisingAudits", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      visitId: auditVisit,
      outletId: o1.id,
      assigneeProfileId: ana.id,
      serviceDate: "2026-09-22",
      clientAuditId: "audit-1",
      payloadHash: "hash",
      auditVersion: "v1",
      requiredCount: 3,
      requiredAvailableCount: 1,
      requiredOutOfStockCount: 1,
      missingRequiredProductIds: [p3],
      evidenceIds: [],
      actorSubject: subject("Ana"),
      source: "mobile",
      deviceTime: at("2026-09-22", "09:10"),
      serverTime: at("2026-09-22", "09:10"),
    });
    for (const [productId, status] of [
      [p1, "available"],
      [p2, "out_of_stock"],
    ] as const)
      await ctx.db.insert("merchandisingAvailability", {
        organizationId: "sunpride",
        orgUnitId: regionA,
        auditId: audit,
        outletId: o1.id,
        productId,
        serviceDate: "2026-09-22",
        required: true,
        status,
        ...(status === "available" ? { facings: 4 } : {}),
        evidenceIds: [],
      });
    return { o1: o1.id, o2: o2.id, o3: o3.id, regionA, regionB };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

describe("customer execution rules", () => {
  it("builds whole weeks ending on the selected date", () => {
    const period = customerPeriod(AS_OF, 2);
    expect(period).toEqual({
      from: "2026-09-16",
      to: AS_OF,
      weekStarts: ["2026-09-16", "2026-09-23"],
    });
    expect(weekIndex(period, "2026-09-16")).toBe(0);
    expect(weekIndex(period, "2026-09-22")).toBe(0);
    expect(weekIndex(period, "2026-09-23")).toBe(1);
    expect(weekIndex(period, "2026-09-15")).toBe(-1);
    expect(weekIndex(period, "2026-09-30")).toBe(-1);
    expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weeksError(0)).toMatch(/1 to 13/);
    expect(weeksError(1.5)).toMatch(/weeks/);
    expect(weeksError(MAX_CUSTOMER_WEEKS)).toBeNull();
    expect(weeksError(MAX_CUSTOMER_WEEKS + 1)).not.toBeNull();
  });

  it("judges visit regularity against the expected cycle", () => {
    const base = {
      visitDates: ["2026-09-15", "2026-09-08", "2026-09-15", "2026-09-29"],
      lastVisitBefore: "2026-08-25",
      asOfDate: AS_OF,
    };
    expect(visitRegularity({ ...base, expectedCycleDays: 7 })).toEqual({
      visitDays: 3,
      lastVisitDate: AS_OF,
      daysSinceLastVisit: 0,
      expectedCycleDays: 7,
      averageGapDays: 11.7,
      longestGapDays: 14,
      gaps: 3,
      gapsOnCadence: 1,
      onCadencePct: 33,
      status: "on_cadence",
    });
    expect(
      visitRegularity({
        visitDates: ["2026-09-15"],
        lastVisitBefore: null,
        asOfDate: AS_OF,
        expectedCycleDays: 7,
      }),
    ).toMatchObject({ daysSinceLastVisit: 14, status: "overdue", gaps: 0 });
    expect(visitRegularity({ ...base, expectedCycleDays: null })).toMatchObject(
      { status: "no_cadence", onCadencePct: null },
    );
    expect(
      visitRegularity({
        visitDates: [],
        lastVisitBefore: null,
        asOfDate: AS_OF,
        expectedCycleDays: 7,
      }),
    ).toMatchObject({
      status: "not_visited",
      lastVisitDate: null,
      daysSinceLastVisit: null,
    });
  });

  it("compares the latest four weeks of sales with the four before", () => {
    const week = (sales: number) => ({ orders: sales ? 1 : 0, sales });
    expect(
      orderTrend([100, 100, 100, 100, 50, 50, 50, 50].map(week)),
    ).toMatchObject({
      recentSales: 200,
      priorSales: 400,
      changePct: -50,
      direction: "down",
    });
    expect(orderTrend([100, 0, 0, 0, 105, 0, 0, 0].map(week))).toMatchObject({
      changePct: 5,
      direction: "steady",
    });
    expect(orderTrend([0, 0, 0, 0, 0, 0, 0, 10].map(week))).toMatchObject({
      changePct: null,
      direction: "new",
    });
    // Fewer than eight weeks: nothing to compare against.
    expect(orderTrend([10, 10].map(week))).toMatchObject({
      priorSales: null,
      direction: "new",
    });
    expect(orderTrend([0, 0].map(week)).direction).toBe("none");
  });

  it("splits planned stops into done, missed and still due", () => {
    expect(
      plannedCallSummary([
        { serviceDate: "a", closed: true, done: true },
        { serviceDate: "b", closed: true, done: false },
        { serviceDate: "c", closed: false, done: false },
        { serviceDate: "d", closed: false, done: true },
      ]),
    ).toEqual({ planned: 4, done: 2, missed: 1, pending: 1, missedPct: 33 });
    expect(plannedCallSummary([]).missedPct).toBeNull();
  });

  it("summarizes distribution and availability of the required assortment", () => {
    expect(
      distributionSummary([
        { ordered: true, availability: "available" },
        { ordered: false, availability: "low_stock" },
        { ordered: false, availability: "out_of_stock" },
        { ordered: false, availability: null },
        { ordered: true, availability: "not_carried" },
      ]),
    ).toEqual({
      required: 5,
      ordered: 2,
      distributionPct: 40,
      checked: 4,
      available: 2,
      outOfStock: 1,
      notCarried: 1,
      availabilityPct: 50,
      gaps: 2,
    });
    expect(distributionSummary([])).toMatchObject({
      distributionPct: null,
      availabilityPct: null,
    });
  });
});

describe("customer execution dashboard", () => {
  it("shows a store's visit regularity, order trend, days since last order, missed calls and assortment", async () => {
    const { ids, as } = await fixture();
    const row = await as("managerA").query(api.analytics.customer.store, {
      outletId: ids.o1,
      asOfDate: AS_OF,
      weeks: 8,
    });
    expect(row.from).toBe("2026-08-05");
    expect(row.to).toBe(AS_OF);
    expect(row.outlet).toMatchObject({
      code: "O1",
      unitName: "Region A",
      territory: "T-A · Territory T-A",
      channel: "General Trade",
    });
    expect(row.customer).toEqual({
      code: "C1",
      name: "Customer C1",
      sharedWithOtherOutlets: true,
    });
    // Visit days 25 Aug, 8/15/22 Sep (22 Sep twice is one day; the open 29 Sep visit and
    // another store's visit do not count); 28 Jul precedes the period.
    expect(row.regularity).toEqual({
      visitDays: 4,
      lastVisitDate: "2026-09-22",
      daysSinceLastVisit: 7,
      expectedCycleDays: 7,
      averageGapDays: 14,
      longestGapDays: 28,
      gaps: 4,
      gapsOnCadence: 2,
      onCadencePct: 50,
      status: "on_cadence",
    });
    expect(row.plannedCalls).toEqual({
      planned: 5,
      done: 3,
      missed: 1,
      pending: 1,
      missedPct: 25,
      recentMissed: [
        { serviceDate: "2026-09-26", assigneeName: "Ana", route: "R-1" },
      ],
    });
    // Sales in centavos: 2,000 (20 Aug) before; 1,000 + 500 − 100 in the latest 4 weeks.
    expect(row.orders).toEqual({
      orders: 4,
      sales: 340_000,
      averageOrder: 116_667,
      lastOrderDate: "2026-09-22",
      lastOrderAmount: 50_000,
      daysSinceLastOrder: 7,
      recentSales: 140_000,
      recentOrders: 3,
      priorSales: 200_000,
      changePct: -30,
      direction: "down",
      skusBought: 3,
    });
    expect(row.weeks).toHaveLength(8);
    expect(row.weeks[4]).toMatchObject({
      weekStart: "2026-09-02",
      visitDays: 1,
      planned: 1,
      plannedDone: 1,
      orders: 1,
      sales: 100_000,
    });
    expect(row.weeks[6]).toMatchObject({
      weekStart: "2026-09-16",
      visits: 3,
      visitDays: 1,
      unplannedVisits: 2,
    });
    expect(row.weeks[7]).toMatchObject({
      weekStart: "2026-09-23",
      planned: 2,
      plannedDone: 0,
      missed: 1,
      orders: 1,
      sales: -10_000,
    });
    // Required P1/P2/P3: P1 and P2 ordered; the 22 Sep audit found P1 on shelf, P2 out.
    expect(row.assortment).toMatchObject({
      hasAssortment: true,
      required: 3,
      ordered: 2,
      distributionPct: 66,
      checked: 2,
      available: 1,
      outOfStock: 1,
      availabilityPct: 50,
      gaps: 1,
      lastAuditDate: "2026-09-22",
    });
    expect(
      row.assortment.skus.map((sku) => [
        sku.code,
        sku.lastOrderedDate,
        sku.availability,
        sku.facings,
      ]),
    ).toEqual([
      ["P1", "2026-09-22", "available", 4],
      ["P2", "2026-09-08", "out_of_stock", null],
      ["P3", null, null, null],
    ]);
    expect(row.truncated).toBe(false);
  });

  it("shows a store with nothing recorded without inventing figures", async () => {
    const { ids, as } = await fixture();
    const row = await as("viewerA").query(api.analytics.customer.store, {
      outletId: ids.o2,
      asOfDate: AS_OF,
      weeks: 2,
    });
    expect(row.regularity).toMatchObject({
      visitDays: 1,
      expectedCycleDays: null,
      status: "no_cadence",
    });
    expect(row.plannedCalls).toMatchObject({ planned: 0, missedPct: null });
    expect(row.assortment).toMatchObject({
      hasAssortment: false,
      required: 0,
      distributionPct: null,
      lastAuditDate: null,
      skus: [],
    });
    // The shared customer's orders show on both of its stores.
    expect(row.orders.lastOrderDate).toBe("2026-09-22");
    expect(row.orders.direction).toBe("new");
  });

  it("keeps each reader inside their own scope", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("managerB").query(api.analytics.customer.store, {
        outletId: ids.o1,
        asOfDate: AS_OF,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("managerA").query(api.analytics.customer.store, {
        outletId: ids.o3,
        asOfDate: AS_OF,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    // Field sales have no team view.
    await expect(
      as("Ana").query(api.analytics.customer.store, {
        outletId: ids.o1,
        asOfDate: AS_OF,
      }),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.analytics.customer.store, {
        outletId: ids.o1,
        asOfDate: AS_OF,
        weeks: 14,
      }),
    ).rejects.toThrow(/1 to 13 weeks/);
    await expect(
      as("managerA").query(api.analytics.customer.store, {
        outletId: ids.o1,
        asOfDate: "2026-02-30",
      }),
    ).rejects.toThrow(/Invalid Manila date/);
  });

  it("lists only stores owned inside the selected scope, with search", async () => {
    const { ids, as } = await fixture();
    const page = { cursor: null, numItems: 50 };
    const a = await as("managerA").query(api.analytics.customer.stores, {
      asOfDate: AS_OF,
      paginationOpts: page,
    });
    expect(a.page.map((row) => row.code)).toEqual(["O1", "O2"]);
    expect(a.isDone).toBe(true);
    const search = await as("managerA").query(api.analytics.customer.stores, {
      asOfDate: AS_OF,
      search: " o2 ",
      paginationOpts: page,
    });
    expect(search.page.map((row) => row.code)).toEqual(["O2"]);
    const b = await as("managerB").query(api.analytics.customer.stores, {
      asOfDate: AS_OF,
      paginationOpts: page,
    });
    expect(b.page.map((row) => row.code)).toEqual(["O3"]);
    await expect(
      as("managerB").query(api.analytics.customer.stores, {
        asOfDate: AS_OF,
        orgUnitId: ids.regionA,
        paginationOpts: page,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("managerA").query(api.analytics.customer.stores, {
        asOfDate: AS_OF,
        paginationOpts: { cursor: null, numItems: 500 },
      }),
    ).rejects.toThrow(/Page size/);
  });
});
