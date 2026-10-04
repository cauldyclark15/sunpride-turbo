import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  cadenceState,
  completionGaps,
  countIn,
  monthOf,
  weekOf,
  type WorkWithDraft,
} from "./work_with_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
// Wednesday 2026-09-30, 15:00 Manila.
const date = "2026-09-30";
const now = Date.parse("2026-09-30T07:00:00Z");
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

const observations = [
  {
    area: "bcp" as const,
    item: "Greet and check stock",
    rating: "met" as const,
  },
  {
    area: "psf" as const,
    item: "State the benefit",
    rating: "partial" as const,
    remark: "Lead with the promo",
  },
];
const swot = {
  strengths: "Knows the outlets",
  weaknesses: "Rushes the close",
  opportunities: "New stall row",
  threats: "Competitor promo",
};
const preCall = {
  documents: ["call_sheet" as const, "daily_productive_sales_report" as const],
  remarks: "Two outlets below target",
};

describe("work-with rules", () => {
  it("uses Monday-to-Sunday weeks and calendar months", () => {
    expect(weekOf("2026-09-30")).toEqual({
      start: "2026-09-28",
      end: "2026-10-04",
    });
    expect(weekOf("2026-09-28").start).toBe("2026-09-28");
    expect(weekOf("2026-10-04").start).toBe("2026-09-28");
    expect(monthOf("2026-02-10")).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
      month: "2026-02",
    });
    expect(() => weekOf("2026-02-30")).toThrow();
  });

  it("judges a period behind only after it ends", () => {
    expect(cadenceState(4, 4, "2026-10-04", "2026-10-05")).toBe("met");
    expect(cadenceState(2, 4, "2026-10-04", "2026-10-01")).toBe("on_track");
    expect(cadenceState(2, 4, "2026-10-04", "2026-10-05")).toBe("behind");
    expect(cadenceState(0, null, "2026-10-04", "2026-10-05")).toBe(
      "no_standard",
    );
  });

  it("counts only completed sessions inside the period", () => {
    const rows = [
      { serviceDate: "2026-09-28", status: "completed" },
      { serviceDate: "2026-09-29", status: "open" },
      { serviceDate: "2026-09-30", status: "cancelled" },
      { serviceDate: "2026-10-05", status: "completed" },
    ];
    expect(countIn(rows, "2026-09-28", "2026-10-04")).toBe(1);
  });

  it("requires BCP and PSF in every work-with and the training log for training", () => {
    const draft: WorkWithDraft = {
      objective: "training",
      mode: "booking",
      observations: [],
    };
    expect(completionGaps(draft, { planned: 0, done: 0 })).toEqual([
      "bcp_observation",
      "psf_observation",
      "training_log",
      "trade_development",
      "training_log_discussed",
    ]);
    expect(
      completionGaps(
        {
          ...draft,
          observations,
          trainingLog: {
            topics: "Basic call",
            tradeDevelopment: "Shelf share",
            discussedWithTrainee: true,
          },
        },
        // The end-to-end rule belongs to the sales/validation objective only.
        { planned: 0, done: 0 },
      ),
    ).toEqual([]);
  });

  it("applies pre/post SWOT review and the end-to-end rule to sales and validation", () => {
    const base: WorkWithDraft = {
      objective: "sales_validation",
      mode: "truck",
      observations,
      postCall: { ...swot, threats: "  " },
    };
    expect(completionGaps(base, { planned: 0, done: 0 })).toEqual([
      "pre_call_documents",
      "pre_call_remarks",
      "post_call_swot",
      "mcp_missing",
      "truck_missing",
      "truck_not_ridden",
    ]);
    expect(
      completionGaps(
        { ...base, preCall, postCall: swot, truckReference: "TRK-7" },
        { planned: 3, done: 2 },
      ),
    ).toEqual(["mcp_unfinished", "truck_not_ridden"]);
    expect(
      completionGaps(
        {
          ...base,
          preCall,
          postCall: swot,
          truckReference: "TRK-7",
          rodeWithTruck: true,
        },
        { planned: 3, done: 3 },
      ),
    ).toEqual([]);
  });
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const since = now - 60 * 24 * HOUR;
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
    const position = async (code: string, label: string) =>
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
    const rs = await position("RS", "Route Sales (RS)");
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
      supervisorId?: Id<"profiles">,
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
        ...(supervisorId ? { supervisorId } : {}),
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      return { id, assignment };
    };
    const managerA = await person("managerA", "manager", regionA);
    const managerB = await person("managerB", "manager", regionB);
    await person("viewerA", "viewer", regionA);
    const trainer = await person("Dina", "sales", regionA, ds, managerA.id);
    const ana = await person("Ana", "sales", regionA, rs);
    const cara = await person("Cara", "sales", regionB, rs);
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
    const stops: { planned: Id<"plannedVisits">; outlet: Id<"outlets"> }[] = [];
    for (const n of [1, 2]) {
      const outlet = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: `O${n}`,
        name: `Outlet ${n}`,
        status: "active",
        custodianOrgUnitId: regionA,
        createdAt: since,
        updatedAt: since,
        createdBy: "fixture",
      });
      const outletAssignment = await ctx.db.insert("outletAssignments", {
        outletId: outlet,
        territoryId: territory,
        sequence: n,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
      const approvedSnapshot = {
        outletId: outlet,
        outletCode: `O${n}`,
        outletName: `Outlet ${n}`,
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
        outletId: outlet,
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
        outletId: outlet,
        serviceDate: date,
        status: "planned",
        approvedSnapshot,
        requiredObjectives: [],
        intents: ["sell"],
        expectedDurationMinutes: 20,
        generatedAt: since,
      });
      stops.push({ planned, outlet });
    }
    return {
      regionA,
      regionB,
      managerA,
      managerB,
      trainer,
      ana,
      cara,
      plan,
      stops,
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      issuer: ISSUER,
      subject: name,
      email: `${name}@test.local`,
    });
  /** Ana checks out of the planned stops given. */
  const finishStops = async (count: number) =>
    t.run(async (ctx) => {
      for (const [index, stop] of ids.stops.slice(0, count).entries())
        await ctx.db.insert("visitExecutions", {
          organizationId: "sunpride",
          clientVisitId: `client-${index}`,
          assigneeProfileId: ids.ana.id,
          outletId: stop.outlet,
          orgUnitId: ids.regionA,
          serviceDate: date,
          source: "planned",
          plannedVisitId: stop.planned,
          planId: ids.plan,
          intents: ["sell"],
          state: "checked-out",
          productivity: "verified",
          createdAt: now - HOUR,
          lastServerTime: now - HOUR,
          checkedInAt: now - 2 * HOUR,
          checkedOutAt: now - HOUR,
        });
    });
  return { t, ids, as, finishStops };
}

describe("work-with sessions", () => {
  it("starts only with another active person inside the trainer's scope", async () => {
    const { ids, as } = await fixture();
    const dina = as("Dina");
    const base = {
      serviceDate: date,
      objective: "training" as const,
      mode: "booking" as const,
    };
    await expect(
      dina.mutation(api.supervision.work_with.start, {
        ...base,
        traineeProfileId: ids.trainer.id,
      }),
    ).rejects.toThrow("yourself");
    await expect(
      dina.mutation(api.supervision.work_with.start, {
        ...base,
        traineeProfileId: ids.cara.id,
      }),
    ).rejects.toThrow("outside your organizational scope");
    await expect(
      dina.mutation(api.supervision.work_with.start, {
        ...base,
        mode: "truck",
        traineeProfileId: ids.ana.id,
      }),
    ).rejects.toThrow("Name the truck");
    await expect(
      dina.mutation(api.supervision.work_with.start, {
        ...base,
        serviceDate: "2026-12-01",
        traineeProfileId: ids.ana.id,
      }),
    ).rejects.toThrow("within 31 days");
    await expect(
      as("viewerA").mutation(api.supervision.work_with.start, {
        ...base,
        traineeProfileId: ids.ana.id,
      }),
    ).rejects.toThrow("Insufficient permission");
    await dina.mutation(api.supervision.work_with.start, {
      ...base,
      traineeProfileId: ids.ana.id,
    });
    await expect(
      dina.mutation(api.supervision.work_with.start, {
        ...base,
        traineeProfileId: ids.ana.id,
      }),
    ).rejects.toThrow("already have a Work-With");
  });

  it("completes a training work-with only once its log and observations are in", async () => {
    const { ids, as } = await fixture();
    const dina = as("Dina");
    const sessionId = await dina.mutation(api.supervision.work_with.start, {
      traineeProfileId: ids.ana.id,
      serviceDate: date,
      objective: "training",
      mode: "booking",
    });
    await expect(
      dina.mutation(api.supervision.work_with.complete, { sessionId }),
    ).rejects.toThrow("Basic Call Procedure");
    await expect(
      as("Ana").mutation(api.supervision.work_with.update, {
        sessionId,
        observations,
      }),
    ).rejects.toThrow("not found");
    await dina.mutation(api.supervision.work_with.update, {
      sessionId,
      observations,
      trainingLog: {
        topics: "  Basic call procedure  ",
        tradeDevelopment: "Shelf share at stalls",
        discussedWithTrainee: false,
      },
    });
    const before = await as("Ana").query(api.supervision.work_with.detail, {
      sessionId,
    });
    expect(before.gaps.map((gap) => gap.code)).toEqual([
      "training_log_discussed",
    ]);
    expect(before.session.trainingLog?.topics).toBe("Basic call procedure");
    expect(before.canEdit).toBe(false);
    await dina.mutation(api.supervision.work_with.update, {
      sessionId,
      trainingLog: {
        topics: "Basic call procedure",
        tradeDevelopment: "Shelf share at stalls",
        discussedWithTrainee: true,
      },
    });
    await dina.mutation(api.supervision.work_with.complete, { sessionId });
    const after = await as("managerA").query(api.supervision.work_with.detail, {
      sessionId,
    });
    expect(after.session.status).toBe("completed");
    expect(after.trainerName).toBe("Dina");
    await expect(
      dina.mutation(api.supervision.work_with.update, {
        sessionId,
        observations: [],
      }),
    ).rejects.toThrow("already closed");
    await expect(
      as("managerB").query(api.supervision.work_with.detail, { sessionId }),
    ).rejects.toThrow("outside your organizational scope");
  });

  it("closes a sales work-with end to end: MCP finished and the named truck ridden", async () => {
    const { ids, as, finishStops } = await fixture();
    const dina = as("Dina");
    const sessionId = await dina.mutation(api.supervision.work_with.start, {
      traineeProfileId: ids.ana.id,
      serviceDate: date,
      objective: "sales_validation",
      mode: "truck",
      truckReference: "TRK-7",
    });
    await dina.mutation(api.supervision.work_with.update, {
      sessionId,
      observations,
      preCall,
      postCall: swot,
    });
    await finishStops(1);
    await expect(
      dina.mutation(api.supervision.work_with.complete, { sessionId }),
    ).rejects.toThrow("not finished the day's MCP");
    await finishStops(2);
    const open = await dina.query(api.supervision.work_with.detail, {
      sessionId,
    });
    expect(open.mcp).toEqual({ planned: 2, done: 2 });
    expect(open.gaps.map((gap) => gap.code)).toEqual(["truck_not_ridden"]);
    await dina.mutation(api.supervision.work_with.update, {
      sessionId,
      rodeWithTruck: true,
    });
    await dina.mutation(api.supervision.work_with.complete, { sessionId });
    const done = await dina.query(api.supervision.work_with.detail, {
      sessionId,
    });
    expect(done.session).toMatchObject({
      status: "completed",
      mcpPlanned: 2,
      mcpDone: 2,
      rodeWithTruck: true,
    });
  });

  it("shows each trainer's cadence against the position minimum to supervisors in scope", async () => {
    const { ids, as } = await fixture();
    const dina = as("Dina");
    const training = async (serviceDate: string, complete = true) => {
      vi.setSystemTime(now);
      const sessionId = await dina.mutation(api.supervision.work_with.start, {
        traineeProfileId: ids.ana.id,
        serviceDate,
        objective: "training",
        mode: "booking",
      });
      await dina.mutation(api.supervision.work_with.update, {
        sessionId,
        observations,
        trainingLog: {
          topics: "BCP",
          tradeDevelopment: "Displays",
          discussedWithTrainee: true,
        },
      });
      if (complete)
        await dina.mutation(api.supervision.work_with.complete, { sessionId });
      return sessionId;
    };
    await training("2026-09-21"); // previous week, same month
    await training("2026-09-28");
    await training("2026-09-29");
    const open = await training("2026-09-30", false);
    const cancelled = await dina.mutation(api.supervision.work_with.start, {
      traineeProfileId: ids.managerA.id,
      serviceDate: date,
      objective: "training",
      mode: "booking",
    });
    await dina.mutation(api.supervision.work_with.cancel, {
      sessionId: cancelled,
      reason: "Trainee on leave",
    });

    const read = await as("managerA").query(api.supervision.work_with.cadence, {
      serviceDate: date,
    });
    expect(read.week).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(read.trainers).toHaveLength(1);
    expect(read.trainers[0]).toMatchObject({
      name: "Dina",
      positionLabel: "Distributor Specialist",
      direct: true,
      weeklyMin: 4,
      monthlyMin: 16,
      weekCount: 2,
      monthCount: 3,
      openCount: 1,
      weekState: "on_track",
      monthState: "on_track",
    });
    expect(read.sessions.map((row) => row.status).sort()).toEqual([
      "cancelled",
      "completed",
      "completed",
      "completed",
      "open",
    ]);
    expect(
      read.sessions.find((row) => row.sessionId === open)?.traineeName,
    ).toBe("Ana");

    // The previous week has ended with one session: behind.
    const past = await as("viewerA").query(api.supervision.work_with.cadence, {
      serviceDate: "2026-09-21",
    });
    expect(past.trainers[0]).toMatchObject({
      weekCount: 1,
      weekState: "behind",
    });

    // Other regions see nothing; field people get no team view.
    const other = await as("managerB").query(
      api.supervision.work_with.cadence,
      { serviceDate: date },
    );
    expect(other.trainers).toEqual([]);
    expect(other.sessions).toEqual([]);
    await expect(
      as("Ana").query(api.supervision.work_with.cadence, { serviceDate: date }),
    ).rejects.toThrow("Insufficient permission");

    // A trainer's own list and the people they may pick stay in scope.
    const mine = await dina.query(api.supervision.work_with.mine, {
      serviceDate: date,
    });
    expect(mine.sessions).toHaveLength(5);
    const names = mine.trainees.map((row) => row.name);
    expect(names).toContain("Ana");
    expect(names).not.toContain("Cara");
    expect(names).not.toContain("Dina");
  });
});
