import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  combineWeeks,
  coverageVerdict,
  emptyWeek,
  mondayOf,
  PERSISTENT_WEEKS,
  rankByCoverage,
  UNDER_COVERAGE_PCT,
  weekCompliancePct,
  weeksError,
  weekWindows,
  type WeekFigures,
} from "./compliance_model";

type T = TestConvex<typeof schema>;
const HOUR = 3_600_000;
// Wednesday 30 Sep 2026, 11:00 Manila: Monday 28 Sep has closed, today is open.
const now = Date.parse("2026-09-30T03:00:00Z");
const END = "2026-09-30";
const MONDAYS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];
const ISSUER = "https://auth.test";
const subject = (name: string) => `${ISSUER}|${name}`;

afterEach(() => {
  vi.useRealTimers();
});

const wk = (over: Partial<WeekFigures>): WeekFigures => ({
  ...emptyWeek(),
  ...over,
});

describe("compliance rules", () => {
  it("builds Monday weeks ending at the end date", () => {
    expect(mondayOf("2026-09-30")).toBe("2026-09-28");
    expect(mondayOf("2026-10-04")).toBe("2026-09-28"); // Sunday
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    const windows = weekWindows(END, 4, (date) => date < "2026-09-30");
    expect(windows.map((w) => w.weekStart)).toEqual(MONDAYS);
    expect(windows[3]).toEqual({
      weekStart: "2026-09-28",
      from: "2026-09-28",
      to: END,
      closed: false,
    });
    expect(windows[2]).toMatchObject({ to: "2026-09-27", closed: true });
    expect(weeksError(1)).not.toBeNull();
    expect(weeksError(9)).not.toBeNull();
    expect(weeksError(2.5)).not.toBeNull();
    expect(weeksError(8)).toBeNull();
  });

  it("judges only closed weeks with stops due, counting the latest run", () => {
    const closed = [true, true, true, true, false].map((c) => ({ closed: c }));
    const under = wk({ planned: 10, done: 5, missed: 5 });
    const ok = wk({ planned: 10, done: 10 });
    // Under, ok, under, (nothing planned), open week: the run since the last ok is 1.
    const verdict = coverageVerdict(
      [under, ok, under, emptyWeek(), wk({ planned: 4, missed: 4 })],
      closed,
    );
    expect(verdict).toMatchObject({ underWeeks: 2, judgedWeeks: 3, streak: 1 });
    expect(verdict.persistent).toBe(false);
    expect(verdict.compliancePct).toBe(Math.floor((20 * 100) / 34));
    const run = coverageVerdict(
      [ok, under, emptyWeek(), under, under],
      [true, true, true, true, true].map((c) => ({ closed: c })),
    );
    expect(run.streak).toBe(PERSISTENT_WEEKS);
    expect(run.persistent).toBe(true);
    // Exactly at the threshold is not under-covered; pending stops are not due.
    expect(
      weekCompliancePct(
        wk({ planned: 12, done: UNDER_COVERAGE_PCT, missed: 10, pending: 2 }),
      ),
    ).toBe(UNDER_COVERAGE_PCT);
    expect(
      coverageVerdict([wk({ planned: 2, pending: 2 })], [{ closed: false }]),
    ).toMatchObject({ compliancePct: null, judgedWeeks: 0, streak: 0 });
  });

  it("sums weeks before dividing and ranks the worst first", () => {
    const a = [wk({ planned: 10, done: 9, missed: 1 })];
    const b = [wk({ planned: 2, missed: 2 })];
    expect(combineWeeks([a, b])).toEqual([
      wk({ planned: 12, done: 9, missed: 3 }),
    ]);
    // 9 of 12, not the mean of 90% and 0%.
    expect(weekCompliancePct(combineWeeks([a, b])[0]!)).toBe(75);
    const verdict = (over: Partial<ReturnType<typeof coverageVerdict>>) => ({
      compliancePct: 100,
      underWeeks: 0,
      judgedWeeks: 4,
      streak: 0,
      persistent: false,
      ...over,
    });
    const ranked = rankByCoverage([
      { code: "OK", verdict: verdict({}) },
      { code: "NONE", verdict: verdict({ compliancePct: null }) },
      { code: "LOW", verdict: verdict({ compliancePct: 70, underWeeks: 1 }) },
      {
        code: "PERSIST",
        verdict: verdict({
          compliancePct: 80,
          underWeeks: 3,
          streak: 3,
          persistent: true,
        }),
      },
      { code: "LOWER", verdict: verdict({ compliancePct: 60, underWeeks: 1 }) },
    ]);
    expect(ranked.map((row) => row.code)).toEqual([
      "PERSIST",
      "LOWER",
      "LOW",
      "OK",
      "NONE",
    ]);
  });
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
    await person("managerB", "manager", regionB);
    await person("analyst", "analyst", root);
    const ana = await person("Ana", "sales", regionA);

    const territory = async (code: string) => {
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
        orgUnitId: regionA,
        effectiveFrom: since,
        ...base,
      });
      return { id, ownership, code };
    };
    const ta = await territory("T-A");
    const tb = await territory("T-B");
    const outlet = async (
      n: number,
      place: Awaited<ReturnType<typeof territory>>,
    ) => {
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
        territoryId: place.id,
        sequence: n,
        effectiveFrom: since,
        ...base,
      });
      const customer = await ctx.db.insert("customers", {
        code: `C${n}`,
        name: `Customer ${n}`,
        channel: "GT",
        territory: place.code,
        creditLimit: 0,
        active: true,
        updatedAt: since,
      });
      return { id, assignment, customer, place, n };
    };
    const o1 = await outlet(1, ta);
    const o2 = await outlet(2, ta);
    const o3 = await outlet(3, tb);

    const plan = await ctx.db.insert("coveragePlans", {
      organizationId: "sunpride",
      assigneeProfileId: ana.id,
      localMonth: "2026-09",
      version: 1,
      cycleType: "monthly",
      orgUnitId: regionA,
      territoryIds: [ta.id, tb.id],
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
      o: Awaited<ReturnType<typeof outlet>>,
      status: "planned" | "cancelled" = "planned",
    ) => {
      const approvedSnapshot = {
        outletId: o.id,
        outletCode: `O${o.n}`,
        outletName: `Outlet ${o.n}`,
        customerId: o.customer,
        territoryId: o.place.id,
        territoryCode: o.place.code,
        sequence: o.n,
        outletAssignmentId: o.assignment,
        territoryOwnershipId: o.place.ownership,
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
        outletId: o.id,
        activityKind: "sell",
        requiredObjectives: [],
        intents: ["sell"],
        sequence: o.n,
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
        outletId: o.id,
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
      o: Awaited<ReturnType<typeof outlet>>,
      plannedVisitId?: Id<"plannedVisits">,
      state: "checked-out" | "in-progress" = "checked-out",
    ) => {
      const checkedInAt = Date.parse(`${serviceDate}T09:00:00+08:00`);
      return ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: `client-${++n}`,
        assigneeProfileId: ana.id,
        outletId: o.id,
        orgUnitId: regionA,
        serviceDate,
        source: plannedVisitId ? "planned" : "unplanned",
        intents: ["sell"],
        state,
        productivity: "pending",
        createdAt: checkedInAt,
        lastServerTime: checkedInAt,
        checkedInAt,
        ...(state === "checked-out"
          ? { checkedOutAt: checkedInAt + HOUR }
          : {}),
        ...(plannedVisitId ? { plannedVisitId, planId: plan } : {}),
      });
    };

    // Every Monday O1, O2 (T-A) and O3 (T-B) are planned. O1 is always visited, O2
    // never, O3 in weeks 1 and 3. Week 4 is the open week: O3 moves to today (pending).
    for (const [week, monday] of MONDAYS.entries()) {
      await visit(monday, o1, await stop(monday, o1));
      const s2 = await stop(monday, o2);
      if (week === 1) await visit(monday, o2, s2, "in-progress"); // never closed
      if (week === 3) {
        await stop(END, o3);
        continue;
      }
      const s3 = await stop(monday, o3);
      if (week !== 1) await visit(monday, o3, s3);
    }
    // A cancelled stop and an off-plan visit never count as compliance.
    await stop("2026-09-15", o2, "cancelled");
    await visit("2026-09-15", o3);
    return { ana: ana.id, ta: ta.id, tb: tb.id };
  });
  const as = (name: string) =>
    t.withIdentity({
      subject: name,
      issuer: ISSUER,
      tokenIdentifier: subject(name),
    });
  return { t, ids, as };
}

describe("compliance.person", () => {
  it("compares the MCP with closed visits by week, territory and store", async () => {
    const { ids, as } = await fixture();
    const result = await as("managerA").query(api.analytics.compliance.person, {
      profileId: ids.ana,
      endDate: END,
      weeks: 4,
    });
    expect(result.windows.map((w) => [w.weekStart, w.closed])).toEqual([
      [MONDAYS[0], true],
      [MONDAYS[1], true],
      [MONDAYS[2], true],
      [MONDAYS[3], false],
    ]);
    expect(result.weeks).toEqual([
      wk({ planned: 3, done: 2, missed: 1 }),
      wk({ planned: 3, done: 1, missed: 2 }),
      wk({ planned: 3, done: 2, missed: 1 }),
      wk({ planned: 3, done: 1, missed: 1, pending: 1 }),
    ]);
    expect(result.offPlanVisits).toEqual([0, 1, 0, 0]);
    expect(coverageVerdict(result.weeks, result.windows)).toMatchObject({
      streak: 3,
      persistent: true,
    });

    const [ta, tb] = result.territories;
    expect(ta).toMatchObject({ code: "T-A", name: "Territory T-A" });
    expect(coverageVerdict(ta!.weeks, result.windows).persistent).toBe(true);
    expect(tb!.code).toBe("T-B");
    expect(tb!.weeks.map(weekCompliancePct)).toEqual([100, 0, 100, null]);
    expect(coverageVerdict(tb!.weeks, result.windows).persistent).toBe(false);

    expect(result.outlets.map((o) => [o.code, o.customerCode])).toEqual([
      ["O1", "C1"],
      ["O2", "C2"],
      ["O3", "C3"],
    ]);
    const o2 = result.outlets[1]!;
    expect(o2.customerName).toBe("Customer 2");
    expect(coverageVerdict(o2.weeks, result.windows)).toMatchObject({
      compliancePct: 0,
      persistent: true,
    });
    expect(
      coverageVerdict(result.outlets[0]!.weeks, result.windows).underWeeks,
    ).toBe(0);
    expect(result.outletsTruncated).toBe(false);
    expect(result.sourceRef).toContain("provisional");
  });

  it("lets cross-scope readers in and keeps others out", async () => {
    const { ids, as } = await fixture();
    const args = { profileId: ids.ana, endDate: END, weeks: 4 };
    const analyst = await as("analyst").query(
      api.analytics.compliance.person,
      args,
    );
    expect(analyst.weeks).toHaveLength(4);
    await expect(
      as("managerB").query(api.analytics.compliance.person, args),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      as("Ana").query(api.analytics.compliance.person, args),
    ).rejects.toThrow();
    await expect(
      as("managerA").query(api.analytics.compliance.person, {
        ...args,
        weeks: 12,
      }),
    ).rejects.toThrow(/between/);
  });
});
