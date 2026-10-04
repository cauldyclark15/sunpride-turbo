import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  emptyTotals,
  headline,
  mergeTotals,
  outletCoverage,
  ratioPct,
  summarize,
  type ExecutionPersonRow,
} from "./model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Wednesday 2026-09-30, 15:00 Manila.
const date = "2026-09-30";
const now = Date.parse("2026-09-30T07:00:00Z");
const dayStart = Date.parse("2026-09-30T00:00:00+08:00");
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

const row = (over: Partial<ExecutionPersonRow>): ExecutionPersonRow => ({
  profileId: "p" as Id<"profiles">,
  name: "P",
  employeeCode: null,
  positionLabel: null,
  channel: "Route",
  orgUnitId: "u" as Id<"orgUnits">,
  sellingDay: true,
  scheduled: true,
  active: true,
  inField: false,
  planned: 0,
  plannedDone: 0,
  plannedOutlets: 0,
  coveredOutlets: 0,
  calls: 0,
  productiveCalls: 0,
  unplanned: 0,
  callsTarget: null,
  productiveTargetPct: null,
  sales: 0,
  salesTarget: null,
  firstCheckInAt: null,
  lastActivityAt: null,
  ...over,
});

describe("execution dashboard rules", () => {
  it("sums numerators and denominators instead of averaging percentages", () => {
    const totals = summarize([
      row({
        calls: 30,
        productiveCalls: 30,
        callsTarget: 30,
        productiveTargetPct: 85,
        sales: 100_00,
        salesTarget: 200_00,
      }),
      row({
        calls: 5,
        productiveCalls: 0,
        callsTarget: 5,
        productiveTargetPct: 90,
        sales: 50_00,
        salesTarget: null,
        active: false,
      }),
      row({ scheduled: false, active: false, calls: 0 }),
    ]);
    const figures = headline(totals);
    // 30 / 35, not the average of 100% and 0%.
    expect(figures.productivePct).toBe(85);
    expect(figures.callAttainmentPct).toBe(100);
    // Only targeted sales count against the target; the untargeted ₱50 is not attainment.
    expect(totals.sales).toBe(150_00);
    expect(figures.salesAttainmentPct).toBe(50);
    expect(totals.peopleWithSalesTarget).toBe(1);
    // Weighted by calls: (85×30 + 90×5) / 35 = 85.7 → 85.
    expect(figures.productiveTargetPct).toBe(85);
    expect(figures.activePct).toBe(50);
    expect(totals.people).toBe(3);
  });

  it("returns no percentage without a base and merges pages exactly", () => {
    expect(ratioPct(3, 0)).toBeNull();
    expect(ratioPct(2, 3)).toBe(66);
    const figures = headline(emptyTotals());
    expect(Object.values(figures).every((value) => value === null)).toBe(true);
    const a = summarize([row({ calls: 2, productiveCalls: 1 })]);
    const b = summarize([row({ calls: 3, productiveCalls: 3 })]);
    expect(mergeTotals(a, b)).toEqual(
      summarize([
        row({ calls: 2, productiveCalls: 1 }),
        row({ calls: 3, productiveCalls: 3 }),
      ]),
    );
  });

  it("counts each planned outlet once and ignores off-plan outlets", () => {
    expect(
      outletCoverage(["o1", "o1", "o2", "o3"], new Set(["o1", "o9"])),
    ).toEqual({ plannedOutlets: 3, coveredOutlets: 1 });
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
    const position = (code: string, label: string) =>
      ctx.db.insert("positions", {
        organizationId: "sunpride",
        code,
        label,
        category: "field",
        active: true,
        createdAt: since,
        updatedAt: since,
      });
    const rds = await position("RDS", "Route Distribution Salesman (RDS)");
    const kas = await position("KAS", "Key Account Specialist (KAS)");
    await ctx.db.insert("positionStandards", {
      organizationId: "sunpride",
      positionId: rds,
      effectiveFrom: since,
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
      productiveCallRule: "truck_seller",
      sellingWeekdays: [1, 2, 3, 4, 5, 6],
      sourceRef: "Sir Francis email 2026-09-30 / call 2026-10-02",
      createdAt: since,
      updatedAt: since,
    });
    await ctx.db.insert("positionStandards", {
      organizationId: "sunpride",
      positionId: kas,
      effectiveFrom: since,
      dailyCallsTarget: 5,
      productiveCallTargetPct: 90,
      productiveCallRule: "any_listed_activity",
      sellingWeekdays: [1, 2, 3, 4, 5, 6],
      sourceRef: "memo 2026-01-20 §2",
      createdAt: since,
      updatedAt: since,
    });
    const person = async (
      name: string,
      role: "sales" | "manager" | "operations",
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
    const managerA = await person("managerA", "manager", regionA);
    const managerB = await person("managerB", "manager", regionB);
    await person("opsA", "operations", regionA);
    const ana = await person("Ana", "sales", regionA, rds);
    const kim = await person("Kim", "sales", regionA, kas);
    const cara = await person("Cara", "sales", regionB, rds);
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
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [territory],
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
    const outlet = (code: string) =>
      ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code,
        name: `Outlet ${code}`,
        status: "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
    const stops: { planned: Id<"plannedVisits">; outlet: Id<"outlets"> }[] = [];
    for (const n of [1, 2, 3]) {
      const outletId = await outlet(`O${n}`);
      const outletAssignment = await ctx.db.insert("outletAssignments", {
        outletId,
        territoryId: territory,
        sequence: n,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      const approvedSnapshot = {
        outletId,
        outletCode: `O${n}`,
        outletName: `Outlet O${n}`,
        territoryId: territory,
        territoryCode: "T-A",
        sequence: n,
        outletAssignmentId: outletAssignment,
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
      const planned = await ctx.db.insert("plannedVisits", {
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
      });
      stops.push({ planned, outlet: outletId });
    }
    const extra = await outlet("O9");
    return {
      regionA,
      regionB,
      managerA,
      managerB,
      ana,
      kim,
      cara,
      plan,
      stops,
      extra,
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  const visit = (args: {
    key: string;
    outlet: Id<"outlets">;
    planned?: Id<"plannedVisits">;
    checkedInAt: number;
    state?: "checked-out" | "checked-in";
    activities: ("order_intent" | "merchandising" | "note")[];
  }) =>
    t.run(async (ctx) => {
      const state = args.state ?? "checked-out";
      const visitId = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: args.key,
        assigneeProfileId: ids.ana.id,
        outletId: args.outlet,
        orgUnitId: ids.regionA,
        serviceDate: date,
        source: args.planned ? "planned" : "unplanned",
        ...(args.planned
          ? { plannedVisitId: args.planned, planId: ids.plan }
          : {}),
        intents: ["sell"],
        state,
        productivity: "pending",
        createdAt: args.checkedInAt,
        lastServerTime: args.checkedInAt + HOUR / 2,
        checkedInAt: args.checkedInAt,
        ...(state === "checked-out"
          ? { checkedOutAt: args.checkedInAt + HOUR / 2 }
          : {}),
      });
      for (const kind of args.activities)
        await ctx.db.insert("visitActivities", {
          organizationId: "sunpride",
          orgUnitId: ids.regionA,
          visitId,
          assigneeProfileId: ids.ana.id,
          outletId: args.outlet,
          activity:
            kind === "order_intent"
              ? { kind, clientOrderId: `order-${args.key}` }
              : kind === "merchandising"
                ? { kind, displayCondition: "compliant" }
                : { kind, text: "note" },
          evidenceIds: [],
          deviceTime: args.checkedInAt,
          serverTime: args.checkedInAt,
        });
      return visitId;
    });
  const order = (
    who: string,
    n: number,
    total: number,
    createdAt: number,
    extra: { status?: "draft" | "posted"; offlineCreatedAt?: number } = {},
  ) =>
    t.run(async (ctx) => {
      await ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${n}`,
        orderNumber: `SI-${n}`,
        customerCode: "C-1",
        salespersonSubject: subject(who),
        status: extra.status ?? "posted",
        subtotal: total,
        total,
        ...(extra.offlineCreatedAt
          ? { offlineCreatedAt: extra.offlineCreatedAt }
          : {}),
        createdAt,
        updatedAt: createdAt,
      });
    });
  /** Ana's day: O1 ordered, O2 merchandising only (not productive for a truck seller),
   * O3 not visited, O9 off-plan; plus her orders. */
  const anaDay = async () => {
    await visit({
      key: "v1",
      outlet: ids.stops[0]!.outlet,
      planned: ids.stops[0]!.planned,
      checkedInAt: now - 5 * HOUR,
      activities: ["order_intent", "note"],
    });
    await visit({
      key: "v2",
      outlet: ids.stops[1]!.outlet,
      planned: ids.stops[1]!.planned,
      checkedInAt: now - 4 * HOUR,
      activities: ["merchandising"],
    });
    await visit({
      key: "v9",
      outlet: ids.extra,
      checkedInAt: now - 3 * HOUR,
      state: "checked-in",
      activities: ["order_intent"],
    });
    await order("Ana", 1, 1_000.5, now - 5 * HOUR);
    await order("Ana", 2, 500, now - 4 * HOUR, { status: "draft" });
    // Written offline yesterday, synced today: yesterday's sale.
    await order("Ana", 3, 700, now - HOUR, { offlineCreatedAt: now - DAY });
    await order("Kim", 4, 250, now - 2 * HOUR);
    await order("Cara", 5, 9_999, now - 2 * HOUR);
  };
  const salesTarget = (
    profileId: Id<"profiles">,
    period: "daily" | "monthly",
    value: number,
    effectiveFrom: number,
  ) =>
    t.run(async (ctx) => {
      await ctx.db.insert("salesTargets", {
        organizationId: "sunpride",
        subjectKind: "employee",
        profileId,
        period,
        metric: "sales_value",
        value,
        effectiveFrom,
        sourceRef: "fixture",
        createdBy: "fixture",
        createdAt: effectiveFrom,
        updatedAt: effectiveFrom,
      });
    });
  return { t, ids, as, visit, anaDay, salesTarget };
}

describe("daily execution dashboard", () => {
  it("shows each person's sales, attainment, coverage and calls in scope", async () => {
    const { ids, as, anaDay, salesTarget } = await fixture();
    await anaDay();
    await salesTarget(ids.ana.id, "daily", 2_000_00, dayStart - 10 * DAY);
    // Kim has only a monthly target: 26 selling days in September 2026 (Mon–Sat).
    await salesTarget(
      ids.kim.id,
      "monthly",
      26_000_00,
      Date.parse("2026-09-01T00:00:00+08:00"),
    );
    const data = await as("managerA").query(api.analytics.execution.day, {
      serviceDate: date,
    });
    expect(data).toMatchObject({
      page: 0,
      pageCount: 1,
      peopleInScope: 2,
      truncated: false,
    });
    expect(data.rows.map((r) => r.name)).toEqual(["Ana", "Kim"]);
    const ana = data.rows[0]!;
    expect(ana).toMatchObject({
      sellingDay: true,
      scheduled: true,
      active: true,
      inField: true,
      planned: 3,
      plannedDone: 2,
      plannedOutlets: 3,
      coveredOutlets: 2,
      calls: 2,
      productiveCalls: 1,
      unplanned: 1,
      callsTarget: 30,
      productiveTargetPct: 85,
      sales: 1_000_50,
      salesTarget: 2_000_00,
      firstCheckInAt: now - 5 * HOUR,
    });
    const kim = data.rows[1]!;
    expect(kim).toMatchObject({
      scheduled: false,
      active: false,
      calls: 0,
      callsTarget: 5,
      productiveTargetPct: 90,
      sales: 250_00,
      salesTarget: 1_000_00,
    });
    expect(data.totals).toMatchObject({
      people: 2,
      scheduled: 1,
      active: 1,
      calls: 2,
      productiveCalls: 1,
      targetedCalls: 2,
      callsTarget: 35,
      sales: 1_250_50,
      targetedSales: 1_250_50,
      salesTarget: 3_000_00,
      peopleWithSalesTarget: 2,
    });
    expect(headline(data.totals)).toMatchObject({
      salesAttainmentPct: 41,
      callAttainmentPct: 5,
      productivePct: 50,
      coveragePct: 66,
      planCompletionPct: 66,
      activePct: 100,
    });
  });

  it("filters to a unit or channel inside the caller's scope only", async () => {
    const { ids, as, anaDay } = await fixture();
    await anaDay();
    const b = await as("managerB").query(api.analytics.execution.day, {
      serviceDate: date,
    });
    expect(b.rows.map((r) => r.name)).toEqual(["Cara"]);
    // Cara's ₱9,999 is hers alone; she has no plan and no target.
    expect(b.rows[0]).toMatchObject({
      sales: 9_999_00,
      salesTarget: null,
      scheduled: false,
    });
    await expect(
      as("managerA").query(api.analytics.execution.day, {
        serviceDate: date,
        orgUnitId: ids.regionB,
      }),
    ).rejects.toThrow("outside your organizational scope");
    const channel = await as("managerA").query(api.analytics.execution.day, {
      serviceDate: date,
      channel: "Key Account Specialist (KAS)",
    });
    expect(channel.rows.map((r) => r.name)).toEqual(["Kim"]);
    expect(channel.channels).toEqual([
      "Key Account Specialist (KAS)",
      "Route Distribution Salesman (RDS)",
    ]);
  });

  it("refuses field sales and roles without people access, and bad pages", async () => {
    const { as } = await fixture();
    await expect(
      as("Ana").query(api.analytics.execution.day, { serviceDate: date }),
    ).rejects.toThrow();
    await expect(
      as("opsA").query(api.analytics.execution.day, { serviceDate: date }),
    ).rejects.toThrow();
    await expect(
      as("Ana").query(api.analytics.execution.exceptions, {
        serviceDate: date,
      }),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.analytics.execution.day, {
        serviceDate: date,
        page: 1,
      }),
    ).rejects.toThrow("out of range");
    await expect(
      as("managerA").query(api.analytics.execution.day, {
        serviceDate: date,
        page: -1,
      }),
    ).rejects.toThrow("whole number");
    await expect(
      as("managerA").query(api.analytics.execution.day, {
        serviceDate: "2026-02-30",
      }),
    ).rejects.toThrow();
  });

  it("has no call or sales target on a non-selling day", async () => {
    const { ids, as, salesTarget } = await fixture();
    await salesTarget(
      ids.kim.id,
      "monthly",
      26_000_00,
      Date.parse("2026-09-01T00:00:00+08:00"),
    );
    const sunday = await as("managerA").query(api.analytics.execution.day, {
      serviceDate: "2026-09-27",
    });
    const kim = sunday.rows.find((r) => r.name === "Kim")!;
    expect(kim).toMatchObject({
      sellingDay: false,
      callsTarget: null,
      productiveTargetPct: null,
      salesTarget: null,
    });
  });

  it("counts the key exceptions of the day by kind", async () => {
    const { as, anaDay } = await fixture();
    await anaDay();
    const data = await as("managerA").query(
      api.analytics.execution.exceptions,
      { serviceDate: date },
    );
    expect(data.total).toBe(2);
    expect(data.open).toBe(0);
    expect(
      Object.fromEntries(data.kinds.map((k) => [k.kind, k.total])),
    ).toEqual({ not_visited: 1, unplanned: 1 });
    expect(data.items.map((item) => [item.kind, item.outletCode])).toEqual(
      expect.arrayContaining([
        ["not_visited", "O3"],
        ["unplanned", "O9"],
      ]),
    );
    const b = await as("managerB").query(api.analytics.execution.exceptions, {
      serviceDate: date,
    });
    expect(b.total).toBe(0);
  });
});
