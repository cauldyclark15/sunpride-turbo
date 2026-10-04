import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  completenessOf,
  datesEndingAt,
  fieldMinutes,
  orderStops,
  reportDueAt,
  reportKindFor,
  submitWindowError,
} from "./model";

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

describe("field report rules", () => {
  it("maps DAR to supervisory positions and ROAR to route sellers", () => {
    for (const code of ["SCDM", "CDM_KA", "CDM_GT", "SR_CDS", "CDS", "DS"])
      expect(reportKindFor(code)).toBe("dar");
    for (const code of ["RDS", "RS", "PMOT", "PMOT_EXTRUCK", "PM_STALLS"])
      expect(reportKindFor(code)).toBe("roar");
    for (const code of ["KAS", "BOOKING", "DSP", "SALES_HEAD", undefined, null])
      expect(reportKindFor(code)).toBeNull();
  });

  it("is due by 10 PM Manila, late after, missing once a selling day closes", () => {
    const due = reportDueAt(date);
    expect(due).toBe(Date.parse("2026-09-30T22:00:00+08:00"));
    const base = { serviceDate: date, sellingDay: true };
    expect(
      completenessOf({ ...base, firstSubmittedAt: due, now: due + DAY }),
    ).toBe("submitted");
    expect(
      completenessOf({ ...base, firstSubmittedAt: due + 1, now: due + DAY }),
    ).toBe("late");
    expect(completenessOf({ ...base, firstSubmittedAt: null, now })).toBe(
      "due",
    );
    expect(
      completenessOf({ ...base, firstSubmittedAt: null, now: due + 1 }),
    ).toBe("missing");
    expect(
      completenessOf({ ...base, firstSubmittedAt: null, now: now - DAY }),
    ).toBe("upcoming");
    expect(
      completenessOf({
        serviceDate: "2026-09-27",
        sellingDay: false,
        firstSubmittedAt: null,
        now,
      }),
    ).toBe("off_day");
  });

  it("files today and up to seven days back, never ahead", () => {
    expect(submitWindowError(date, now)).toBeNull();
    expect(submitWindowError("2026-09-23", now)).toBeNull();
    expect(submitWindowError("2026-09-22", now)).toMatch("7 days back");
    expect(submitWindowError("2026-10-01", now)).toMatch("future");
    expect(submitWindowError("2026-02-30", now)).toMatch("YYYY-MM-DD");
  });

  it("orders planned stops by route sequence, unplanned calls last", () => {
    const stops = orderStops([
      { key: "u", source: "unplanned", sequence: null, checkedInAt: 1 },
      { key: "b", source: "not_visited", sequence: 2, checkedInAt: null },
      { key: "a", source: "planned", sequence: 1, checkedInAt: 5 },
    ]);
    expect(stops.map((stop) => stop.key)).toEqual(["a", "b", "u"]);
    expect(datesEndingAt("2026-10-01", 3)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    expect(fieldMinutes(0, 90 * 60_000)).toBe(90);
    expect(fieldMinutes(null, 5)).toBeNull();
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
    const ds = await position("DS", "Distributor Specialist");
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
      positionId: ds,
      effectiveFrom: since,
      workWithWeeklyMin: 4,
      workWithMonthlyMin: 16,
      sourceRef: "memo 2026-01-20 §III",
      createdAt: since,
      updatedAt: since,
    });
    const person = async (
      name: string,
      role: "sales" | "manager" | "viewer",
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
    const viewerA = await person("viewerA", "viewer", regionA);
    const dina = await person("Dina", "sales", regionA, ds);
    const ana = await person("Ana", "sales", regionA, rds);
    const cara = await person("Cara", "sales", regionB, rds);
    const kim = await person("Kim", "sales", regionA, kas);
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
      name: "Route One",
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
      viewerA,
      dina,
      ana,
      cara,
      kim,
      plan,
      route,
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
  /** One of Ana's visits with the given activity kinds. */
  const visit = (args: {
    key: string;
    outlet: Id<"outlets">;
    planned?: Id<"plannedVisits">;
    checkedInAt: number;
    activities: ("order_intent" | "merchandising" | "note")[];
  }) =>
    t.run(async (ctx) => {
      const visitId = await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: args.key,
        assigneeProfileId: ids.ana.id,
        outletId: args.outlet,
        orgUnitId: ids.regionA,
        routeId: ids.route,
        serviceDate: date,
        source: args.planned ? "planned" : "unplanned",
        ...(args.planned
          ? { plannedVisitId: args.planned, planId: ids.plan }
          : {}),
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: args.checkedInAt,
        lastServerTime: args.checkedInAt + HOUR / 2,
        checkedInAt: args.checkedInAt,
        checkedOutAt: args.checkedInAt + HOUR / 2,
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
                : { kind, text: "Owner asked for the new promo" },
          evidenceIds: [],
          deviceTime: args.checkedInAt,
          serverTime: args.checkedInAt,
        });
      return visitId;
    });
  /** A routine day for Ana: stop 1 ordered, stop 2 merchandising only, stop 3 skipped. */
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
      activities: ["order_intent"],
    });
  };
  return { t, ids, as, visit, anaDay };
}

describe("field reports", () => {
  it("generates a route seller's ROAR from the day's visits", async () => {
    const { as, anaDay } = await fixture();
    await anaDay();
    const report = await as("Ana").query(api.field_reports.reports.day, {
      serviceDate: date,
    });
    expect(report).not.toBeNull();
    expect(report!.kind).toBe("roar");
    expect(report!.person).toMatchObject({
      name: "Ana",
      positionCode: "RDS",
      unitName: "Unit A",
    });
    // Truck seller: merchandising without the no-sales marker is not productive.
    expect(report!.summary).toMatchObject({
      planned: 3,
      plannedDone: 2,
      notVisited: 1,
      unplanned: 1,
      calls: 2,
      productiveCalls: 1,
      productivePct: 50,
      workWithSessions: 0,
      fieldMinutes: 150,
    });
    expect(report!.standard).toMatchObject({
      dailyCallsTarget: 30,
      productiveCallTargetPct: 85,
    });
    expect(report!.callsTargetMet).toBe(false);
    expect(report!.productiveTargetMet).toBe(false);
    expect(
      report!.stops.map((stop) => [stop.outletCode, stop.callStatus]),
    ).toEqual([
      ["O1", "productive"],
      ["O2", "nonproductive"],
      ["O3", "not_visited"],
      ["O9", "off_plan"],
    ]);
    expect(report!.stops[0]).toMatchObject({
      routeCode: "R-01",
      matchedCodes: ["purchase_order"],
      notes: ["Owner asked for the new promo"],
      callMinutes: 30,
    });
    expect(report!.routes).toEqual([
      {
        routeCode: "R-01",
        routeName: "Route One",
        calls: 2,
        productiveCalls: 1,
        productivePct: 50,
      },
    ]);
    expect(report!.status).toBe("due");
    expect(report!.canSubmit).toBe(true);
    expect(report!.submission).toBeNull();
  });

  it("puts the supervisor's Work-With sessions in the DAR", async () => {
    const { t, ids, as } = await fixture();
    await t.run(async (ctx) => {
      const base = {
        organizationId: "sunpride",
        trainerProfileId: ids.dina.id,
        traineeProfileId: ids.ana.id,
        orgUnitId: ids.regionA,
        serviceDate: date,
        objective: "training" as const,
        mode: "booking" as const,
        observations: [],
        createdBy: subject("Dina"),
        createdAt: now,
        updatedBy: subject("Dina"),
        updatedAt: now,
      };
      await ctx.db.insert("workWithSessions", {
        ...base,
        status: "completed",
        mcpPlanned: 3,
        mcpDone: 3,
        completedAt: now,
      });
      await ctx.db.insert("workWithSessions", {
        ...base,
        status: "cancelled",
        cancelledAt: now,
      });
    });
    const report = await as("Dina").query(api.field_reports.reports.day, {
      serviceDate: date,
    });
    expect(report!.kind).toBe("dar");
    expect(report!.standard).toBeNull();
    expect(report!.workWith).toEqual([
      expect.objectContaining({
        traineeName: "Ana",
        objective: "training",
        status: "completed",
        mcpPlanned: 3,
        mcpDone: 3,
      }),
    ]);
    expect(report!.summary).toMatchObject({
      workWithSessions: 1,
      workWithCompleted: 1,
      calls: 0,
    });
  });

  it("returns no report for positions that file neither", async () => {
    const { as } = await fixture();
    expect(
      await as("Kim").query(api.field_reports.reports.day, {
        serviceDate: date,
      }),
    ).toBeNull();
    expect(
      await as("viewerA").query(api.field_reports.reports.day, {
        serviceDate: date,
      }),
    ).toBeNull();
    expect(
      await as("Kim").query(api.field_reports.reports.myKind, {}),
    ).toBeNull();
    expect(await as("Dina").query(api.field_reports.reports.myKind, {})).toBe(
      "dar",
    );
    expect(await as("Ana").query(api.field_reports.reports.myKind, {})).toBe(
      "roar",
    );
  });

  it("keeps every submission as a revision with its figures frozen", async () => {
    const { t, ids, as, visit, anaDay } = await fixture();
    await anaDay();
    const ana = as("Ana");
    const first = await ana.mutation(api.field_reports.reports.submit, {
      serviceDate: date,
      remarks: "  Stop 3 closed for fiesta  ",
    });
    expect(first).toMatchObject({ revision: 1, late: false });
    expect(first.summary.calls).toBe(2);

    // A late sync adds stop 3 after the report was filed.
    await visit({
      key: "v3",
      outlet: ids.stops[2]!.outlet,
      planned: ids.stops[2]!.planned,
      checkedInAt: now - HOUR,
      activities: ["order_intent"],
    });
    vi.setSystemTime(now + HOUR);
    const second = await ana.mutation(api.field_reports.reports.submit, {
      serviceDate: date,
      remarks: "Stop 3 visited after all",
    });
    expect(second.revision).toBe(2);
    expect(second.summary.calls).toBe(3);

    const report = await ana.query(api.field_reports.reports.day, {
      serviceDate: date,
    });
    expect(report!.status).toBe("submitted");
    expect(report!.revisions).toBe(2);
    expect(report!.submission).toMatchObject({
      revision: 2,
      remarks: "Stop 3 visited after all",
      submittedAt: now + HOUR,
      firstSubmittedAt: now,
      submittedByName: "Ana",
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("fieldDayReports")
        .withIndex("by_profileId_and_serviceDate_and_revision", (q) =>
          q.eq("profileId", ids.ana.id).eq("serviceDate", date),
        )
        .collect(),
    );
    expect(
      rows.map((row) => [row.revision, row.remarks, row.summary.calls]),
    ).toEqual([
      [1, "Stop 3 closed for fiesta", 2],
      [2, "Stop 3 visited after all", 3],
    ]);
    expect(rows[0]!.submittedBy).toBe(subject("Ana"));
    expect(rows[0]!.kind).toBe("roar");
  });

  it("marks a report first filed after 10 PM as late", async () => {
    const { as } = await fixture();
    vi.setSystemTime(reportDueAt(date) + 1);
    const result = await as("Ana").mutation(api.field_reports.reports.submit, {
      serviceDate: date,
      remarks: "",
    });
    expect(result.late).toBe(true);
    const report = await as("Ana").query(api.field_reports.reports.day, {
      serviceDate: date,
    });
    expect(report!.status).toBe("late");
  });

  it("refuses submissions outside the rules", async () => {
    const { as } = await fixture();
    const submit = (name: string, serviceDate: string, remarks = "") =>
      as(name).mutation(api.field_reports.reports.submit, {
        serviceDate,
        remarks,
      });
    await expect(submit("Kim", date)).rejects.toThrow("does not file");
    await expect(submit("viewerA", date)).rejects.toThrow(
      "Insufficient permission",
    );
    await expect(submit("Ana", "2026-10-01")).rejects.toThrow("future");
    await expect(submit("Ana", "2026-09-22")).rejects.toThrow("7 days back");
    await expect(submit("Ana", date, "x".repeat(2001))).rejects.toThrow(
      "2000 characters",
    );
  });

  it("lets supervisors read reports in their scope only", async () => {
    const { ids, as, anaDay } = await fixture();
    await anaDay();
    const read = (name: string, profileId: Id<"profiles">) =>
      as(name).query(api.field_reports.reports.day, {
        serviceDate: date,
        profileId,
      });
    const report = await read("managerA", ids.ana.id);
    expect(report!.summary.calls).toBe(2);
    expect(report!.canSubmit).toBe(false);
    expect(report!.submitBlockedReason).toMatch("Only the filer");
    expect(await read("managerA", ids.kim.id)).toBeNull();
    await expect(read("managerB", ids.ana.id)).rejects.toThrow("outside");
    // Field sales never read a colleague's report.
    await expect(read("Ana", ids.dina.id)).rejects.toThrow(
      "Insufficient permission",
    );
  });

  it("tracks submission completeness per person per day", async () => {
    const { as } = await fixture();
    await as("Ana").mutation(api.field_reports.reports.submit, {
      serviceDate: date,
      remarks: "Done",
    });
    const grid = await as("managerA").query(
      api.field_reports.reports.completeness,
      {
        endDate: date,
        days: 4,
      },
    );
    // 2026-09-27 is a Sunday.
    expect(grid.dates).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      date,
    ]);
    expect(
      grid.people.map((person) => [
        person.name,
        person.kind,
        person.days.map((day) => day.status),
      ]),
    ).toEqual([
      ["Ana", "roar", ["off_day", "missing", "missing", "submitted"]],
      ["Dina", "dar", ["off_day", "missing", "missing", "due"]],
    ]);
    expect(grid.totals.at(-1)).toEqual({
      serviceDate: date,
      required: 2,
      submitted: 1,
      late: 0,
      missing: 0,
    });
    expect(grid.totals[1]).toMatchObject({ required: 2, missing: 2 });

    const onlyRoar = await as("managerA").query(
      api.field_reports.reports.completeness,
      { endDate: date, days: 1, kind: "roar" },
    );
    expect(onlyRoar.people.map((person) => person.name)).toEqual(["Ana"]);
    const regionB = await as("managerB").query(
      api.field_reports.reports.completeness,
      { endDate: "2026-10-01", days: 2 },
    );
    expect(
      regionB.people.map((person) => [
        person.name,
        person.days.map((day) => day.status),
      ]),
    ).toEqual([["Cara", ["due", "upcoming"]]]);
    await expect(
      as("managerA").query(api.field_reports.reports.completeness, {
        endDate: date,
        days: 15,
      }),
    ).rejects.toThrow("1 to 14");
    await expect(
      as("Ana").query(api.field_reports.reports.completeness, {
        endDate: date,
      }),
    ).rejects.toThrow("Insufficient permission");
  });
});
