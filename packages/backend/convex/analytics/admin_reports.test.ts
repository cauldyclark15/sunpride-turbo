import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  MAX_DAY_ORDERS,
  sortedPrograms,
  tallyProgram,
} from "./admin_reports_model";
import { MAX_PACK_RECORDS, pickSource } from "./admin_pack_model";

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

describe("admin report pack rules", () => {
  it("tallies programme findings per reference, blank references grouped", () => {
    const tallies = new Map();
    tallyProgram(tallies, "PA-2", "executed");
    tallyProgram(tallies, " PA-2 ", "not_executed");
    tallyProgram(tallies, "PA-1", "not_applicable");
    tallyProgram(tallies, "  ", "executed");
    expect(sortedPrograms(tallies)).toEqual([
      {
        programRef: "(no program reference)",
        executed: 1,
        notExecuted: 0,
        notApplicable: 0,
      },
      { programRef: "PA-1", executed: 0, notExecuted: 0, notApplicable: 1 },
      { programRef: "PA-2", executed: 1, notExecuted: 1, notApplicable: 0 },
    ]);
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
    await person("managerA", "manager", regionA);
    await person("managerB", "manager", regionB);
    await person("opsA", "operations", regionA);
    const ana = await person("Ana", "sales", regionA, rds);
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
    const customer = await ctx.db.insert("customers", {
      code: "C-1",
      name: "Aling Nena Store",
      channel: "PMOT",
      territory: "T-A",
      creditLimit: 0,
      active: true,
      updatedAt: since,
    });
    const stops: { planned: Id<"plannedVisits">; outlet: Id<"outlets"> }[] = [];
    for (const n of [1, 2]) {
      const outletId = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${n}`,
        name: `Outlet O${n}`,
        status: "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
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
    return { regionA, regionB, ana, cara, plan, stops, customer };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  return { t, ids, as };
}

/** Ana's day: O1 ordered + promo executed + collection + OSA audit; O2 promo only. */
async function anaDay(t: T, ids: Awaited<ReturnType<typeof fixture>>["ids"]) {
  await t.run(async (ctx) => {
    const visit = async (n: number, checkedInAt: number) =>
      ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `v${n}`,
        assigneeProfileId: ids.ana.id,
        outletId: ids.stops[n - 1]!.outlet,
        orgUnitId: ids.regionA,
        serviceDate: date,
        source: "planned",
        plannedVisitId: ids.stops[n - 1]!.planned,
        planId: ids.plan,
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: checkedInAt,
        lastServerTime: checkedInAt + HOUR / 2,
        checkedInAt,
        checkedOutAt: checkedInAt + HOUR / 2,
      });
    const v1 = await visit(1, now - 5 * HOUR);
    const v2 = await visit(2, now - 4 * HOUR);
    const activity = (
      visitId: Id<"visitExecutions">,
      outletId: Id<"outlets">,
      activity:
        | { kind: "order_intent"; clientOrderId: string }
        | {
            kind: "promotion";
            programRef: string;
            finding: "executed" | "not_executed" | "not_applicable";
          },
    ) =>
      ctx.db.insert("visitActivities", {
        organizationId: "sunpride",
        orgUnitId: ids.regionA,
        visitId,
        assigneeProfileId: ids.ana.id,
        outletId,
        activity,
        evidenceIds: [],
        deviceTime: now - 5 * HOUR,
        serverTime: now - 5 * HOUR,
      });
    const o1 = ids.stops[0]!.outlet;
    const o2 = ids.stops[1]!.outlet;
    await activity(v1, o1, { kind: "order_intent", clientOrderId: "ord-1" });
    await activity(v1, o1, {
      kind: "promotion",
      programRef: "PA-2026-09",
      finding: "executed",
    });
    await activity(v2, o2, {
      kind: "promotion",
      programRef: "PA-2026-09",
      finding: "not_executed",
    });
    await ctx.db.insert("fieldCollections", {
      organizationId: "sunpride",
      orgUnitId: ids.regionA,
      customerId: ids.customer,
      outletId: o1,
      visitId: v1,
      assigneeProfileId: ids.ana.id,
      amountMinor: 1_500_00n,
      currency: "PHP",
      method: "cash",
      reference: "OR-77",
      status: "recorded",
      deviceTime: now - 5 * HOUR,
      serverTime: now - 5 * HOUR,
    });
    await ctx.db.insert("fieldCollections", {
      organizationId: "sunpride",
      orgUnitId: ids.regionA,
      customerId: ids.customer,
      outletId: o1,
      visitId: v1,
      assigneeProfileId: ids.ana.id,
      amountMinor: 999_00n,
      currency: "PHP",
      method: "cash",
      reference: "OR-78",
      status: "rejected",
      deviceTime: now - 5 * HOUR,
      serverTime: now - 5 * HOUR,
    });
    await ctx.db.insert("merchandisingAudits", {
      organizationId: "sunpride",
      orgUnitId: ids.regionA,
      visitId: v1,
      outletId: o1,
      assigneeProfileId: ids.ana.id,
      serviceDate: date,
      clientAuditId: "audit-1",
      payloadHash: "hash",
      auditVersion: "1",
      requiredCount: 8,
      requiredAvailableCount: 6,
      requiredOutOfStockCount: 2,
      missingRequiredProductIds: [],
      evidenceIds: [],
      actorSubject: subject("Ana"),
      source: "mobile",
      deviceTime: now - 5 * HOUR,
      serverTime: now - 5 * HOUR,
    });
    const order = (
      n: number,
      customerCode: string,
      total: number,
      status: "posted" | "draft" = "posted",
    ) =>
      ctx.db.insert("orders", {
        organizationId: "sunpride",
        clientRequestId: `req-${n}`,
        orderNumber: `SI-${n}`,
        customerCode,
        salespersonSubject: subject("Ana"),
        status,
        subtotal: total,
        total,
        createdAt: now - 5 * HOUR,
        updatedAt: now - 5 * HOUR,
      });
    await order(1, "C-1", 1_000);
    await order(2, "C-1", 300); // same account again: still one UBA
    await order(3, "C-2", 200);
    await order(4, "C-3", 500, "draft"); // never a sale
    await order(5, "C-4", -100); // a return is not a buying account
  });
}

describe("admin report pack", () => {
  it("reports productive calls, UBA, OSA, mandays, programs and collections", async () => {
    const { t, ids, as } = await fixture();
    await anaDay(t, ids);
    const data = await as("managerA").query(api.analytics.admin_reports.day, {
      serviceDate: date,
    });
    expect(data).toMatchObject({ page: 0, pageCount: 1, peopleInScope: 1 });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      name: "Ana",
      sellingDay: true,
      manday: true,
      // Truck seller: O1 (order) productive, O2 (promotion only) a non-productive call.
      calls: 2,
      productiveCalls: 1,
      callsTarget: 30,
      productiveTargetPct: 85,
      buyingAccounts: ["C-1", "C-2"],
      osaAudits: 1,
      osaRequired: 8,
      osaAvailable: 6,
      collections: 1,
      collectedMinor: 1_500_00,
    });
    expect(data.programs).toEqual([
      {
        programRef: "PA-2026-09",
        executed: 1,
        notExecuted: 1,
        notApplicable: 0,
      },
    ]);
    expect(data.collectionLines).toEqual([
      expect.objectContaining({
        personName: "Ana",
        customerCode: "C-1",
        customerName: "Aling Nena Store",
        outletCode: "O1",
        amountMinor: 1_500_00,
        reference: "OR-77",
        status: "recorded",
      }),
    ]);
    expect(data.collectionLinesTruncated).toBe(false);
    expect(data.buyingAccountsTruncated).toBe(false);
  });

  it("counts only visits inside the selected unit, not the caller's whole scope", async () => {
    const { t, ids, as } = await fixture();
    await anaDay(t, ids);
    await t.run(async (ctx) => {
      // Root-scoped reader, so region B is inside the caller's scope.
      const since = now - 60 * DAY;
      const root = (await ctx.db.get(ids.regionA))!.parentId!;
      const boss = await ctx.db.insert("profiles", {
        authSubject: subject("boss"),
        name: "boss",
        email: "boss@test.local",
        role: "super_admin",
        status: "active",
        orgUnitId: root,
        updatedAt: since,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: boss,
        orgUnitId: root,
        role: "super_admin",
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      // Ana also served a region B store today: a checked-in visit with a collection.
      const visitB = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: "vB",
        assigneeProfileId: ids.ana.id,
        outletId: ids.stops[0]!.outlet,
        orgUnitId: ids.regionB,
        serviceDate: date,
        source: "unplanned",
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: now - 3 * HOUR,
        lastServerTime: now - 3 * HOUR,
        checkedInAt: now - 3 * HOUR,
        checkedOutAt: now - 2 * HOUR,
      });
      await ctx.db.insert("fieldCollections", {
        organizationId: "sunpride",
        orgUnitId: ids.regionB,
        customerId: ids.customer,
        outletId: ids.stops[0]!.outlet,
        visitId: visitB,
        assigneeProfileId: ids.ana.id,
        amountMinor: 777_00n,
        currency: "PHP",
        method: "cash",
        reference: "OR-B",
        status: "recorded",
        deviceTime: now - 3 * HOUR,
        serverTime: now - 3 * HOUR,
      });
    });
    const all = await as("boss").query(api.analytics.admin_reports.day, {
      serviceDate: date,
    });
    const anaAll = all.rows.find((row) => row.name === "Ana")!;
    expect(anaAll).toMatchObject({ collections: 2, collectedMinor: 2_277_00 });
    const a = await as("boss").query(api.analytics.admin_reports.day, {
      serviceDate: date,
      orgUnitId: ids.regionA,
    });
    expect(a.rows.map((row) => row.name)).toEqual(["Ana"]);
    expect(a.rows[0]).toMatchObject({
      calls: 2,
      collections: 1,
      collectedMinor: 1_500_00,
    });
    expect(a.collectionLines.map((line) => line.reference)).toEqual(["OR-77"]);
  });

  it("flags UBA as incomplete when a person's orders overflow the read cap", async () => {
    const { t, ids, as } = await fixture();
    await anaDay(t, ids);
    await t.run(async (ctx) => {
      for (let n = 0; n < MAX_DAY_ORDERS; n++)
        await ctx.db.insert("orders", {
          organizationId: "sunpride",
          clientRequestId: `bulk-${n}`,
          orderNumber: `SI-B${n}`,
          customerCode: `C-B${n}`,
          salespersonSubject: subject("Ana"),
          status: "posted",
          subtotal: 10,
          total: 10,
          createdAt: now - 6 * HOUR,
          updatedAt: now - 6 * HOUR,
        });
    });
    const data = await as("managerA").query(api.analytics.admin_reports.day, {
      serviceDate: date,
    });
    expect(data.buyingAccountsTruncated).toBe(true);
  });

  it("keeps other regions out and counts no manday without a check-in", async () => {
    const { t, ids, as } = await fixture();
    await anaDay(t, ids);
    const b = await as("managerB").query(api.analytics.admin_reports.day, {
      serviceDate: date,
    });
    expect(b.rows.map((row) => row.name)).toEqual(["Cara"]);
    expect(b.rows[0]).toMatchObject({
      manday: false,
      calls: 0,
      buyingAccounts: [],
      collections: 0,
    });
    expect(b.programs).toEqual([]);
    expect(b.collectionLines).toEqual([]);
    await expect(
      as("managerA").query(api.analytics.admin_reports.day, {
        serviceDate: date,
        orgUnitId: ids.regionB,
      }),
    ).rejects.toThrow("outside your organizational scope");
  });

  it("refuses field sales, roles without people access, and bad pages", async () => {
    const { as } = await fixture();
    await expect(
      as("Ana").query(api.analytics.admin_reports.day, { serviceDate: date }),
    ).rejects.toThrow();
    await expect(
      as("opsA").query(api.analytics.admin_reports.day, { serviceDate: date }),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.analytics.admin_reports.day, {
        serviceDate: date,
        page: 1,
      }),
    ).rejects.toThrow("out of range");
    await expect(
      as("managerA").query(api.analytics.admin_reports.day, {
        serviceDate: "2026-02-30",
      }),
    ).rejects.toThrow();
  });
});

const month = "2026-09";

async function office(
  t: T,
  orgUnitId: Id<"orgUnits">,
  record:
    | {
        kind: "program_allocation";
        programRef: string;
        programName: string;
        allocatedStores: number;
        budgetMinor: number;
      }
    | {
        kind: "ar_balance";
        customerCode: string;
        customerName: string;
        asOfDate: string;
        termsDays: number;
        currentMinor: number;
        days1to30Minor: number;
        days31to60Minor: number;
        days61to90Minor: number;
        over90Minor: number;
      },
  code: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("adminPackRecords", {
      ...record,
      organizationId: "sunpride",
      orgUnitId,
      period: month,
      source: "office",
      code,
      createdAt: now,
    }),
  );
}

describe("monthly admin pack (allocation, priorities, claims, AR)", () => {
  it("keeps office rows over sample rows per kind", () => {
    expect(pickSource([])).toEqual({ rows: [], source: null });
    const sample = { source: "sample" as const, n: 1 };
    const real = { source: "office" as const, n: 2 };
    expect(pickSource([sample])).toEqual({ rows: [sample], source: "sample" });
    expect(pickSource([sample, real])).toEqual({
      rows: [real],
      source: "office",
    });
  });

  it("seeds marked sample data once and shows all four reports", async () => {
    const { t, as } = await fixture();
    const first = await t.mutation(internal.analytics.admin_pack_sample.seed, {
      month,
    });
    expect(first.inserted).toBeGreaterThan(0);
    const again = await t.mutation(internal.analytics.admin_pack_sample.seed, {
      month,
    });
    expect(again).toMatchObject({ inserted: 0, skipped: first.inserted });
    const pack = await as("managerA").query(api.analytics.admin_pack.month, {
      month,
    });
    expect(pack.sources).toEqual({
      allocations: "sample",
      priorities: "sample",
      claims: "sample",
      receivables: "sample",
    });
    expect(pack.allocations.map((row) => row.programRef)).toEqual([
      "SAMPLE-PA-01",
      "SAMPLE-PA-02",
      "SAMPLE-PA-03",
      "SAMPLE-PA-04",
    ]);
    // Each region gets its own sample set; Region A's manager never sees Region B's.
    expect(pack.allocations.every((row) => row.code.includes("-A-"))).toBe(
      true,
    );
    expect(pack.priorities.length).toBeGreaterThan(0);
    expect(pack.claims.length).toBeGreaterThan(0);
    // No key account in the fixture: the AR sample uses made-up SAMPLE- accounts.
    expect(pack.receivables.length).toBeGreaterThan(0);
    for (const row of [
      ...pack.allocations,
      ...pack.priorities,
      ...pack.claims,
      ...pack.receivables,
    ]) {
      expect(row.source).toBe("sample");
      expect(row.code.startsWith("SAMPLE-")).toBe(true);
    }
    expect(pack.receivables.every((row) => !row.customerFound)).toBe(true);
    expect(Object.values(pack.truncated).every((flag) => !flag)).toBe(true);
  });

  it("measures allocated programmes and reckons receivables from field records", async () => {
    const { t, ids, as } = await fixture();
    await anaDay(t, ids);
    await t.mutation(internal.analytics.admin_pack_sample.seed, { month });
    await office(
      t,
      ids.regionA,
      {
        kind: "program_allocation",
        programRef: "PA-2026-09",
        programName: "September sardines promo",
        allocatedStores: 4,
        budgetMinor: 50_000_00,
      },
      "PA-ALLOC-1",
    );
    await office(
      t,
      ids.regionA,
      {
        kind: "ar_balance",
        customerCode: "C-1",
        customerName: "Aling Nena Store",
        asOfDate: "2026-09-01",
        termsDays: 30,
        currentMinor: 5_000_00,
        days1to30Minor: 2_000_00,
        days31to60Minor: 0,
        days61to90Minor: 0,
        over90Minor: 1_000_00,
      },
      "AR-C-1",
    );
    const a = await as("managerA").query(api.analytics.admin_pack.month, {
      month,
    });
    // The office loaded allocations and balances: their sample rows disappear.
    expect(a.sources).toMatchObject({
      allocations: "office",
      receivables: "office",
      priorities: "sample",
      claims: "sample",
    });
    expect(a.allocations).toEqual([
      expect.objectContaining({
        programRef: "PA-2026-09",
        allocatedStores: 4,
        executedStores: 1,
        executedChecks: 1,
        notExecutedChecks: 1,
      }),
    ]);
    expect(a.receivables).toEqual([
      expect.objectContaining({
        customerCode: "C-1",
        customerFound: true,
        // ₱1,500 recorded; the rejected ₱999 never reduces the balance.
        collectedMinor: 1_500_00,
        pendingReviewMinor: 0,
      }),
    ]);
    // Region B sees neither Region A's office rows nor Region A's field figures.
    const b = await as("managerB").query(api.analytics.admin_pack.month, {
      month,
    });
    expect(b.allocations).toEqual([]);
    expect(b.receivables).toEqual([]);
    expect(b.sources.allocations).toBe("office");

    // Reset removes sample rows only.
    const reset = await t.mutation(
      internal.analytics.admin_pack_sample.reset,
      {},
    );
    expect(reset.isDone).toBe(true);
    const after = await as("managerA").query(api.analytics.admin_pack.month, {
      month,
    });
    expect(after.priorities).toEqual([]);
    expect(after.claims).toEqual([]);
    expect(after.allocations).toHaveLength(1);
    expect(after.receivables).toHaveLength(1);
  });

  it("flags a capped source so its export fails closed", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_PACK_RECORDS; i++)
        await ctx.db.insert("adminPackRecords", {
          organizationId: "sunpride",
          orgUnitId: ids.regionA,
          period: month,
          source: "office",
          code: `CLAIM-${i}`,
          createdAt: now,
          kind: "adp_claim",
          partnerCode: "ADP-1",
          partnerName: "Partner",
          claimType: "rebate",
          claimRef: `CL-${i}`,
          filedDate: "2026-09-02",
          claimedMinor: 100,
          approvedMinor: null,
          status: "filed",
        });
    });
    const pack = await as("managerA").query(api.analytics.admin_pack.month, {
      month,
    });
    expect(pack.truncated.claims).toBe(true);
    expect(pack.truncated.priorities).toBe(false);
  });

  it("refuses field sales, roles without people access and bad months", async () => {
    const { as } = await fixture();
    await expect(
      as("Ana").query(api.analytics.admin_pack.month, { month }),
    ).rejects.toThrow();
    await expect(
      as("opsA").query(api.analytics.admin_pack.month, { month }),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.analytics.admin_pack.month, {
        month: "2026-13",
      }),
    ).rejects.toThrow();
  });
});
