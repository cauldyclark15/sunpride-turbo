import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  combineFigures,
  datesBetween,
  emptyFigures,
  MAX_PERIOD_DAYS,
  missedOf,
  periodError,
  ratePct,
  ratesOf,
  summarizePeriod,
  type DayFacts,
} from "./productivity_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const D1 = "2026-09-28"; // Monday, closed
const D2 = "2026-09-29"; // Tuesday, still open
// 11:00 Manila on D2.
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
    const since = now - 30 * 24 * HOUR;
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
      code: "PMS",
      label: "Route Salesman",
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
      sourceRef: "memo 2026-01-20 §2",
      createdAt: since,
      updatedAt: since,
    });
    const person = async (
      name: string,
      role: "sales" | "manager" | "viewer",
      orgUnitId: Id<"orgUnits">,
      supervisorId?: Id<"profiles">,
    ) => {
      const id = await ctx.db.insert("profiles", {
        authSubject: subject(name),
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        positionId: role === "sales" ? position : undefined,
        updatedAt: since,
      });
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        positionId: role === "sales" ? position : undefined,
        ...(supervisorId ? { supervisorId } : {}),
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    const managerA = await person("managerA", "manager", regionA);
    await person("managerB", "manager", regionB);
    const ana = await person("Ana", "sales", regionA, managerA.id);
    const ben = await person("Ben", "sales", regionA);
    const cara = await person("Cara", "sales", regionB);
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
    const outlets: {
      id: Id<"outlets">;
      assignment: Id<"outletAssignments">;
      customer: Id<"customers">;
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
        sequence: n,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      const customer = await ctx.db.insert("customers", {
        code: `C${n}`,
        name: `Customer ${n}`,
        channel: "GT",
        territory: "T-A",
        creditLimit: 0,
        active: true,
        updatedAt: since,
      });
      await ctx.db.insert("outletCustomerLinks", {
        outletId: id,
        customerId: customer,
        source: "fixture",
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      outlets.push({ id, assignment, customer });
    }
    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [territory],
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
    const stop = async (serviceDate: string, index: number) => {
      const outlet = outlets[index]!;
      const approvedSnapshot = {
        outletId: outlet.id,
        outletCode: `O${index + 1}`,
        outletName: `Outlet ${index + 1}`,
        territoryId: territory,
        territoryCode: "T-A",
        sequence: index + 1,
        outletAssignmentId: outlet.assignment,
        territoryOwnershipId: ownership,
        employeeAssignmentId: ana.assignment,
        orgUnitId: regionA,
        activityKind: "sell",
        approvedAssigneeProfileId: ana.id,
      };
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: `slot-${serviceDate}-${index}`,
        planId: plan,
        assigneeProfileId: ana.id,
        serviceDate,
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
      return await ctx.db.insert("plannedVisits", {
        generationKey: `gen-${serviceDate}-${index}`,
        planId: plan,
        planVersion: 1,
        planSlotId: slot,
        assigneeProfileId: ana.id,
        outletId: outlet.id,
        serviceDate,
        status: "planned",
        approvedSnapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 20,
        generatedAt: since,
      });
    };
    let n = 0;
    const visit = (fields: {
      serviceDate: string;
      profileId?: Id<"profiles">;
      orgUnitId?: Id<"orgUnits">;
      outlet: number;
      plannedVisitId?: Id<"plannedVisits">;
      customerId?: Id<"customers">;
      checkedInAt: number;
      checkedOutAt: number;
    }) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${++n}`,
        assigneeProfileId: fields.profileId ?? ana.id,
        outletId: outlets[fields.outlet]!.id,
        orgUnitId: fields.orgUnitId ?? regionA,
        serviceDate: fields.serviceDate,
        source: fields.plannedVisitId ? "planned" : "unplanned",
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: fields.checkedInAt,
        lastServerTime: fields.checkedOutAt,
        checkedInAt: fields.checkedInAt,
        checkedOutAt: fields.checkedOutAt,
        ...(fields.plannedVisitId
          ? { plannedVisitId: fields.plannedVisitId, planId: plan }
          : {}),
        ...(fields.customerId ? { customerId: fields.customerId } : {}),
      });
    const activity = (
      visitId: Id<"visitExecutions">,
      outlet: number,
      body:
        | { kind: "order_intent"; clientOrderId: string }
        | { kind: "note"; text: string },
      serverTime: number,
    ) =>
      ctx.db.insert("visitActivities", {
        organizationId: "sunpride",
        orgUnitId: regionA,
        visitId,
        assigneeProfileId: ana.id,
        outletId: outlets[outlet]!.id,
        activity: body,
        evidenceIds: [],
        deviceTime: serverTime,
        serverTime,
      });
    const order = (
      clientRequestId: string,
      customerCode: string,
      total: number,
      createdAt: number,
      extra: {
        status?: "submitted" | "draft" | "returned";
        offlineCreatedAt?: number;
        salespersonSubject?: string;
      } = {},
    ) =>
      ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId,
        orderNumber: `SO-${clientRequestId}`,
        customerCode,
        salespersonSubject: extra.salespersonSubject ?? subject("Ana"),
        status: extra.status ?? "submitted",
        subtotal: total,
        total,
        createdAt,
        updatedAt: createdAt,
        ...(extra.offlineCreatedAt !== undefined
          ? { offlineCreatedAt: extra.offlineCreatedAt }
          : {}),
      });

    // D1 (closed): three planned stops. Stop 2 first (productive: order intent matched to
    // a real order), then stop 1 out of MCP order and outside the radius (nonproductive,
    // only a note), stop 3 never visited (missed), plus an unplanned call at outlet 3.
    const d1 = [await stop(D1, 0), await stop(D1, 1), await stop(D1, 2)];
    const v2 = await visit({
      serviceDate: D1,
      outlet: 1,
      plannedVisitId: d1[1],
      checkedInAt: at(D1, "08:00"),
      checkedOutAt: at(D1, "08:30"),
    });
    await activity(
      v2,
      1,
      { kind: "order_intent", clientOrderId: "req-1" },
      at(D1, "08:10"),
    );
    const v1 = await visit({
      serviceDate: D1,
      outlet: 0,
      plannedVisitId: d1[0],
      customerId: outlets[0]!.customer,
      checkedInAt: at(D1, "09:00"),
      checkedOutAt: at(D1, "09:20"),
    });
    await activity(v1, 0, { kind: "note", text: "Closed" }, at(D1, "09:10"));
    await ctx.db.insert("visitLocationEvidence", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      visitId: v1,
      event: "check_in",
      latitude: 14.7,
      longitude: 121.1,
      provider: "gps",
      accuracyMeters: 12,
      policyVersion: "test",
      radiusMeters: 75,
      distanceMeters: 320,
      result: "outside_radius",
      reviewStatus: "pending_review",
      deviceTime: at(D1, "09:00"),
      serverTime: at(D1, "09:00"),
    });
    await visit({
      serviceDate: D1,
      outlet: 2,
      checkedInAt: at(D1, "10:00"),
      checkedOutAt: at(D1, "10:15"),
    });
    // Orders on D1: the matched order (₱1,500, customer C2), a return (−₱200) that
    // counts in sales but converts nothing, and a draft that is not a sale.
    await order("req-1", "C2", 1500, at(D1, "08:12"));
    await order("ret-1", "C1", -200, at(D1, "09:15"), { status: "returned" });
    await order("draft-1", "C1", 999, at(D1, "09:16"), { status: "draft" });
    // Another salesman's order for the same customer never counts for Ana.
    await order("ben-1", "C1", 700, at(D1, "09:17"), {
      salespersonSubject: subject("Ben"),
    });

    // D2 (open): two planned stops; stop 1 visited with a collection (productive) and an
    // order written offline that morning (converted via the outlet's customer link);
    // stop 2 not visited yet (pending, not missed).
    const d2 = [await stop(D2, 0), await stop(D2, 1)];
    const v3 = await visit({
      serviceDate: D2,
      outlet: 0,
      plannedVisitId: d2[0],
      checkedInAt: at(D2, "08:00"),
      checkedOutAt: at(D2, "08:20"),
    });
    await ctx.db.insert("fieldCollections", {
      organizationId: "sunpride",
      orgUnitId: regionA,
      customerId: outlets[0]!.customer,
      outletId: outlets[0]!.id,
      visitId: v3,
      assigneeProfileId: ana.id,
      amountMinor: 50_000n,
      currency: "PHP",
      method: "cash",
      reference: "OR-1",
      status: "recorded",
      deviceTime: at(D2, "08:10"),
      serverTime: at(D2, "08:10"),
    });
    await order("req-2", "C1", 1000, at(D2, "10:30"), {
      offlineCreatedAt: at(D2, "08:15"),
    });

    // Cara (region B) has a visit that region A never sees.
    await visit({
      serviceDate: D1,
      profileId: cara.id,
      orgUnitId: regionB,
      outlet: 0,
      checkedInAt: at(D1, "09:30"),
      checkedOutAt: at(D1, "09:40"),
    });
    return { ana, ben, cara, managerA };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

const day = (overrides: Partial<DayFacts>): DayFacts => ({
  serviceDate: D1,
  closed: true,
  sellingDay: true,
  planned: 0,
  plannedDone: 0,
  calls: 0,
  productiveCalls: 0,
  convertedCalls: 0,
  visits: 0,
  unplanned: 0,
  exceptionVisits: 0,
  locationExceptions: 0,
  outOfSequence: 0,
  orders: 0,
  sales: 0,
  callsTarget: null,
  ...overrides,
});

describe("productivity rules", () => {
  it("counts unvisited stops as missed only after the day closes", () => {
    expect(missedOf({ closed: true, planned: 5, plannedDone: 3 })).toBe(2);
    expect(missedOf({ closed: false, planned: 5, plannedDone: 3 })).toBe(0);
    expect(missedOf({ closed: true, planned: 1, plannedDone: 2 })).toBe(0);
  });

  it("sums people before dividing and keeps empty bases as null", () => {
    const a = summarizePeriod([
      day({ planned: 10, plannedDone: 8, calls: 8, productiveCalls: 8 }),
      day({ serviceDate: D2, closed: false, planned: 4, callsTarget: 30 }),
    ]);
    expect(a).toMatchObject({
      days: 2,
      planned: 14,
      missed: 2,
      pending: 4,
      callsTarget: 30,
    });
    const b = summarizePeriod([
      day({ planned: 2, calls: 2, productiveCalls: 0, visits: 2 }),
    ]);
    const team = combineFigures([a, b]);
    expect(team.calls).toBe(10);
    expect(team.days).toBe(2);
    expect(team.callsTarget).toBe(30);
    // 8 of 10, not the average of 100% and 0%.
    expect(ratesOf(team).productivePct).toBe(80);
    expect(ratesOf(emptyFigures())).toEqual({
      callsPct: null,
      productivePct: null,
      conversionPct: null,
      salesPerCall: null,
      missedPct: null,
      exceptionRatePct: null,
      callsTargetPct: null,
    });
    expect(ratePct(2, 3)).toBe(66);
    expect(ratePct(1, 0)).toBeNull();
  });

  it("bounds the period", () => {
    expect(datesBetween(D1, D2)).toEqual([D1, D2]);
    expect(datesBetween("2026-02-27", "2026-03-01")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    expect(periodError(D2, D1)).toMatch(/start/);
    expect(periodError("2026-08-31", "2026-10-01")).toMatch(/31 days/);
    expect(periodError("2026-09-01", "2026-10-01")).toBeNull();
    expect(periodError("2026-09-01", "2026-09-30")).toBeNull();
    expect(MAX_PERIOD_DAYS).toBe(31);
  });
});

describe("supervisor productivity", () => {
  it("compares a person's planned, actual and productive calls, conversion, sales per call, missed calls and exceptions", async () => {
    const { ids, as } = await fixture();
    const row = await as("managerA").query(api.analytics.productivity.person, {
      profileId: ids.ana.id,
      from: D1,
      to: D2,
    });
    expect(row).toMatchObject({
      name: "Ana",
      direct: true,
      channel: "Route Salesman",
      productiveCallTargetPct: 85,
    });
    expect(row.figures).toEqual({
      days: 2,
      sellingDays: 2,
      planned: 5,
      plannedDone: 3,
      calls: 3,
      productiveCalls: 2,
      convertedCalls: 2,
      missed: 1,
      pending: 1,
      visits: 4,
      unplanned: 1,
      exceptionVisits: 2,
      locationExceptions: 1,
      outOfSequence: 1,
      orders: 3,
      sales: 230_000,
      callsTarget: 60,
    });
    expect(ratesOf(row.figures)).toEqual({
      callsPct: 60,
      productivePct: 66,
      conversionPct: 66,
      salesPerCall: 76_667,
      missedPct: 25,
      exceptionRatePct: 50,
      callsTargetPct: 5,
    });
    expect(row.days.map((d) => [d.serviceDate, d.closed, d.calls])).toEqual([
      [D1, true, 2],
      [D2, false, 1],
    ]);
  });

  it("lists direct reports, or everyone in scope, and never another region", async () => {
    const { as } = await fixture();
    const all = await as("managerA").query(api.analytics.productivity.roster, {
      endDate: D2,
    });
    expect(all.people.map((p) => [p.name, p.direct])).toEqual([
      ["Ana", true],
      ["Ben", false],
    ]);
    expect(all.directReports).toBe(1);
    const direct = await as("managerA").query(
      api.analytics.productivity.roster,
      { endDate: D2, directOnly: true },
    );
    expect(direct.people.map((p) => p.name)).toEqual(["Ana"]);
    const other = await as("managerB").query(
      api.analytics.productivity.roster,
      { endDate: D2 },
    );
    expect(other.people.map((p) => p.name)).toEqual(["Cara"]);
  });

  it("refuses people outside the caller's scope, field sales and bad periods", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("managerA").query(api.analytics.productivity.person, {
        profileId: ids.cara.id,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("managerB").query(api.analytics.productivity.person, {
        profileId: ids.ana.id,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("managerA").query(api.analytics.productivity.person, {
        profileId: ids.managerA.id,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow(/Person not found/);
    await expect(
      as("Ana").query(api.analytics.productivity.roster, { endDate: D2 }),
    ).rejects.toThrow();
    await expect(
      as("Ana").query(api.analytics.productivity.person, {
        profileId: ids.ana.id,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.analytics.productivity.person, {
        profileId: ids.ana.id,
        from: "2026-08-01",
        to: D2,
      }),
    ).rejects.toThrow(/31 days/);
    await expect(
      as("managerA").query(api.analytics.productivity.person, {
        profileId: ids.ana.id,
        from: D2,
        to: D1,
      }),
    ).rejects.toThrow(/start/);
  });
});
