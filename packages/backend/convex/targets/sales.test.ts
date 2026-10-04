import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  isManilaMidnight,
  isManilaMonthStart,
  manilaPeriodStart,
} from "./model";
import { subjectTargetAt } from "./sales";

type Test = TestConvex<typeof schema>;

// 2026-10-15 10:00 in Manila.
const NOW = Date.parse("2026-10-15T10:00:00+08:00");
const manila = (local: string) => Date.parse(`${local}T00:00:00+08:00`);
const OCT_1 = manila("2026-10-01");
const OCT_16 = manila("2026-10-16");
const OCT_17 = manila("2026-10-17");
const NOV_1 = manila("2026-11-01");
const DEC_1 = manila("2026-12-01");
const JAN_1 = manila("2027-01-01");

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t: Test = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  const rootId = await root.mutation(api.domains.profiles.ensure, {});
  const unit = (code: string) =>
    t.run((ctx) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "AREA",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
  const areaA = await unit("A");
  const areaB = await unit("B");

  async function person(
    name: string,
    role: "sales" | "manager" | "viewer" | "admin" | "analyst",
    orgUnitId: Id<"orgUnits">,
  ) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    const profileId = await actor.mutation(api.domains.profiles.ensure, {});
    await t.run(async (ctx) => {
      await ctx.db.patch(profileId, { orgUnitId });
      for (const row of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profileId),
        )
        .collect())
        await ctx.db.delete(row._id);
      await ctx.db.insert("employeeAssignments", {
        profileId,
        orgUnitId,
        role,
        effectiveFrom: 0,
        actorSubject: "test",
        reason: "fixture",
        createdAt: 1,
      });
    });
    return { actor, profileId };
  }

  const managerA = await person("manager-a", "manager", areaA);
  const salesA = await person("sales-a", "sales", areaA);
  const salesA2 = await person("sales-a2", "sales", areaA);
  const salesB = await person("sales-b", "sales", areaB);
  const viewerA = await person("viewer-a", "viewer", areaA);

  const team = (code: string, orgUnitId: Id<"orgUnits">) =>
    t.run((ctx) =>
      ctx.db.insert("teams", {
        code,
        name: code,
        orgUnitId,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
        createdBy: "test",
      }),
    );
  const territory = (code: string, orgUnitId: Id<"orgUnits">) =>
    t.run(async (ctx) => {
      const territoryId = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code,
        name: code,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
        createdBy: "test",
      });
      await ctx.db.insert("territoryOwnerships", {
        territoryId,
        orgUnitId,
        effectiveFrom: 0,
        actorSubject: "test",
        reason: "fixture",
        createdAt: 1,
      });
      return territoryId;
    });

  return {
    t,
    root,
    rootId,
    areaA,
    areaB,
    managerA,
    salesA,
    salesA2,
    salesB,
    viewerA,
    teamA: await team("TEAM-A", areaA),
    teamB: await team("TEAM-B", areaB),
    territoryA: await territory("TERR-A", areaA),
    territoryB: await territory("TERR-B", areaB),
  };
}

const employee = (profileId: Id<"profiles">) =>
  ({ kind: "employee", profileId }) as const;

const monthlySales = (
  profileId: Id<"profiles">,
  effectiveFrom: number,
  value = 50_000_000,
) => ({
  subject: employee(profileId),
  period: "monthly" as const,
  metric: "sales_value" as const,
  value,
  effectiveFrom,
  sourceRef: "Q4 sales plan memo 2026-10-01",
  reason: "Q4 plan",
});

describe("period boundaries", () => {
  it("recognises Manila midnights and month starts", () => {
    expect(isManilaMidnight(OCT_16)).toBe(true);
    expect(isManilaMidnight(NOW)).toBe(false);
    expect(isManilaMidnight(Date.parse("2026-10-16T00:00:00Z"))).toBe(false);
    expect(isManilaMonthStart(NOV_1)).toBe(true);
    expect(isManilaMonthStart(OCT_16)).toBe(false);
    expect(manilaPeriodStart("daily", NOW)).toBe(manila("2026-10-15"));
    expect(manilaPeriodStart("monthly", NOW)).toBe(OCT_1);
    // 23:30 on 31 Oct in Manila is still October although UTC says 31 Oct 15:30.
    expect(
      manilaPeriodStart("monthly", Date.parse("2026-10-31T23:30:00+08:00")),
    ).toBe(OCT_1);
  });
});

describe("sales targets", () => {
  it("sets an employee monthly target with its source and reads it as of a date", async () => {
    const f = await setup();
    const id = await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, NOV_1),
    );
    const now = await f.managerA.actor.query(api.targets.sales.list, {
      subject: employee(f.salesA.profileId),
    });
    expect(now.rows).toHaveLength(1);
    expect(now.rows[0]).toMatchObject({
      _id: id,
      subjectKind: "employee",
      profileId: f.salesA.profileId,
      period: "monthly",
      metric: "sales_value",
      value: 50_000_000,
      effectiveFrom: NOV_1,
      sourceRef: "Q4 sales plan memo 2026-10-01",
    });
    expect(now.inEffect).toEqual([]);
    const november = await f.managerA.actor.query(api.targets.sales.list, {
      subject: employee(f.salesA.profileId),
      asOf: NOV_1 + 5 * 86_400_000,
    });
    expect(november.inEffect.map((row) => row._id)).toEqual([id]);

    const audits = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "salesTarget").eq("entityId", id),
        )
        .collect(),
    );
    expect(audits.map((row) => row.action)).toEqual(["salesTarget.set"]);
  });

  it("keeps history: a revision closes the prior target at the new start", async () => {
    const f = await setup();
    const first = await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, NOV_1),
    );
    const second = await f.managerA.actor.mutation(api.targets.sales.set, {
      ...monthlySales(f.salesA.profileId, DEC_1, 60_000_000),
      sourceRef: "Revised plan 2026-10-14",
    });
    const rows = await f.t.run((ctx) => ctx.db.query("salesTargets").collect());
    expect(rows.find((row) => row._id === first)).toMatchObject({
      effectiveFrom: NOV_1,
      effectiveTo: DEC_1,
    });
    expect(rows.find((row) => row._id === second)?.effectiveTo).toBeUndefined();

    const at = (instant: number) =>
      f.t.run((ctx) =>
        subjectTargetAt(
          ctx,
          employee(f.salesA.profileId),
          "monthly",
          "sales_value",
          instant,
        ),
      );
    expect((await at(NOV_1))?.value).toBe(50_000_000);
    expect((await at(DEC_1 - 1))?.value).toBe(50_000_000);
    expect((await at(DEC_1))?.value).toBe(60_000_000);
    expect(await at(OCT_16)).toBeNull();
    // A different metric or period is a separate key.
    const daily = await f.t.run((ctx) =>
      subjectTargetAt(
        ctx,
        employee(f.salesA.profileId),
        "daily",
        "sales_value",
        DEC_1,
      ),
    );
    expect(daily).toBeNull();
  });

  it("supports daily call targets for teams and territories in scope", async () => {
    const f = await setup();
    const teamTarget = await f.managerA.actor.mutation(api.targets.sales.set, {
      subject: { kind: "team", teamId: f.teamA },
      period: "daily",
      metric: "calls",
      value: 30,
      effectiveFrom: OCT_16,
      sourceRef: "Memo 2026-01-20 §2",
      reason: "Route team standard",
    });
    const territoryTarget = await f.managerA.actor.mutation(
      api.targets.sales.set,
      {
        subject: { kind: "territory", territoryId: f.territoryA },
        period: "daily",
        metric: "productive_calls",
        value: 26,
        effectiveFrom: OCT_16,
        effectiveTo: NOV_1,
        sourceRef: "Memo 2026-01-20 §2",
        reason: "Territory standard",
      },
    );
    const team = await f.viewerA.actor.query(api.targets.sales.list, {
      subject: { kind: "team", teamId: f.teamA },
      asOf: OCT_17,
    });
    expect(team.inEffect.map((row) => row._id)).toEqual([teamTarget]);
    const territory = await f.viewerA.actor.query(api.targets.sales.list, {
      subject: { kind: "territory", territoryId: f.territoryA },
      asOf: NOV_1,
    });
    expect(territory.rows.map((row) => row._id)).toEqual([territoryTarget]);
    expect(territory.inEffect).toEqual([]);

    await expect(
      f.managerA.actor.mutation(api.targets.sales.set, {
        subject: { kind: "team", teamId: f.teamB },
        period: "daily",
        metric: "calls",
        value: 30,
        effectiveFrom: OCT_16,
        sourceRef: "Memo",
        reason: "x",
      }),
    ).rejects.toThrow("outside your organizational scope");
    await expect(
      f.managerA.actor.mutation(api.targets.sales.set, {
        subject: { kind: "territory", territoryId: f.territoryB },
        period: "daily",
        metric: "calls",
        value: 30,
        effectiveFrom: OCT_16,
        sourceRef: "Memo",
        reason: "x",
      }),
    ).rejects.toThrow("outside your organizational scope");
  });

  it("rejects targets that do not align with their period", async () => {
    const f = await setup();
    await expect(
      f.managerA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.salesA.profileId, OCT_16),
      ),
    ).rejects.toThrow("first day of a Manila month");
    await expect(
      f.managerA.actor.mutation(api.targets.sales.set, {
        ...monthlySales(f.salesA.profileId, NOV_1),
        period: "daily",
        effectiveFrom: Date.parse("2026-10-16T00:00:00Z"),
      }),
    ).rejects.toThrow("Manila midnight");
    await expect(
      f.managerA.actor.mutation(api.targets.sales.set, {
        ...monthlySales(f.salesA.profileId, NOV_1),
        effectiveTo: NOV_1,
      }),
    ).rejects.toThrow("End must be after start");
  });

  it("validates value, source reference and subject", async () => {
    const f = await setup();
    for (const value of [-1, 1.5, Number.NaN, 1e14])
      await expect(
        f.managerA.actor.mutation(
          api.targets.sales.set,
          monthlySales(f.salesA.profileId, NOV_1, value),
        ),
      ).rejects.toThrow("whole, non-negative");
    await expect(
      f.managerA.actor.mutation(api.targets.sales.set, {
        ...monthlySales(f.salesA.profileId, NOV_1),
        sourceRef: "   ",
      }),
    ).rejects.toThrow("Source reference required");
    await f.t.run((ctx) =>
      ctx.db.patch(f.salesA2.profileId, { status: "disabled" }),
    );
    await expect(
      f.managerA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.salesA2.profileId, NOV_1),
      ),
    ).rejects.toThrow("not active");
  });

  it("enforces role, scope and no self-targeting", async () => {
    const f = await setup();
    await expect(
      f.managerA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.salesB.profileId, NOV_1),
      ),
    ).rejects.toThrow("outside your organizational scope");
    await expect(
      f.salesA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.salesA2.profileId, NOV_1),
      ),
    ).rejects.toThrow("Insufficient permission");
    await expect(
      f.viewerA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.salesA.profileId, NOV_1),
      ),
    ).rejects.toThrow("Insufficient permission");
    await expect(
      f.managerA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.managerA.profileId, NOV_1),
      ),
    ).rejects.toThrow("your own target");
    // National super admin reaches every area.
    await f.root.mutation(
      api.targets.sales.set,
      monthlySales(f.salesB.profileId, NOV_1),
    );
  });

  it("limits sales to reading their own targets", async () => {
    const f = await setup();
    await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, NOV_1),
    );
    const own = await f.salesA.actor.query(api.targets.sales.list, {
      subject: employee(f.salesA.profileId),
    });
    expect(own.rows).toHaveLength(1);
    await expect(
      f.salesA2.actor.query(api.targets.sales.list, {
        subject: employee(f.salesA.profileId),
      }),
    ).rejects.toThrow("own targets");
    await expect(
      f.salesA.actor.query(api.targets.sales.list, {
        subject: { kind: "team", teamId: f.teamA },
      }),
    ).rejects.toThrow("own targets");
    await expect(
      f.viewerA.actor.query(api.targets.sales.list, {
        subject: employee(f.salesB.profileId),
      }),
    ).rejects.toThrow("outside your organizational scope");
  });

  it("is future-effective, except a key's first target may start this period", async () => {
    const f = await setup();
    await expect(
      f.managerA.actor.mutation(api.targets.sales.set, {
        ...monthlySales(f.salesA.profileId, OCT_1),
        effectiveFrom: manila("2026-09-01"),
      }),
    ).rejects.toThrow("future-effective");
    const first = await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, OCT_1),
    );
    expect(
      (
        await f.managerA.actor.query(api.targets.sales.list, {
          subject: employee(f.salesA.profileId),
        })
      ).inEffect.map((row) => row._id),
    ).toEqual([first]);
    // Once a target exists, the current period cannot be rewritten.
    await expect(
      f.managerA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.salesA.profileId, OCT_1, 1),
      ),
    ).rejects.toThrow("future-effective");
  });

  it("refuses to overlap a target that is already scheduled", async () => {
    const f = await setup();
    await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, DEC_1),
    );
    await expect(
      f.managerA.actor.mutation(
        api.targets.sales.set,
        monthlySales(f.salesA.profileId, NOV_1),
      ),
    ).rejects.toThrow("already scheduled");
    // A bounded target that ends before the scheduled one is fine.
    await f.managerA.actor.mutation(api.targets.sales.set, {
      ...monthlySales(f.salesA.profileId, NOV_1),
      effectiveTo: DEC_1,
    });
    const rows = await f.t.run((ctx) => ctx.db.query("salesTargets").collect());
    expect(
      rows
        .map((row) => [row.effectiveFrom, row.effectiveTo])
        .sort((a, b) => a[0]! - b[0]!),
    ).toEqual([
      [NOV_1, DEC_1],
      [DEC_1, undefined],
    ]);
  });

  it("ends and cancels targets prospectively with an audit trail", async () => {
    const f = await setup();
    const running = await f.managerA.actor.mutation(api.targets.sales.set, {
      subject: employee(f.salesA.profileId),
      period: "daily",
      metric: "calls",
      value: 30,
      effectiveFrom: OCT_16,
      sourceRef: "Memo 2026-01-20 §2",
      reason: "Standard",
    });
    await expect(
      f.managerA.actor.mutation(api.targets.sales.end, {
        targetId: running,
        effectiveTo: manila("2026-10-15"),
        reason: "Too late",
      }),
    ).rejects.toThrow("future-effective");
    await expect(
      f.managerA.actor.mutation(api.targets.sales.end, {
        targetId: running,
        effectiveTo: OCT_17 + 3_600_000,
        reason: "Not a midnight",
      }),
    ).rejects.toThrow("Manila midnight");
    await f.managerA.actor.mutation(api.targets.sales.end, {
      targetId: running,
      effectiveTo: NOV_1,
      reason: "Route closes",
    });
    await expect(
      f.managerA.actor.mutation(api.targets.sales.end, {
        targetId: running,
        effectiveTo: JAN_1,
        reason: "Extend",
      }),
    ).rejects.toThrow("earlier than the current end");

    const scheduled = await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, DEC_1),
    );
    await f.managerA.actor.mutation(api.targets.sales.end, {
      targetId: scheduled,
      effectiveTo: DEC_1,
      reason: "Plan withdrawn",
    });
    // The cancelled row no longer blocks a new target for the same months.
    await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, NOV_1),
    );
    const at = await f.t.run((ctx) =>
      subjectTargetAt(
        ctx,
        employee(f.salesA.profileId),
        "monthly",
        "sales_value",
        DEC_1,
      ),
    );
    expect(at?.effectiveFrom).toBe(NOV_1);

    const actions = await f.t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect())
        .filter((row) => row.entityType === "salesTarget")
        .map((row) => row.action),
    );
    expect(actions).toEqual([
      "salesTarget.set",
      "salesTarget.ended",
      "salesTarget.set",
      "salesTarget.cancelled",
      "salesTarget.set",
    ]);

    await expect(
      f.salesA2.actor.mutation(api.targets.sales.end, {
        targetId: scheduled,
        effectiveTo: DEC_1,
        reason: "x",
      }),
    ).rejects.toThrow("Insufficient permission");
  });

  it("declares every index usable", async () => {
    const f = await setup();
    await f.managerA.actor.mutation(
      api.targets.sales.set,
      monthlySales(f.salesA.profileId, NOV_1),
    );
    const byOrg = await f.t.run((ctx) =>
      ctx.db
        .query("salesTargets")
        .withIndex("by_organizationId_and_effectiveFrom", (q) =>
          q.eq("organizationId", "sunpride").gte("effectiveFrom", NOV_1),
        )
        .collect(),
    );
    expect(byOrg).toHaveLength(1);
  });
});
