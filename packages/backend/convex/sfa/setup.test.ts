import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import {
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

  it("carries the §I daily call standards with their source", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sfa.setup.foundation, {});

    const kas = await standardFor(t, "KAS");
    expect(kas?.dailyCallsTarget).toBe(5);
    expect(kas?.productiveCallTargetPct).toBe(90);
    expect(kas?.sourceRef).toBe(MEMO_STANDARDS_SOURCE);

    // Route Sales, PMOT Extruck and the pre-booking stalls share the 30/85 row.
    for (const code of ["RS", "PMOT_EXTRUCK", "PM_STALLS"]) {
      const standard = await standardFor(t, code);
      expect(standard?.dailyCallsTarget).toBe(30);
      expect(standard?.productiveCallTargetPct).toBe(85);
    }
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
  });

  it("does not attach a standard to a position the memo left unmeasured", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.sfa.setup.foundation, {});

    // Sales Head, SCDM, CDMs and the RDS/DSP/ADP titles have no §I or §III numbers.
    for (const code of ["SALES_HEAD", "SCDM", "CDM_KA", "RDS"]) {
      expect(await standardFor(t, code)).toBeNull();
    }
  });
});
