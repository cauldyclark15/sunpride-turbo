import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  POSITION_SEED,
  POSITION_STANDARD_SEED,
  SUPERSEDABLE_SEED_SOURCES,
} from "./constants";

/**
 * Seeds Sunpride's positions and the standards the 2026-01-20 memo attaches to them.
 *
 * Idempotent: positions are matched by code and refreshed, standards are matched by
 * `positionId + sourceRef` so re-running never duplicates a standard. A standard from a newer
 * source closes the position's open seeded row (`effectiveTo = now`) and starts a new row at
 * the same instant, so history is kept and exactly one row is in effect. A row entered by hand
 * (any source outside `SUPERSEDABLE_SEED_SOURCES`) is never closed: that seed row is skipped.
 *
 * Run once per deployment:
 *   bunx convex run sfa/setup:foundation
 */
export const foundation = internalMutation({
  args: {},
  returns: v.object({
    positionCount: v.number(),
    positionsCreated: v.number(),
    standardCount: v.number(),
    standardsCreated: v.number(),
    standardsSuperseded: v.number(),
    standardsSkipped: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const positionIds = new Map<string, Id<"positions">>();
    let positionsCreated = 0;

    for (const input of POSITION_SEED) {
      const existing = await ctx.db
        .query("positions")
        .withIndex("by_organizationId_and_code", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("code", input.code),
        )
        .unique();
      if (existing) {
        if (
          existing.label !== input.label ||
          existing.category !== input.category ||
          !existing.active
        )
          await ctx.db.patch(existing._id, {
            label: input.label,
            category: input.category,
            active: true,
            updatedAt: now,
          });
        positionIds.set(input.code, existing._id);
        continue;
      }
      const positionId = await ctx.db.insert("positions", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        code: input.code,
        label: input.label,
        category: input.category,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      positionIds.set(input.code, positionId);
      positionsCreated += 1;
    }

    let standardsCreated = 0;
    let standardsSuperseded = 0;
    let standardsSkipped = 0;
    for (const standard of POSITION_STANDARD_SEED) {
      const positionId = positionIds.get(standard.positionCode);
      if (!positionId)
        throw new Error(
          `Position ${standard.positionCode} is missing from the seed`,
        );
      const existing = await ctx.db
        .query("positionStandards")
        .withIndex("by_positionId_and_sourceRef", (q) =>
          q.eq("positionId", positionId).eq("sourceRef", standard.sourceRef),
        )
        .first();
      if (existing) continue;
      const history = await ctx.db
        .query("positionStandards")
        .withIndex("by_positionId_and_effectiveFrom", (q) =>
          q.eq("positionId", positionId),
        )
        .order("desc")
        .take(50);
      const open = history.filter(
        (row) => row.effectiveTo === undefined || row.effectiveTo > now,
      );
      if (
        open.some((row) => !SUPERSEDABLE_SEED_SOURCES.includes(row.sourceRef))
      ) {
        standardsSkipped += 1;
        continue;
      }
      // Carry forward fields the new source does not restate (e.g. Work With minimums).
      const carried = open[0];
      for (const row of open) {
        await ctx.db.patch(row._id, { effectiveTo: now, updatedAt: now });
        standardsSuperseded += 1;
      }
      const row: WithoutSystemFields<Doc<"positionStandards">> = {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        positionId,
        effectiveFrom: now,
        sourceRef: standard.sourceRef,
        createdAt: now,
        updatedAt: now,
      };
      const dailyCallsTarget =
        standard.dailyCallsTarget ?? carried?.dailyCallsTarget;
      if (dailyCallsTarget !== undefined)
        row.dailyCallsTarget = dailyCallsTarget;
      const productiveCallTargetPct =
        standard.productiveCallTargetPct ?? carried?.productiveCallTargetPct;
      if (productiveCallTargetPct !== undefined)
        row.productiveCallTargetPct = productiveCallTargetPct;
      const workWithWeeklyMin =
        standard.workWithWeeklyMin ?? carried?.workWithWeeklyMin;
      if (workWithWeeklyMin !== undefined)
        row.workWithWeeklyMin = workWithWeeklyMin;
      const workWithMonthlyMin =
        standard.workWithMonthlyMin ?? carried?.workWithMonthlyMin;
      if (workWithMonthlyMin !== undefined)
        row.workWithMonthlyMin = workWithMonthlyMin;
      const productiveCallRule =
        standard.productiveCallRule ?? carried?.productiveCallRule;
      if (productiveCallRule !== undefined)
        row.productiveCallRule = productiveCallRule;
      const sellingWeekdays = standard.sellingWeekdays
        ? [...standard.sellingWeekdays]
        : carried?.sellingWeekdays;
      if (sellingWeekdays !== undefined) row.sellingWeekdays = sellingWeekdays;
      if (standard.notes !== undefined) row.notes = standard.notes;
      await ctx.db.insert("positionStandards", row);
      standardsCreated += 1;
    }

    const positions = await ctx.db.query("positions").collect();
    const standards = await ctx.db.query("positionStandards").collect();
    return {
      positionCount: positions.length,
      positionsCreated,
      standardCount: standards.length,
      standardsCreated,
      standardsSuperseded,
      standardsSkipped,
    };
  },
});
