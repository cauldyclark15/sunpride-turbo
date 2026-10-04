import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  balanceToSell,
  compareCategories,
  countsAsSale,
  dailyTarget,
  LATE_ORDER_WINDOW_MS,
  memoCategory,
  percentOf,
  saleInstant,
  toMinor,
} from "./model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const date = "2026-09-28"; // a Monday
// 11:00 Manila on the service date.
const now = Date.parse("2026-09-28T03:00:00Z");
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+08:00`);
const monthStart = Date.parse("2026-09-01T00:00:00+08:00");
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("DSR rules", () => {
  it("counts every order that became a sale, returns included", () => {
    expect(countsAsSale("posted")).toBe(true);
    expect(countsAsSale("submitted")).toBe(true);
    expect(countsAsSale("draft")).toBe(false);
    expect(countsAsSale("rejected")).toBe(false);
    expect(countsAsSale("voided")).toBe(false);
  });

  it("converts stored pesos to centavos", () => {
    expect(toMinor(1500.5)).toBe(150050);
    expect(toMinor(-100)).toBe(-10000);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(Number.NaN)).toBe(0);
  });

  it("dates an offline order by the phone clock only within the late window", () => {
    const createdAt = at(date, "09:00");
    expect(saleInstant({ createdAt })).toBe(createdAt);
    expect(saleInstant({ createdAt, offlineCreatedAt: createdAt - DAY })).toBe(
      createdAt - DAY,
    );
    expect(
      saleInstant({
        createdAt,
        offlineCreatedAt: createdAt - LATE_ORDER_WINDOW_MS - 1,
      }),
    ).toBe(createdAt);
    expect(saleInstant({ createdAt, offlineCreatedAt: createdAt + 1 })).toBe(
      createdAt,
    );
  });

  it("maps product categories onto the memo's Canned / Mixes / Frozen blocks", () => {
    expect(memoCategory("Canned Goods")).toBe("Canned");
    expect(memoCategory("BAKING MIXES")).toBe("Mixes");
    expect(memoCategory("frozen")).toBe("Frozen");
    expect(memoCategory("Juice")).toBe("Juice");
    expect(memoCategory("  ")).toBe("Uncategorized");
    expect(
      ["Juice", "Frozen", "Apple", "Canned", "Mixes"].sort(compareCategories),
    ).toEqual(["Canned", "Mixes", "Frozen", "Apple", "Juice"]);
  });

  it("uses a set daily target, else spreads the monthly target over selling days", () => {
    expect(
      dailyTarget({
        daily: 5000,
        monthly: 100,
        sellingDay: false,
        sellingDaysInMonth: 26,
      }),
    ).toEqual({ value: 5000, source: "set" });
    expect(
      dailyTarget({
        daily: null,
        monthly: 10_000_000,
        sellingDay: true,
        sellingDaysInMonth: 26,
      }),
    ).toEqual({ value: 384_615, source: "derived_from_monthly" });
    expect(
      dailyTarget({
        daily: null,
        monthly: 10_000_000,
        sellingDay: false,
        sellingDaysInMonth: 26,
      }),
    ).toEqual({ value: null, source: null });
    expect(
      dailyTarget({
        daily: null,
        monthly: null,
        sellingDay: true,
        sellingDaysInMonth: 26,
      }),
    ).toEqual({ value: null, source: null });
  });

  it("reports MTD percent and a balance that never goes negative", () => {
    expect(percentOf(340_050, 10_000_000)).toBe(3);
    expect(percentOf(1, null)).toBeNull();
    expect(percentOf(1, 0)).toBeNull();
    expect(balanceToSell(340_050, 10_000_000)).toBe(9_659_950);
    expect(balanceToSell(20, 10)).toBe(0);
    expect(balanceToSell(20, null)).toBeNull();
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = monthStart - 60 * DAY;
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
      role: "sales" | "manager" | "operations",
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
    await person("opsA", "operations", regionA);
    const ana = await person("Ana", "sales", regionA);
    const cara = await person("Cara", "sales", regionB);

    const customer = (code: string, name: string) =>
      ctx.db.insert("customers", {
        code,
        name,
        channel: "GT",
        territory: "T-A",
        creditLimit: 0,
        active: true,
        updatedAt: since,
      });
    const c1 = await customer("C1", "Store One Trading");
    const c2 = await customer("C2", "Store Two Mart");
    await customer("C9", "Walk-in Nine");

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
      name: "Route 1 Poblacion",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    const outlets: {
      id: Id<"outlets">;
      assignment: Id<"outletAssignments">;
    }[] = [];
    for (const n of [1, 2, 3]) {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${n}`,
        name: `Outlet ${n}`,
        status: "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const assignment = await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId: territory,
        routeId: route,
        sequence: n,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      outlets.push({ id, assignment });
    }
    // Outlet 1 is linked to C1 through the live link; outlet 2 through the signed snapshot.
    await ctx.db.insert("outletCustomerLinks", {
      outletId: outlets[0]!.id,
      customerId: c1,
      source: "fixture",
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
      requestedFrom: monthStart,
      requestedTo: monthStart + 30 * DAY,
      effectiveFrom: monthStart,
      effectiveTo: monthStart + 30 * DAY,
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
    for (const [index, outlet] of outlets.entries()) {
      const approvedSnapshot = {
        outletId: outlet.id,
        outletCode: `O${index + 1}`,
        outletName: `Outlet ${index + 1}`,
        ...(index === 1 ? { customerId: c2 } : {}),
        territoryId: territory,
        territoryCode: "T-A",
        routeId: route,
        routeCode: "R-01",
        sequence: index + 1,
        outletAssignmentId: outlet.assignment,
        territoryOwnershipId: ownership,
        employeeAssignmentId: ana.assignment,
        orgUnitId: regionA,
        activityKind: "sell",
        approvedAssigneeProfileId: ana.id,
      };
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: `slot-${index}`,
        planId: plan,
        assigneeProfileId: ana.id,
        serviceDate: date,
        kind: "outlet_visit",
        outletId: outlet.id,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: index + 1,
        expectedDurationMinutes: 20,
        approvedSnapshot,
        contentRevision: 1,
        updatedBy: "fixture",
        updatedAt: since,
      });
      planned.push(
        await ctx.db.insert("plannedVisits", {
          generationKey: `gen-${index}`,
          planId: plan,
          planVersion: 1,
          planSlotId: slot,
          assigneeProfileId: ana.id,
          outletId: outlet.id,
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
      outletId: Id<"outlets">,
      plannedVisitId: Id<"plannedVisits">,
      reasonCode?: string,
    ) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${n}`,
        assigneeProfileId: ana.id,
        outletId,
        orgUnitId: regionA,
        routeId: route,
        serviceDate: date,
        source: "planned",
        plannedVisitId,
        planId: plan,
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: at(date, "08:00"),
        lastServerTime: at(date, "08:30"),
        checkedInAt: at(date, "08:00"),
        checkedOutAt: at(date, "08:30"),
        ...(reasonCode ? { reasonCode } : {}),
      });
    const v1 = await visit(1, outlets[0]!.id, planned[0]!);
    await visit(2, outlets[1]!.id, planned[1]!, "store_closed");
    const activity = (
      kind:
        | { kind: "note"; text: string }
        | { kind: "order_intent"; clientOrderId: string }
        | {
            kind: "promotion";
            programRef: string;
            finding: "executed" | "not_executed" | "not_applicable";
          },
    ) =>
      ctx.db.insert("visitActivities", {
        organizationId: "sunpride",
        orgUnitId: regionA,
        visitId: v1,
        assigneeProfileId: ana.id,
        outletId: outlets[0]!.id,
        activity: kind,
        evidenceIds: [],
        deviceTime: at(date, "08:10"),
        serverTime: at(date, "08:10"),
      });
    await activity({ kind: "order_intent", clientOrderId: "ord-1" });
    await activity({ kind: "note", text: "Competitor display at entrance" });
    await activity({
      kind: "promotion",
      programRef: "PROMO-SEPT",
      finding: "executed",
    });

    const product = (code: string, category: string) =>
      ctx.db.insert("products", {
        code,
        name: code,
        category,
        uom: "CS",
        unitPrice: 100,
        active: true,
        updatedAt: since,
      });
    await product("P-CAN", "Canned Goods");
    await product("P-FRZ", "Frozen");
    await product("P-JUICE", "Juice");
    let n = 0;
    const order = async (
      who: string,
      customerCode: string,
      createdAt: number,
      lines: { code: string; quantity: number; lineTotal: number }[],
      extra: {
        status?: "posted" | "voided" | "draft";
        offlineCreatedAt?: number;
      } = {},
    ) => {
      n++;
      const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
      const orderId = await ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${n}`,
        orderNumber: `SI-${String(n).padStart(3, "0")}`,
        customerCode,
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
      for (const line of lines)
        await ctx.db.insert("orderLines", {
          orderId,
          productCode: line.code,
          description: line.code,
          quantity: line.quantity,
          unitPrice: line.quantity ? line.lineTotal / line.quantity : 0,
          lineTotal: line.lineTotal,
        });
    };
    // SI-001: today, C1, canned + frozen = ₱1,500.50
    await order("Ana", "C1", at(date, "08:15"), [
      { code: "P-CAN", quantity: 2, lineTotal: 1000.5 },
      { code: "P-FRZ", quantity: 1, lineTotal: 500 },
    ]);
    // SI-002: earlier this month, C1, frozen ₱1,000
    await order("Ana", "C1", at("2026-09-10", "10:00"), [
      { code: "P-FRZ", quantity: 2, lineTotal: 1000 },
    ]);
    // SI-003: today, C9 (no route-plan store), juice ₱200
    await order("Ana", "C9", at(date, "10:00"), [
      { code: "P-JUICE", quantity: 1, lineTotal: 200 },
    ]);
    // SI-004: earlier this month, C8 (not covered today), canned ₱300
    await order("Ana", "C8", at("2026-09-15", "10:00"), [
      { code: "P-CAN", quantity: 3, lineTotal: 300 },
    ]);
    // SI-005: today, voided — never a sale
    await order(
      "Ana",
      "C1",
      at(date, "09:00"),
      [{ code: "P-CAN", quantity: 9, lineTotal: 999 }],
      { status: "voided" },
    );
    // SI-006: today, a return of one canned case for C1 (−₱100)
    await order("Ana", "C1", at(date, "10:30"), [
      { code: "P-CAN", quantity: -1, lineTotal: -100 },
    ]);
    // SI-007: last month — outside MTD
    await order("Ana", "C1", at("2026-08-31", "10:00"), [
      { code: "P-CAN", quantity: 1, lineTotal: 7777 },
    ]);
    // SI-008: Cara's order — another salesman
    await order("Cara", "C1", at(date, "09:00"), [
      { code: "P-CAN", quantity: 1, lineTotal: 4444 },
    ]);
    // SI-009: written offline yesterday, synced this morning: MTD, not today
    await order(
      "Ana",
      "C1",
      at(date, "07:00"),
      [{ code: "P-JUICE", quantity: 5, lineTotal: 500 }],
      { offlineCreatedAt: at("2026-09-27", "16:00") },
    );

    await ctx.db.insert("salesTargets", {
      organizationId: "sunpride",
      subjectKind: "employee",
      profileId: ana.id,
      period: "monthly",
      metric: "sales_value",
      value: 10_000_000, // ₱100,000
      effectiveFrom: monthStart,
      sourceRef: "Sept 2026 allocation",
      createdBy: "fixture",
      createdAt: since,
      updatedAt: since,
    });
    return { ana: ana.id, cara: cara.id };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

describe("dsr.report.day", () => {
  it("builds the Annex B sheet from orders and visits", async () => {
    const { ids, as } = await fixture();
    const report = await as("managerA").query(api.dsr.report.day, {
      profileId: ids.ana,
      serviceDate: date,
    });
    expect(report.salesman).toMatchObject({
      name: "Ana",
      position: "Route Sales",
    });
    expect(report.areaCovered).toEqual(["Route 1 Poblacion"]);
    expect(report.invoiceNumbers).toEqual(["SI-001", "SI-003", "SI-006"]);
    expect(report.sellingDay).toBe(true);
    expect(report.sellingDaysInMonth).toBe(26);
    expect(report.targets).toEqual({
      daily: 384_615,
      dailySource: "derived_from_monthly",
      monthly: 10_000_000,
      sourceRef: "Sept 2026 allocation",
    });
    expect(report.totals).toEqual({
      todaySales: 160_050,
      todayPct: 41,
      mtdSales: 340_050,
      mtdPct: 3,
      balanceToSell: 9_659_950,
    });
    expect(report.calls).toEqual({
      planned: 3,
      calls: 2,
      productiveCalls: 1,
      productivePct: 50,
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
    });
    expect(
      report.customers.map((row) => [
        row.outletCode,
        row.customerCode,
        row.callStatus,
        row.todaySales,
        row.mtdSales,
        row.invoiceNumbers,
      ]),
    ).toEqual([
      ["O1", "C1", "productive", 140_050, 290_050, ["SI-001", "SI-006"]],
      ["O2", "C2", "nonproductive", 0, 0, []],
      ["O3", null, "not_visited", 0, 0, []],
      [null, "C9", null, 20_000, 20_000, ["SI-003"]],
    ]);
    expect(report.customers[0]).toMatchObject({
      name: "Outlet 1",
      inRoutePlan: true,
      matchedCodes: ["purchase_order"],
      remarks: ["Competitor display at entrance"],
    });
    expect(report.customers[1]!.reasonCode).toBe("store_closed");
    expect(report.customers[3]).toMatchObject({
      name: "Walk-in Nine",
      inRoutePlan: false,
    });
    expect(report.categories).toEqual([
      {
        category: "Canned",
        todaySales: 90_050,
        todayQuantity: 1,
        mtdSales: 120_050,
        mtdQuantity: 4,
      },
      {
        category: "Mixes",
        todaySales: 0,
        todayQuantity: 0,
        mtdSales: 0,
        mtdQuantity: 0,
      },
      {
        category: "Frozen",
        todaySales: 50_000,
        todayQuantity: 1,
        mtdSales: 150_000,
        mtdQuantity: 3,
      },
      {
        category: "Juice",
        todaySales: 20_000,
        todayQuantity: 1,
        mtdSales: 70_000,
        mtdQuantity: 6,
      },
    ]);
    expect(report.programs).toEqual([
      {
        programRef: "PROMO-SEPT",
        executed: 1,
        notExecuted: 0,
        notApplicable: 0,
      },
    ]);
  });

  it("uses a daily target when one is set", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.insert("salesTargets", {
        organizationId: "sunpride",
        subjectKind: "employee",
        profileId: ids.ana,
        period: "daily",
        metric: "sales_value",
        value: 200_000,
        effectiveFrom: monthStart,
        sourceRef: "Daily quota",
        createdBy: "fixture",
        createdAt: monthStart,
        updatedAt: monthStart,
      });
    });
    const report = await as("Ana").query(api.dsr.report.day, {
      profileId: ids.ana,
      serviceDate: date,
    });
    expect(report.targets).toMatchObject({
      daily: 200_000,
      dailySource: "set",
      sourceRef: "Daily quota",
    });
    expect(report.totals.todayPct).toBe(80);
  });

  it("dates an offline order to the day it was written, with no route plan", async () => {
    const { ids, as } = await fixture();
    const report = await as("managerA").query(api.dsr.report.day, {
      profileId: ids.ana,
      serviceDate: "2026-09-27", // Sunday: no route plan, no derived daily target
    });
    expect(report.sellingDay).toBe(false);
    expect(report.targets.daily).toBeNull();
    expect(report.calls).toMatchObject({ planned: 0, calls: 0 });
    // SI-009 was written offline on the 27th and synced on the 28th.
    expect(report.invoiceNumbers).toEqual(["SI-009"]);
    expect(report.totals.todaySales).toBe(50_000);
    expect(report.totals.mtdSales).toBe(100_000 + 30_000 + 50_000);
    expect(report.customers).toMatchObject([
      {
        customerCode: "C1",
        name: "Store One Trading",
        todaySales: 50_000,
        mtdSales: 150_000,
        callStatus: null,
      },
    ]);
    expect(report.areaCovered).toEqual(["Region A"]);
  });

  it("lets sales read only their own sheet and keeps managers in scope", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("Ana").query(api.dsr.report.day, {
        profileId: ids.ana,
        serviceDate: date,
      }),
    ).resolves.toMatchObject({ salesman: { name: "Ana" } });
    await expect(
      as("Ana").query(api.dsr.report.day, {
        profileId: ids.cara,
        serviceDate: date,
      }),
    ).rejects.toThrow("Sales can only read their own daily sales report");
    await expect(
      as("managerB").query(api.dsr.report.day, {
        profileId: ids.ana,
        serviceDate: date,
      }),
    ).rejects.toThrow("outside your organizational scope");
    await expect(
      as("opsA").query(api.dsr.report.day, {
        profileId: ids.ana,
        serviceDate: date,
      }),
    ).resolves.toMatchObject({ totals: { todaySales: 160_050 } });
    await expect(
      as("managerA").query(api.dsr.report.day, {
        profileId: ids.ana,
        serviceDate: "2026-02-30",
      }),
    ).rejects.toThrow("Invalid Manila date");
  });
});

describe("dsr.report.salesmen", () => {
  it("returns self for sales, the team for supervisors and nobody otherwise", async () => {
    const { ids, as } = await fixture();
    const self = await as("Ana").query(api.dsr.report.salesmen, {
      serviceDate: date,
    });
    expect(self).toEqual({
      self: true,
      truncated: false,
      people: [
        {
          profileId: ids.ana,
          name: "Ana",
          employeeCode: null,
          position: "Route Sales",
        },
      ],
    });
    const team = await as("managerA").query(api.dsr.report.salesmen, {
      serviceDate: date,
    });
    expect(team.self).toBe(false);
    expect(team.people.map((p) => p.name)).toEqual(["Ana"]);
    const ops = await as("opsA").query(api.dsr.report.salesmen, {
      serviceDate: date,
    });
    expect(ops).toEqual({ self: false, truncated: false, people: [] });
  });
});
