import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  behindPlan,
  connectorDown,
  dayCloseOf,
  emptyFieldTotals,
  fieldTotals,
  isHighValueOutlet,
  mergeFieldTotals,
  oosHotspots,
  repeated,
  sapIssueKind,
  tripUnclosed,
} from "./exception_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Wednesday 2026-09-30, 15:00 Manila: the 30th is still open, the 29th has closed.
const now = Date.parse("2026-09-30T07:00:00Z");
const at = (date: string, hhmm = "10:00") =>
  Date.parse(`${date}T${hhmm}:00+08:00`);
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;
const period = { from: "2026-09-01", to: "2026-09-30" };

afterEach(() => {
  vi.useRealTimers();
});

describe("management exception rules", () => {
  it("treats A-class and key-account outlets as high value, case-insensitively", () => {
    expect(isHighValueOutlet({ classification: "a" })).toBe(true);
    expect(isHighValueOutlet({ classification: "Key_Account" })).toBe(true);
    expect(isHighValueOutlet({ channel: "modern-trade" })).toBe(true);
    expect(
      isHighValueOutlet({ classification: "B", channel: "General Trade" }),
    ).toBe(false);
    expect(isHighValueOutlet({})).toBe(false);
  });

  it("flags materially behind only below 80% of plan, with a minimum base", () => {
    expect(
      behindPlan({
        plannedClosed: 10,
        doneClosed: 8,
        sales: 0,
        salesTarget: null,
      }),
    ).toEqual({
      planPct: 80,
      salesPct: null,
      reasons: [],
    });
    expect(
      behindPlan({
        plannedClosed: 10,
        doneClosed: 7,
        sales: 79,
        salesTarget: 100,
      }).reasons,
    ).toEqual(["plan", "sales"]);
    // Four planned stops are too few to call a person behind on plan.
    expect(
      behindPlan({
        plannedClosed: 4,
        doneClosed: 0,
        sales: 0,
        salesTarget: null,
      }),
    ).toEqual({
      planPct: null,
      salesPct: null,
      reasons: [],
    });
  });

  it("calls a van trip unclosed only after the 10 PM close of the day it opened", () => {
    const opened = at("2026-09-29", "06:00");
    expect(dayCloseOf(opened)).toBe(at("2026-09-29", "22:00"));
    expect(
      tripUnclosed(
        { status: "open", openedAt: opened, createdAt: opened },
        at("2026-09-29", "21:59"),
      ),
    ).toBe(false);
    expect(
      tripUnclosed(
        { status: "open", openedAt: opened, createdAt: opened },
        at("2026-09-29", "22:01"),
      ),
    ).toBe(true);
    expect(
      tripUnclosed(
        { status: "closed", openedAt: opened, createdAt: opened },
        now,
      ),
    ).toBe(false);
    expect(tripUnclosed({ status: "planned", createdAt: opened }, now)).toBe(
      false,
    );
    expect(
      tripUnclosed(
        { status: "review_required", openedAt: now, createdAt: now },
        now,
      ),
    ).toBe(true);
  });

  it("classifies SAP failures, stuck events and down connectors", () => {
    expect(sapIssueKind({ status: "failed", receivedAt: now }, now)).toBe(
      "failed",
    );
    expect(sapIssueKind({ status: "dead_letter", receivedAt: now }, now)).toBe(
      "dead_letter",
    );
    expect(
      sapIssueKind({ status: "pending", receivedAt: now - 3 * HOUR }, now),
    ).toBe("stuck");
    expect(
      sapIssueKind({ status: "pending", receivedAt: now - HOUR }, now),
    ).toBeNull();
    // A retry scheduled in the future is backing off, not stuck.
    expect(
      sapIssueKind(
        {
          status: "pending",
          receivedAt: now - 3 * HOUR,
          nextAttemptAt: now + HOUR,
        },
        now,
      ),
    ).toBeNull();
    expect(
      sapIssueKind({ status: "completed", receivedAt: 0 }, now),
    ).toBeNull();
    expect(
      connectorDown({ status: "online", lastSeenAt: now - 60_000 }, now),
    ).toBe(false);
    expect(
      connectorDown({ status: "online", lastSeenAt: now - HOUR }, now),
    ).toBe(true);
    expect(connectorDown({ status: "degraded", lastSeenAt: now }, now)).toBe(
      true,
    );
  });

  it("keeps repeated groups and finds out-of-stock hotspots", () => {
    expect(repeated(["a", "b", "a", "a", "b"], (x) => x, 3)).toEqual([
      { key: "a", rows: ["a", "a", "a"] },
    ]);
    const row = (
      outletId: string,
      productId: string,
      serviceDate = "2026-09-01",
    ) => ({
      outletId,
      productId,
      orgUnitId: "u",
      serviceDate,
    });
    const hot = oosHotspots([
      row("o1", "p1"),
      row("o1", "p2", "2026-09-03"),
      row("o1", "p1", "2026-09-02"),
      row("o2", "p1"),
      row("o3", "p1"),
      row("o3", "p9"),
    ]);
    expect(hot.outlets).toEqual([
      { outletId: "o1", findings: 3, products: 2, lastDate: "2026-09-03" },
    ]);
    expect(hot.products).toEqual([
      { productId: "p1", outlets: 3, findings: 4 },
    ]);
  });

  it("adds field page totals exactly", () => {
    const a = fieldTotals([{ reasons: ["plan"], missedHighValueCount: 2 }]);
    const b = fieldTotals([
      { reasons: ["plan", "sales"], missedHighValueCount: 0 },
      { reasons: [], missedHighValueCount: 0 },
    ]);
    expect(
      mergeFieldTotals(mergeFieldTotals(emptyFieldTotals(), a), b),
    ).toEqual({
      people: 3,
      behind: 2,
      behindPlan: 2,
      behindSales: 1,
      missedHighValue: 2,
      peopleMissingHighValue: 1,
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
    const person = async (
      name: string,
      role: "sales" | "manager" | "admin" | "super_admin",
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
    await person("boss", "super_admin", root);
    await person("adminRoot", "admin", root);
    await person("managerA", "manager", regionA);
    await person("managerB", "manager", regionB);
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
    const territoryB = await ctx.db.insert("territories", {
      organizationId: "sunpride",
      code: "T-B",
      name: "Territory B",
      status: "active",
      effectiveFrom: since,
      createdAt: since,
      updatedAt: since,
      createdBy: "fixture",
    });
    await ctx.db.insert("territoryOwnerships", {
      territoryId: territoryB,
      orgUnitId: regionB,
      effectiveFrom: since,
      actorSubject: "fixture",
      reason: "fixture",
      createdAt: since,
    });
    const outlet = (
      code: string,
      orgUnitId: Id<"orgUnits">,
      classification?: string,
    ) =>
      ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code,
        name: `Outlet ${code}`,
        status: "active",
        custodianOrgUnitId: orgUnitId,
        ...(classification ? { classification } : {}),
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
    const outlets = {
      hv: await outlet("HV1", regionA, "A"),
      a2: await outlet("O2", regionA, "B"),
      a3: await outlet("O3", regionA),
      b1: await outlet("B1", regionB, "A"),
    };
    const product = (code: string) =>
      ctx.db.insert("products", {
        code,
        name: `Product ${code}`,
        category: "canned",
        uom: "PC",
        unitPrice: 10,
        active: true,
        updatedAt: since,
      });
    const products = { p1: await product("P1"), p2: await product("P2") };
    return {
      root,
      regionA,
      regionB,
      rds,
      ana,
      cara,
      territory,
      territoryB,
      ownership,
      outlets,
      products,
    };
  });

  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });

  let n = 0;
  /** A planned stop for `who` (plan + slot + planned visit), optionally visited and done. */
  const stop = (args: {
    who: { id: Id<"profiles">; assignment: Id<"employeeAssignments"> };
    orgUnitId: Id<"orgUnits">;
    outlet: Id<"outlets">;
    date: string;
    visited?: boolean;
  }) =>
    t.run(async (ctx) => {
      n++;
      const since = now - 90 * DAY;
      const plan = await ctx.db.insert("coveragePlans", {
        organizationId: "sunpride",
        assigneeProfileId: args.who.id,
        localMonth: "2026-09",
        version: n,
        cycleType: "monthly",
        orgUnitId: args.orgUnitId,
        territoryIds: [ids.territory],
        requestedFrom: since,
        requestedTo: now + 10 * DAY,
        effectiveFrom: since,
        effectiveTo: now + 10 * DAY,
        status: "active",
        preparedBy: "fixture",
        preparedAt: since,
        approvedBy: "fixture",
        approvedAt: since,
        approvalSignature: "signed",
        contentRevision: 1,
        createdBy: "fixture",
        createdAt: since,
        updatedBy: "fixture",
        updatedAt: since,
      });
      const outlet = (await ctx.db.get(args.outlet))!;
      // One persisted owner per outlet: its custodian region's territory.
      const existing = await ctx.db
        .query("outletAssignments")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", args.outlet),
        )
        .first();
      const outletAssignment =
        existing?._id ??
        (await ctx.db.insert("outletAssignments", {
          outletId: args.outlet,
          territoryId:
            outlet.custodianOrgUnitId === ids.regionB
              ? ids.territoryB
              : ids.territory,
          sequence: n,
          effectiveFrom: since,
          actorSubject: "fixture",
          reason: "fixture",
          createdAt: since,
        }));
      const approvedSnapshot = {
        outletId: args.outlet,
        outletCode: outlet.code,
        outletName: outlet.name,
        territoryId: ids.territory,
        territoryCode: "T-A",
        sequence: n,
        outletAssignmentId: outletAssignment,
        territoryOwnershipId: ids.ownership,
        employeeAssignmentId: args.who.assignment,
        orgUnitId: args.orgUnitId,
        activityKind: "sell",
        approvedAssigneeProfileId: args.who.id,
      };
      const slot = await ctx.db.insert("coveragePlanSlots", {
        slotKey: `slot-${n}`,
        planId: plan,
        assigneeProfileId: args.who.id,
        serviceDate: args.date,
        kind: "outlet_visit",
        outletId: args.outlet,
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
        assigneeProfileId: args.who.id,
        outletId: args.outlet,
        serviceDate: args.date,
        status: "planned",
        approvedSnapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 20,
        generatedAt: since,
      });
      if (!args.visited) return { planned, visitId: null };
      const checkedInAt = at(args.date, "10:00");
      const visitId = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `visit-${n}`,
        assigneeProfileId: args.who.id,
        outletId: args.outlet,
        orgUnitId: args.orgUnitId,
        serviceDate: args.date,
        source: "planned",
        plannedVisitId: planned,
        planId: plan,
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: checkedInAt,
        lastServerTime: checkedInAt + HOUR / 2,
        checkedInAt,
        checkedOutAt: checkedInAt + HOUR / 2,
      });
      return { planned, visitId };
    });

  const evidence = (
    visitId: Id<"visitExecutions">,
    orgUnitId: Id<"orgUnits">,
    result: "within_radius" | "outside_radius" | "unreliable",
    serverTime: number,
    reviewStatus:
      "verified" | "pending_review" | "approved_exception" = result ===
    "within_radius"
      ? "verified"
      : "pending_review",
  ) =>
    t.run((ctx) =>
      ctx.db.insert("visitLocationEvidence", {
        organizationId: "sunpride",
        orgUnitId,
        visitId,
        event: "check_in",
        provider: "gps",
        policyVersion: "test",
        result,
        reviewStatus,
        ...(result === "unreliable" ? { mockSignal: true } : {}),
        deviceTime: serverTime,
        serverTime,
      }),
    );

  /** Moves an outlet's current persisted owner to Territory B (region B) an hour ago. */
  const transferToB = (outletId: Id<"outlets">) =>
    t.run(async (ctx) => {
      const moved = now - HOUR;
      const rows = await ctx.db
        .query("outletAssignments")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", outletId),
        )
        .collect();
      for (const row of rows)
        if (row.effectiveTo === undefined)
          await ctx.db.patch(row._id, { effectiveTo: moved });
      await ctx.db.insert("outletAssignments", {
        outletId,
        territoryId: ids.territoryB,
        sequence: 99,
        effectiveFrom: moved,
        actorSubject: "fixture",
        reason: "transfer",
        createdAt: moved,
      });
    });

  return { t, ids, as, stop, evidence, transferToB };
}

describe("management exception dashboard", () => {
  it("lists missed high-value outlets and people behind plan, closed days only", async () => {
    const { t, ids, as, stop } = await fixture();
    // Ana: six closed-day stops, three done (50%); the A-class outlet missed on the 29th.
    for (const date of ["2026-09-28", "2026-09-29"]) {
      await stop({
        who: ids.ana,
        orgUnitId: ids.regionA,
        outlet: ids.outlets.a2,
        date,
        visited: true,
      });
      await stop({
        who: ids.ana,
        orgUnitId: ids.regionA,
        outlet: ids.outlets.a3,
        date,
        visited: date === "2026-09-28",
      });
    }
    await stop({
      who: ids.ana,
      orgUnitId: ids.regionA,
      outlet: ids.outlets.hv,
      date: "2026-09-29",
    });
    await stop({
      who: ids.ana,
      orgUnitId: ids.regionA,
      outlet: ids.outlets.a3,
      date: "2026-09-27",
    });
    // Today's unvisited high-value stop is pending, never missed.
    await stop({
      who: ids.ana,
      orgUnitId: ids.regionA,
      outlet: ids.outlets.hv,
      date: "2026-09-30",
    });
    // Cara (region B) misses a high-value outlet too; manager A must not see her.
    await stop({
      who: ids.cara,
      orgUnitId: ids.regionB,
      outlet: ids.outlets.b1,
      date: "2026-09-29",
    });
    // Ana's monthly target: 26 selling days → ₱1,000/day; 25 closed selling days (Sep 1–29,
    // Mon–Sat) = ₱25,000 target; she sold ₱5,000 on the 28th and ₱9,999 today (open day).
    await t.run(async (ctx) => {
      const from = Date.parse("2026-09-01T00:00:00+08:00");
      await ctx.db.insert("salesTargets", {
        organizationId: "sunpride",
        subjectKind: "employee",
        profileId: ids.ana.id,
        period: "monthly",
        metric: "sales_value",
        value: 26_000_00,
        effectiveFrom: from,
        sourceRef: "fixture",
        createdBy: "fixture",
        createdAt: from,
        updatedAt: from,
      });
      for (const [k, total, createdAt] of [
        [1, 5_000, at("2026-09-28", "11:00")],
        [2, 9_999, at("2026-09-30", "11:00")],
      ] as const)
        await ctx.db.insert("orders", {
          organizationId: "sunpride",
          clientRequestId: `req-${k}`,
          orderNumber: `SI-${k}`,
          customerCode: "C-1",
          salespersonSubject: subject("Ana"),
          status: "posted",
          subtotal: total,
          total,
          createdAt,
          updatedAt: createdAt,
        });
    });

    const data = await as("managerA").query(
      api.analytics.exceptions.field,
      period,
    );
    expect(data).toMatchObject({
      page: 0,
      pageCount: 1,
      peopleInScope: 1,
      truncated: false,
    });
    expect(data.totals).toEqual({
      people: 1,
      behind: 1,
      behindPlan: 1,
      behindSales: 1,
      missedHighValue: 1,
      peopleMissingHighValue: 1,
    });
    expect(data.rows).toHaveLength(1);
    const [ana] = data.rows;
    expect(ana).toMatchObject({
      name: "Ana",
      plannedClosed: 6,
      doneClosed: 3,
      planPct: 50,
      sales: 5_000_00,
      salesTarget: 25_000_00,
      salesPct: 20,
      reasons: ["plan", "sales"],
      missedHighValueCount: 1,
    });
    expect(ana!.missedHighValue).toEqual([
      expect.objectContaining({
        outletCode: "HV1",
        classification: "A",
        serviceDate: "2026-09-29",
      }),
    ]);

    // The national view sees both regions; a region B manager sees only Cara.
    const national = await as("boss").query(
      api.analytics.exceptions.field,
      period,
    );
    expect(national.totals.people).toBe(2);
    expect(national.totals.missedHighValue).toBe(2);
    const b = await as("managerB").query(
      api.analytics.exceptions.field,
      period,
    );
    expect(b.rows.map((row) => row.name)).toEqual(["Cara"]);
    // Cara has one planned stop: too few to judge plan, no target: only the missed outlet.
    expect(b.rows[0]).toMatchObject({ reasons: [], missedHighValueCount: 1 });
  });

  it("refuses field people, out-of-scope units and periods over 31 days", async () => {
    const { ids, as } = await fixture();
    await expect(
      as("Ana").query(api.analytics.exceptions.field, period),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.analytics.exceptions.outOfStock, {
        ...period,
        orgUnitId: ids.regionB,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("managerA").query(api.analytics.exceptions.geofence, {
        from: "2026-08-01",
        to: "2026-09-30",
      }),
    ).rejects.toThrow(/at most 31 days/);
    await expect(
      as("managerA").query(api.analytics.exceptions.field, {
        ...period,
        page: 3,
      }),
    ).rejects.toThrow(/out of range/);
  });

  it("surfaces repeated geofence issues by person and outlet, inside scope", async () => {
    const { ids, as, stop, evidence } = await fixture();
    const visits: Id<"visitExecutions">[] = [];
    for (const date of ["2026-09-25", "2026-09-26", "2026-09-28"]) {
      const { visitId } = await stop({
        who: ids.ana,
        orgUnitId: ids.regionA,
        outlet: ids.outlets.hv,
        date,
        visited: true,
      });
      visits.push(visitId!);
    }
    await evidence(visits[0]!, ids.regionA, "outside_radius", at("2026-09-25"));
    await evidence(visits[1]!, ids.regionA, "unreliable", at("2026-09-26"));
    await evidence(
      visits[2]!,
      ids.regionA,
      "outside_radius",
      at("2026-09-28"),
      "approved_exception",
    );
    // Inside the radius never counts; outside the period never counts.
    await evidence(
      visits[2]!,
      ids.regionA,
      "within_radius",
      at("2026-09-28", "11:00"),
    );
    await evidence(visits[0]!, ids.regionA, "outside_radius", at("2026-08-30"));
    const { visitId: caraVisit } = await stop({
      who: ids.cara,
      orgUnitId: ids.regionB,
      outlet: ids.outlets.b1,
      date: "2026-09-25",
      visited: true,
    });
    for (const hhmm of ["10:00", "11:00", "12:00"])
      await evidence(
        caraVisit!,
        ids.regionB,
        "outside_radius",
        at("2026-09-25", hhmm),
      );

    const data = await as("managerA").query(
      api.analytics.exceptions.geofence,
      period,
    );
    expect(data).toMatchObject({ issues: 3, open: 2, truncated: false });
    expect(data.people).toEqual([
      expect.objectContaining({
        name: "Ana",
        issues: 3,
        open: 2,
        outlets: 1,
        mock: 1,
      }),
    ]);
    expect(data.outlets).toEqual([
      expect.objectContaining({ outletCode: "HV1", issues: 3, people: 1 }),
    ]);
    const national = await as("boss").query(
      api.analytics.exceptions.geofence,
      period,
    );
    expect(national.people.map((row) => row.name).sort()).toEqual([
      "Ana",
      "Cara",
    ]);
  });

  it("shows unclosed trips, stock variances and SAP failures by access", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      const location = (
        code: string,
        orgUnitId: Id<"orgUnits"> | undefined,
        type: "truck" | "warehouse",
      ) =>
        ctx.db.insert("inventoryLocations", {
          organizationId: "sunpride",
          ...(orgUnitId ? { orgUnitId } : {}),
          siteCode: "S1",
          code,
          name: `Location ${code}`,
          type,
          active: true,
          allowsPicking: true,
          allowsReceiving: true,
          allowsSale: type === "truck",
          allowsProduction: false,
          ...(type === "truck" ? { truckCode: code } : {}),
          createdAt: now - 90 * DAY,
          updatedAt: now - 90 * DAY,
        });
      const truckA = await location("TRK-A", ids.regionA, "truck");
      const truckB = await location("TRK-B", ids.regionB, "truck");
      const warehouseA = await location("WH-A", ids.regionA, "warehouse");
      const unmapped = await location("WH-X", undefined, "warehouse");
      const trip = (
        truckLocationId: Id<"inventoryLocations">,
        routeCode: string,
        status: "open" | "closed",
        openedAt: number,
      ) =>
        ctx.db.insert("truckRouteSessions", {
          organizationId: "sunpride",
          routeCode,
          truckLocationId,
          salespersonSubject: subject("Ana"),
          assignedDeviceId: "dev",
          status,
          openedAt,
          lastAcknowledgedSequence: 0,
          createdAt: openedAt,
          updatedAt: openedAt,
        });
      await trip(truckA, "R-OLD", "open", at("2026-09-28", "06:00"));
      await trip(truckA, "R-TODAY", "open", at("2026-09-30", "06:00"));
      await trip(truckA, "R-DONE", "closed", at("2026-09-27", "06:00"));
      await trip(truckB, "R-B", "open", at("2026-09-28", "06:00"));
      const count = async (
        locationId: Id<"inventoryLocations">,
        countNumber: string,
        status: "submitted" | "posted",
        snapshotAt: number,
        variances: bigint[],
      ) => {
        const sessionId = await ctx.db.insert("stockCountSessions", {
          organizationId: "sunpride",
          countNumber,
          countType: "route_close",
          locationId,
          status,
          blindCount: true,
          snapshotAt,
          createdBy: "fixture",
          createdAt: snapshotAt,
          updatedAt: snapshotAt,
        });
        for (const varianceBase of variances)
          await ctx.db.insert("stockCountLines", {
            organizationId: "sunpride",
            sessionId,
            productId: ids.products.p1,
            stockStatus: "available",
            systemBase: 10n,
            countedBase: 10n + varianceBase,
            varianceBase,
          });
      };
      await count(warehouseA, "CNT-OPEN", "submitted", at("2026-08-20"), [
        -2n,
        0n,
        3n,
      ]);
      await count(warehouseA, "CNT-POSTED", "posted", at("2026-09-10"), [-1n]);
      await count(warehouseA, "CNT-OLD", "posted", at("2026-08-10"), [-1n]);
      await count(warehouseA, "CNT-CLEAN", "posted", at("2026-09-12"), [0n]);
      await count(truckB, "CNT-B", "submitted", at("2026-09-12"), [-5n]);
      const run = await ctx.db.insert("inventoryReconciliationRuns", {
        organizationId: "sunpride",
        scope: "all",
        status: "completed",
        convexCutoff: now,
        sapCutoff: now,
        comparedCount: 3,
        differenceCount: 3,
        startedBy: "fixture",
        startedAt: now - DAY,
      });
      for (const [locationId, classification] of [
        [warehouseA, "timing"],
        [unmapped, "mapping"],
        [undefined, "mapping"],
      ] as const)
        await ctx.db.insert("inventoryReconciliationDifferences", {
          organizationId: "sunpride",
          runId: run,
          ...(locationId ? { locationId } : {}),
          productCode: "P1",
          warehouseCode: "WH",
          convexBase: 1n,
          sapBase: 2n,
          differenceBase: -1n,
          classification,
          resolutionStatus: "open",
          createdAt: now - DAY,
        });
      for (const [eventId, status, receivedAt] of [
        ["e-failed", "failed", now - DAY],
        ["e-dead", "dead_letter", now - 2 * DAY],
        ["e-stuck", "pending", now - 5 * HOUR],
        ["e-fresh", "pending", now - 10 * 60_000],
        ["e-ok", "completed", now - DAY],
      ] as const)
        await ctx.db.insert("integrationEvents", {
          eventId,
          direction: "outbound",
          eventType: "inventory.movement",
          status,
          attempts: 3,
          payload: {},
          receivedAt,
          ...(status === "failed" ? { lastError: "x".repeat(400) } : {}),
          sourceDocumentId: `doc-${eventId}`,
        });
      await ctx.db.insert("connectorHeartbeats", {
        connectorId: "sap-1",
        status: "online",
        adapter: "mock",
        lastSeenAt: now - HOUR,
      });
    });

    const a = await as("managerA").query(
      api.analytics.exceptions.operations,
      period,
    );
    expect(a.sap).toEqual({
      available: false,
      reason: "Needs SAP integration access",
    });
    expect(a.cash.tracked).toBe(false);
    if (!a.trips.available || !a.stock.available)
      throw new Error("inventory hidden");
    expect(a.trips.items.map((row) => row.routeCode)).toEqual(["R-OLD"]);
    expect(a.trips.items[0]).toMatchObject({
      truckCode: "TRK-A",
      salespersonName: "Ana",
    });
    expect(
      a.stock.counts.map((row) => [
        row.countNumber,
        row.open,
        row.varianceLines,
      ]),
    ).toEqual([
      ["CNT-OPEN", true, 2],
      ["CNT-POSTED", false, 1],
    ]);
    expect(a.stock.counts[0]).toMatchObject({ missingLines: 1, overLines: 1 });
    // Only the mapped region-A difference; the unmapped ones are national.
    expect(a.stock.sapDifferences).toEqual({
      open: 1,
      byClassification: [{ classification: "timing", count: 1 }],
      unmappedHidden: true,
    });

    const root = await as("adminRoot").query(
      api.analytics.exceptions.operations,
      period,
    );
    if (!root.sap.available || !root.stock.available || !root.trips.available)
      throw new Error("national sections hidden");
    expect(root.sap).toMatchObject({
      failed: 1,
      deadLetter: 1,
      stuck: 1,
      truncated: false,
    });
    expect(root.sap.items.map((row) => row.eventId)).toEqual([
      "e-stuck",
      "e-failed",
      "e-dead",
    ]);
    expect(root.sap.items[1]!.lastError!.length).toBeLessThanOrEqual(160);
    expect(root.sap.connectorsDown).toEqual([
      { connectorId: "sap-1", status: "online", lastSeenAt: now - HOUR },
    ]);
    expect(root.stock.sapDifferences.open).toBe(3);
    expect(root.trips.items.map((row) => row.routeCode).sort()).toEqual([
      "R-B",
      "R-OLD",
    ]);
    // A national admin narrowed to region A loses the unit-less SAP view.
    const narrowed = await as("adminRoot").query(
      api.analytics.exceptions.operations,
      {
        ...period,
        orgUnitId: ids.regionA,
      },
    );
    expect(narrowed.sap.available).toBe(false);
  });

  it("keeps a selected unit's field view free of stops served in another unit", async () => {
    const { ids, as, stop } = await fixture();
    // Ana now works in region A but once missed an A-class outlet while serving region B.
    await stop({
      who: ids.ana,
      orgUnitId: ids.regionB,
      outlet: ids.outlets.b1,
      date: "2026-09-29",
    });
    await stop({
      who: ids.ana,
      orgUnitId: ids.regionB,
      outlet: ids.outlets.b1,
      date: "2026-09-28",
      visited: true,
    });
    const whole = await as("boss").query(
      api.analytics.exceptions.field,
      period,
    );
    const anaWhole = whole.rows.find((row) => row.name === "Ana");
    expect(anaWhole).toMatchObject({ plannedClosed: 2, doneClosed: 1 });
    expect(anaWhole!.missedHighValue.map((row) => row.outletCode)).toEqual([
      "B1",
    ]);
    // Narrowed to region A, neither region B's missed outlet nor its stops appear.
    const regionA = await as("boss").query(api.analytics.exceptions.field, {
      ...period,
      orgUnitId: ids.regionA,
    });
    expect(regionA.peopleInScope).toBe(1);
    expect(regionA.rows).toEqual([]);
    expect(regionA.totals).toMatchObject({ people: 1, missedHighValue: 0 });
  });

  it("withholds blind-count variances from the person who started or counted them", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      const warehouseA = await ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        orgUnitId: ids.regionA,
        siteCode: "S1",
        code: "WH-A",
        name: "Location WH-A",
        type: "warehouse",
        active: true,
        allowsPicking: true,
        allowsReceiving: true,
        allowsSale: false,
        allowsProduction: false,
        createdAt: now - 90 * DAY,
        updatedAt: now - 90 * DAY,
      });
      const count = async (
        countNumber: string,
        blindCount: boolean,
        createdBy: string,
        countedBy?: string,
      ) => {
        const sessionId = await ctx.db.insert("stockCountSessions", {
          organizationId: "sunpride",
          countNumber,
          countType: "cycle",
          locationId: warehouseA,
          status: "submitted",
          blindCount,
          snapshotAt: at("2026-09-20"),
          createdBy,
          createdAt: at("2026-09-20"),
          updatedAt: at("2026-09-20"),
        });
        await ctx.db.insert("stockCountLines", {
          organizationId: "sunpride",
          sessionId,
          productId: ids.products.p1,
          stockStatus: "available",
          systemBase: 10n,
          countedBase: 7n,
          varianceBase: -3n,
          ...(countedBy ? { countedBy } : {}),
        });
      };
      await count("CNT-STARTED", true, subject("managerA"));
      await count("CNT-COUNTED", true, "fixture", subject("managerA"));
      await count("CNT-OTHER", true, "fixture", subject("Ana"));
      await count(
        "CNT-OPEN-BOOK",
        false,
        subject("managerA"),
        subject("managerA"),
      );
    });
    const counter = await as("managerA").query(
      api.analytics.exceptions.operations,
      period,
    );
    if (!counter.stock.available) throw new Error("stock hidden");
    expect(counter.stock.counts.map((row) => row.countNumber).sort()).toEqual([
      "CNT-OPEN-BOOK",
      "CNT-OTHER",
    ]);
    expect(counter.stock.blindWithheld).toBe(2);
    // A separate reviewer sees every blind count's differences.
    const reviewer = await as("adminRoot").query(
      api.analytics.exceptions.operations,
      period,
    );
    if (!reviewer.stock.available) throw new Error("stock hidden");
    expect(reviewer.stock.counts).toHaveLength(4);
    expect(reviewer.stock.blindWithheld).toBe(0);
  });

  it("finds out-of-stock hotspots by outlet, product and unit", async () => {
    const { t, ids, as, stop } = await fixture();
    const { visitId } = await stop({
      who: ids.ana,
      orgUnitId: ids.regionA,
      outlet: ids.outlets.hv,
      date: "2026-09-20",
      visited: true,
    });
    await t.run(async (ctx) => {
      const audit = await ctx.db.insert("merchandisingAudits", {
        organizationId: "sunpride",
        orgUnitId: ids.regionA,
        visitId: visitId!,
        outletId: ids.outlets.hv,
        assigneeProfileId: ids.ana.id,
        serviceDate: "2026-09-20",
        clientAuditId: "audit-1",
        payloadHash: "hash",
        auditVersion: "test",
        requiredCount: 0,
        requiredAvailableCount: 0,
        requiredOutOfStockCount: 0,
        missingRequiredProductIds: [],
        evidenceIds: [],
        actorSubject: subject("Ana"),
        source: "mobile",
        deviceTime: now,
        serverTime: now,
      });
      const finding = (
        outletId: Id<"outlets">,
        productId: Id<"products">,
        serviceDate: string,
        status: "out_of_stock" | "available" | "low_stock" = "out_of_stock",
        orgUnitId: Id<"orgUnits"> = ids.regionA,
      ) =>
        ctx.db.insert("merchandisingAvailability", {
          organizationId: "sunpride",
          orgUnitId,
          auditId: audit,
          outletId,
          productId,
          serviceDate,
          required: true,
          status,
          evidenceIds: [],
        });
      await finding(ids.outlets.hv, ids.products.p1, "2026-09-10");
      await finding(ids.outlets.hv, ids.products.p1, "2026-09-17");
      await finding(ids.outlets.hv, ids.products.p2, "2026-09-20");
      await finding(ids.outlets.a2, ids.products.p1, "2026-09-20");
      await finding(ids.outlets.a3, ids.products.p1, "2026-09-21");
      await finding(ids.outlets.a3, ids.products.p2, "2026-09-21", "low_stock");
      await finding(ids.outlets.a2, ids.products.p2, "2026-08-31");
      for (const date of ["2026-09-01", "2026-09-02", "2026-09-03"])
        await finding(
          ids.outlets.b1,
          ids.products.p2,
          date,
          "out_of_stock",
          ids.regionB,
        );
    });
    const data = await as("managerA").query(
      api.analytics.exceptions.outOfStock,
      period,
    );
    expect(data).toMatchObject({
      findings: 5,
      outletsAffected: 3,
      truncated: false,
    });
    expect(data.outlets).toEqual([
      expect.objectContaining({
        outletCode: "HV1",
        findings: 3,
        products: 2,
        lastDate: "2026-09-20",
      }),
    ]);
    expect(data.products).toEqual([
      expect.objectContaining({ productCode: "P1", outlets: 3, findings: 4 }),
    ]);
    expect(data.units).toEqual([
      expect.objectContaining({ name: "Unit A", findings: 5 }),
    ]);
    const national = await as("boss").query(
      api.analytics.exceptions.outOfStock,
      period,
    );
    expect(national.findings).toBe(8);
    expect(national.outlets.map((row) => row.outletCode).sort()).toEqual([
      "B1",
      "HV1",
    ]);
  });

  it("drops an outlet from a former owner's missed, geofence and out-of-stock lists after it transfers", async () => {
    const { t, ids, as, stop, evidence, transferToB } = await fixture();
    // History in region A at the A-class outlet: a missed stop, three off-radius fixes
    // and three out-of-stock findings.
    await stop({
      who: ids.ana,
      orgUnitId: ids.regionA,
      outlet: ids.outlets.hv,
      date: "2026-09-29",
    });
    for (const date of ["2026-09-25", "2026-09-26", "2026-09-28"]) {
      const { visitId } = await stop({
        who: ids.ana,
        orgUnitId: ids.regionA,
        outlet: ids.outlets.hv,
        date,
        visited: true,
      });
      await evidence(visitId!, ids.regionA, "outside_radius", at(date));
      await t.run(async (ctx) => {
        const audit = await ctx.db.insert("merchandisingAudits", {
          organizationId: "sunpride",
          orgUnitId: ids.regionA,
          visitId: visitId!,
          outletId: ids.outlets.hv,
          assigneeProfileId: ids.ana.id,
          serviceDate: date,
          clientAuditId: `audit-${date}`,
          payloadHash: "hash",
          auditVersion: "test",
          requiredCount: 0,
          requiredAvailableCount: 0,
          requiredOutOfStockCount: 0,
          missingRequiredProductIds: [],
          evidenceIds: [],
          actorSubject: subject("Ana"),
          source: "mobile",
          deviceTime: now,
          serverTime: now,
        });
        await ctx.db.insert("merchandisingAvailability", {
          organizationId: "sunpride",
          orgUnitId: ids.regionA,
          auditId: audit,
          outletId: ids.outlets.hv,
          productId: ids.products.p1,
          serviceDate: date,
          required: true,
          status: "out_of_stock",
          evidenceIds: [],
        });
      });
    }
    const read = async (who: string) => {
      const field = await as(who).query(api.analytics.exceptions.field, period);
      const geofence = await as(who).query(
        api.analytics.exceptions.geofence,
        period,
      );
      const oos = await as(who).query(
        api.analytics.exceptions.outOfStock,
        period,
      );
      return {
        missed: field.rows.flatMap((row) =>
          row.missedHighValue.map((stop) => stop.outletCode),
        ),
        geofenceIssues: geofence.issues,
        geofenceOutlets: geofence.outlets.map((row) => row.outletCode),
        oosFindings: oos.findings,
        oosOutlets: oos.outlets.map((row) => row.outletCode),
      };
    };
    // While region A owns it, its manager sees all three lists.
    expect(await read("managerA")).toEqual({
      missed: ["HV1"],
      geofenceIssues: 3,
      geofenceOutlets: ["HV1"],
      oosFindings: 3,
      oosOutlets: ["HV1"],
    });

    await transferToB(ids.outlets.hv);
    // Region A no longer owns it: nothing about it reaches A's manager.
    expect(await read("managerA")).toEqual({
      missed: [],
      geofenceIssues: 0,
      geofenceOutlets: [],
      oosFindings: 0,
      oosOutlets: [],
    });
    // A cross-scope reader still sees the history.
    expect(await read("boss")).toMatchObject({
      missed: ["HV1"],
      geofenceOutlets: ["HV1"],
      oosOutlets: ["HV1"],
    });
  });
});
