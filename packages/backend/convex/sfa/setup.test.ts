import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import {
  CALL_STANDARDS_SOURCE,
  MEMO_STANDARDS_SOURCE,
  MEMO_WORK_WITH_SOURCE,
  POSITION_SEED,
  POSITION_STANDARD_SEED,
} from "./constants";
import schema from "../schema";
import { modules } from "../test.setup";

type Test = TestConvex<typeof schema>;

async function positionByCode(t: Test, code: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("positions")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", "sunpride").eq("code", code),
      )
      .unique(),
  );
}

async function standardFor(t: Test, code: string) {
  const position = await positionByCode(t, code);
  if (!position) throw new Error(`position ${code} not seeded`);
  return t.run(async (ctx) =>
    ctx.db
      .query("positionStandards")
      .withIndex("by_positionId_and_effectiveFrom", (q) =>
        q.eq("positionId", position._id),
      )
      .order("desc")
      .first(),
  );
}

describe("sfa setup foundation", () => {
  it("seeds the memo's positions and standards, and is idempotent", async () => {
    const t = convexTest(schema, modules);

    const first = await t.mutation(internal.sfa.setup.foundation, {});
    expect(first.positionsCreated).toBe(POSITION_SEED.length);
    expect(first.standardsCreated).toBe(POSITION_STANDARD_SEED.length);
    expect(first.positionCount).toBe(POSITION_SEED.length);
    expect(first.standardCount).toBe(POSITION_STANDARD_SEED.length);

    const second = await t.mutation(internal.sfa.setup.foundation, {});
    expect(second.positionsCreated).toBe(0);
    expect(second.standardsCreated).toBe(0);
    expect(second.positionCount).toBe(first.positionCount);
    expect(second.standardCount).toBe(first.standardCount);
  });

  it("carries the confirmed daily call standards with their source", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sfa.setup.foundation, {});

    // KAS and Booking: 5 a day; productive % stays at the memo's 90 until confirmed.
    for (const code of ["KAS", "BOOKING"]) {
      const standard = await standardFor(t, code);
      expect(standard?.dailyCallsTarget).toBe(5);
      expect(standard?.productiveCallTargetPct).toBe(90);
      expect(standard?.sourceRef).toBe(CALL_STANDARDS_SOURCE);
      expect(standard?.notes).toContain("TO CONFIRM");
      expect(standard?.productiveCallRule).toBe("any_listed_activity");
    }

    // PMOT, PMOT Extruck, RDS, pre-booking and Route Sales: 30 a day at 85%.
    for (const code of ["RS", "PM_STALLS", "PMOT", "PMOT_EXTRUCK", "RDS"]) {
      const standard = await standardFor(t, code);
      expect(standard?.dailyCallsTarget).toBe(30);
      expect(standard?.productiveCallTargetPct).toBe(85);
      expect(standard?.sourceRef).toBe(CALL_STANDARDS_SOURCE);
      // Six-day selling week, Monday (1) to Saturday (6).
      expect(standard?.sellingWeekdays).toEqual([1, 2, 3, 4, 5, 6]);
    }
    for (const code of ["PMOT", "PMOT_EXTRUCK", "RDS"])
      expect((await standardFor(t, code))?.productiveCallRule).toBe(
        "truck_seller",
      );
    for (const code of ["RS", "PM_STALLS"])
      expect((await standardFor(t, code))?.productiveCallRule).toBe(
        "any_listed_activity",
      );
  });

  it("supersedes a deployment's memo rows without overlap and keeps history", async () => {
    const t = convexTest(schema, modules);
    // A deployment seeded before the call: KAS carries the memo row only.
    const kasId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "KAS",
        label: "Key Account Specialist (KAS)",
        category: "field",
        active: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("positionStandards", {
        organizationId: "sunpride",
        positionId: id,
        effectiveFrom: 1,
        dailyCallsTarget: 5,
        productiveCallTargetPct: 90,
        sourceRef: MEMO_STANDARDS_SOURCE,
        createdAt: 1,
        updatedAt: 1,
      });
      return id;
    });

    const result = await t.mutation(internal.sfa.setup.foundation, {});
    expect(result.standardsSuperseded).toBe(1);
    expect(result.standardsSkipped).toBe(0);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("positionStandards")
        .withIndex("by_positionId_and_effectiveFrom", (q) =>
          q.eq("positionId", kasId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(2);
    const [memo, call] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(memo.sourceRef).toBe(MEMO_STANDARDS_SOURCE);
    expect(call.sourceRef).toBe(CALL_STANDARDS_SOURCE);
    // The memo row ends exactly where the new row starts: one row in effect at any instant.
    expect(memo.effectiveTo).toBe(call.effectiveFrom);
    expect(call.effectiveTo).toBeUndefined();

    const again = await t.mutation(internal.sfa.setup.foundation, {});
    expect(again.standardsCreated).toBe(0);
    expect(again.standardsSuperseded).toBe(0);
  });

  it("never replaces a standard entered by hand", async () => {
    const t = convexTest(schema, modules);
    const rdsId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "RDS",
        label: "RDS",
        category: "field",
        active: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("positionStandards", {
        organizationId: "sunpride",
        positionId: id,
        effectiveFrom: 1,
        dailyCallsTarget: 28,
        sourceRef: "HR correction 2026-09-01",
        createdAt: 1,
        updatedAt: 1,
      });
      return id;
    });
    const result = await t.mutation(internal.sfa.setup.foundation, {});
    expect(result.standardsSkipped).toBe(1);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("positionStandards")
        .withIndex("by_positionId_and_effectiveFrom", (q) =>
          q.eq("positionId", rdsId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dailyCallsTarget).toBe(28);
    expect(rows[0]?.effectiveTo).toBeUndefined();
  });

  it("carries the §III work-with minimums", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sfa.setup.foundation, {});

    const ds = await standardFor(t, "DS");
    expect(ds?.workWithWeeklyMin).toBe(4);
    expect(ds?.workWithMonthlyMin).toBe(16);
    expect(ds?.sourceRef).toBe(MEMO_WORK_WITH_SOURCE);

    const srCds = await standardFor(t, "SR_CDS");
    expect(srCds?.workWithWeeklyMin).toBe(1);
    expect(srCds?.workWithMonthlyMin).toBe(4);
  });

  it("keeps the memo's wording for position labels", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sfa.setup.foundation, {});

    const kas = await positionByCode(t, "KAS");
    expect(kas?.label).toBe("Key Account Specialist (KAS)");
    expect(kas?.category).toBe("field");
    expect(kas?.active).toBe(true);

    const ds = await positionByCode(t, "DS");
    expect(ds?.label).toBe("Distributor Specialist");
    expect((await positionByCode(t, "PMOT"))?.label).toBe(
      "PMOT (Public Market and Open Trade)",
    );
  });

  it("does not attach a standard to a position the client left unmeasured", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sfa.setup.foundation, {});

    // Sales Head, SCDM, CDMs and the DSP/ADP titles have no call or Work With numbers.
    for (const code of ["SALES_HEAD", "SCDM", "CDM_KA", "DSP"]) {
      expect(await standardFor(t, code)).toBeNull();
    }
  });
});
