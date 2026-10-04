import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  combineTerritoryFigures,
  datesBetween,
  emptyTerritoryFigures,
  MAX_PERIOD_DAYS,
  periodError,
  rankTerritories,
  ratePct,
  territoryRates,
  type TerritoryFigures,
} from "./territory_model";

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
    const since = now - 60 * 24 * HOUR;
    const base = {
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    };
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
        updatedAt: since,
      });
      const assignment = await ctx.db.insert("employeeAssignments", {
        profileId: id,
        orgUnitId,
        role,
        effectiveFrom: since,
        ...base,
      });
      return { id, assignment };
    };
    await person("managerA", "manager", regionA);
    await person("analyst", "analyst", root);
    const ana = await person("Ana", "sales", regionA);

    const territory = async (
      code: string,
      orgUnitId: Id<"orgUnits">,
      channel: string,
    ) => {
      const id = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code,
        name: `Territory ${code}`,
        channel,
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
        ...base,
      });
      return { id, ownership };
    };
    const ta = await territory("T-A", regionA, "GT");
    const tb = await territory("T-B", regionB, "MT");

    const outlet = async (
      n: number,
      territoryId: Id<"territories">,
      opts: { status?: "active" | "prospect"; effectiveTo?: number } = {},
    ) => {
      const id = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${n}`,
        name: `Outlet ${n}`,
        status: opts.status ?? "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const assignment = await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId,
        sequence: n,
        effectiveFrom: since,
        ...(opts.effectiveTo !== undefined
          ? { effectiveTo: opts.effectiveTo }
          : {}),
        ...base,
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
        ...base,
      });
      return { id, assignment, customer, n };
    };
    // T-A: O1–O4 active, O5 a prospect, O6 moved out before the period.
    const o = [
      await outlet(1, ta.id),
      await outlet(2, ta.id),
      await outlet(3, ta.id),
      await outlet(4, ta.id),
      await outlet(5, ta.id, { status: "prospect" }),
      await outlet(6, ta.id, { effectiveTo: at(D1, "00:00") - DAY_MS }),
      await outlet(7, tb.id),
    ];

    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [ta.id],
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
    const stop = async (
      serviceDate: string,
      index: number,
      status: "planned" | "cancelled" = "planned",
    ) => {
      const out = o[index]!;
      const approvedSnapshot = {
        outletId: out.id,
        outletCode: `O${out.n}`,
        outletName: `Outlet ${out.n}`,
        territoryId: ta.id,
        territoryCode: "T-A",
        sequence: out.n,
        outletAssignmentId: out.assignment,
        territoryOwnershipId: ta.ownership,
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
        outletId: out.id,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: out.n,
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
        outletId: out.id,
        serviceDate,
        status,
        approvedSnapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 20,
        generatedAt: since,
      });
    };
    let n = 0;
    const visit = (
      serviceDate: string,
      index: number,
      plannedVisitId: Id<"plannedVisits">,
      state: "checked-out" | "checked-in" = "checked-out",
    ) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${++n}`,
        assigneeProfileId: ana.id,
        outletId: o[index]!.id,
        orgUnitId: regionA,
        serviceDate,
        source: "planned",
        plannedVisitId,
        planId: plan,
        intents: ["sell"],
        state,
        productivity: "pending",
        createdAt: at(serviceDate, "08:00"),
        lastServerTime: at(serviceDate, "08:30"),
        checkedInAt: at(serviceDate, "08:00"),
        ...(state === "checked-out"
          ? { checkedOutAt: at(serviceDate, "08:30") }
          : {}),
      });
    const activity = (
      visitId: Id<"visitExecutions">,
      index: number,
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
        outletId: o[index]!.id,
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
      status: "submitted" | "draft" | "returned" = "submitted",
    ) =>
      ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId,
        orderNumber: `SO-${clientRequestId}`,
        customerCode,
        salespersonSubject: subject("Ana"),
        status,
        subtotal: total,
        total,
        createdAt,
        updatedAt: createdAt,
      });

    // D1 (closed): O1 visited with an order (productive), O2 visited with a note only
    // (a call, not productive), O3 never visited (missed), O4 cancelled (not planned).
    const d1 = [await stop(D1, 0), await stop(D1, 1), await stop(D1, 2)];
    await stop(D1, 3, "cancelled");
    const v1 = await visit(D1, 0, d1[0]!);
    await activity(
      v1,
      0,
      { kind: "order_intent", clientOrderId: "req-1" },
      at(D1, "08:10"),
    );
    const v2 = await visit(D1, 1, d1[1]!);
    await activity(
      v2,
      1,
      { kind: "note", text: "Owner away" },
      at(D1, "08:20"),
    );
    // D2 (open): O1 again, not visited yet (still due); O2 checked in only (open).
    await stop(D2, 0);
    const d2b = await stop(D2, 1);
    await visit(D2, 1, d2b, "checked-in");

    // Sales: ₱1,000 at O1 and a −₱200 return; a draft and orders outside the period
    // or of stores no longer / never in T-A do not count.
    await order("req-1", "C1", 1000, at(D1, "08:12"));
    await order("ret-1", "C1", -200, at(D2, "09:00"), "returned");
    await order("draft-1", "C2", 999, at(D1, "09:00"), "draft");
    await order("old-1", "C3", 500, at("2026-09-20", "10:00"));
    await order("moved-1", "C6", 400, at(D1, "10:00"));
    await order("tb-1", "C7", 300, at(D1, "10:00"));

    // ₱26,000 a month over September's 26 selling days = ₱1,000 a selling day.
    await ctx.db.insert("salesTargets", {
      organizationId: "sunpride",
      subjectKind: "territory",
      territoryId: ta.id,
      period: "monthly",
      metric: "sales_value",
      value: 2_600_000,
      effectiveFrom: Date.parse("2026-09-01T00:00:00+08:00"),
      sourceRef: "fixture",
      createdBy: "fixture",
      createdAt: since,
      updatedAt: since,
    });
    return { ta: ta.id, tb: tb.id, regionB };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

const DAY_MS = 86_400_000;

describe("territory performance queries", () => {
  it("lists only territories owned inside the caller's scope", async () => {
    const { ids, as } = await fixture();
    const mine = await as("managerA").query(api.analytics.territory.list, {
      endDate: D2,
    });
    expect(mine.territories.map((row) => row.code)).toEqual(["T-A"]);
    expect(mine.territories[0]).toMatchObject({
      channel: "GT",
      ownerUnitName: "Region A",
    });
    const all = await as("analyst").query(api.analytics.territory.list, {
      endDate: D2,
    });
    expect(all.territories.map((row) => row.code)).toEqual(["T-A", "T-B"]);
    expect(all.channels).toEqual(["GT", "MT"]);
    const mt = await as("analyst").query(api.analytics.territory.list, {
      endDate: D2,
      channel: "MT",
    });
    expect(mt.territories.map((row) => row.code)).toEqual(["T-B"]);
    const unitB = await as("analyst").query(api.analytics.territory.list, {
      endDate: D2,
      orgUnitId: ids.regionB,
    });
    expect(unitB.territories.map((row) => row.code)).toEqual(["T-B"]);
    await expect(
      as("managerA").query(api.analytics.territory.list, {
        endDate: D2,
        orgUnitId: ids.regionB,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("Ana").query(api.analytics.territory.list, { endDate: D2 }),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("computes sales, target attainment, coverage, strike rate and distribution gaps", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(api.analytics.territory.figures, {
      territoryId: ids.ta,
      from: D1,
      to: D2,
    });
    expect(result.figures).toEqual({
      activeOutlets: 4,
      buyingOutlets: 1,
      planned: 5,
      plannedOutlets: 3,
      coveredOutlets: 2,
      calls: 2,
      productiveCalls: 1,
      missed: 1,
      pending: 2,
      orders: 2,
      sales: 80_000,
      salesTarget: 200_000,
    });
    expect(territoryRates(result.figures)).toEqual({
      attainmentPct: 40,
      coveragePct: 66,
      strikeRatePct: 50,
      distributionPct: 25,
      distributionGaps: 3,
      planCompletionPct: 40,
    });
    expect(result.gapOutlets.map((row) => row.code)).toEqual([
      "O2",
      "O3",
      "O4",
    ]);
  });

  it("refuses territories outside scope and over-long periods", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("managerA").query(api.analytics.territory.figures, {
        territoryId: ids.tb,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("managerA").query(api.analytics.territory.figures, {
        territoryId: ids.ta,
        from: "2026-08-01",
        to: D2,
      }),
    ).rejects.toThrow(/at most 31 days/);
    await expect(
      as("Ana").query(api.analytics.territory.figures, {
        territoryId: ids.ta,
        from: D1,
        to: D2,
      }),
    ).rejects.toThrow(/Insufficient permission/);
    const other = await as("analyst").query(api.analytics.territory.figures, {
      territoryId: ids.tb,
      from: D1,
      to: D2,
    });
    expect(other.figures).toMatchObject({
      activeOutlets: 1,
      buyingOutlets: 1,
      sales: 30_000,
      salesTarget: null,
      planned: 0,
    });
  });
});

const figures = (over: Partial<TerritoryFigures>): TerritoryFigures => ({
  ...emptyTerritoryFigures(),
  ...over,
});

describe("territory performance rules", () => {
  it("returns null rates without a base", () => {
    expect(territoryRates(emptyTerritoryFigures())).toEqual({
      attainmentPct: null,
      coveragePct: null,
      strikeRatePct: null,
      distributionPct: null,
      distributionGaps: 0,
      planCompletionPct: null,
    });
    expect(ratePct(2, 3)).toBe(66);
    expect(ratePct(1, 0)).toBeNull();
  });

  it("sums territories before dividing", () => {
    const a = figures({ calls: 10, productiveCalls: 9, salesTarget: 100 });
    const b = figures({ calls: 30, productiveCalls: 15 });
    const total = combineTerritoryFigures([a, b]);
    expect(total.salesTarget).toBe(100);
    // 24 of 40, not the mean of 90% and 50%.
    expect(territoryRates(total).strikeRatePct).toBe(60);
    expect(combineTerritoryFigures([b]).salesTarget).toBeNull();
  });

  it("ranks best first and puts missing figures last", () => {
    const rows = [
      { code: "A", figures: figures({ sales: 5, salesTarget: null }) },
      { code: "B", figures: figures({ sales: 9, salesTarget: 10 }) },
      { code: "C", figures: figures({ sales: 9, salesTarget: 30 }) },
      {
        code: "D",
        figures: figures({ activeOutlets: 10, buyingOutlets: 2 }),
      },
    ];
    expect(rankTerritories(rows, "sales").map((r) => r.code)).toEqual([
      "B",
      "C",
      "A",
      "D",
    ]);
    expect(rankTerritories(rows, "attainment").map((r) => r.code)).toEqual([
      "B",
      "C",
      "A",
      "D",
    ]);
    expect(
      rankTerritories(rows, "distributionGaps").map((r) => r.code),
    ).toEqual(["D", "A", "B", "C"]);
  });

  it("bounds the period", () => {
    expect(datesBetween("2026-09-29", "2026-10-02")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(periodError("2026-09-02", "2026-09-01")).toMatch(/start/);
    expect(periodError("2026-09-01", "2026-10-01")).toBeNull();
    expect(periodError("2026-09-01", "2026-10-02")).toMatch(
      String(MAX_PERIOD_DAYS),
    );
  });
});
