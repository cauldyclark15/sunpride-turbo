import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { POSITION_SEED, POSITION_STANDARD_SEED } from "./constants";

/**
 * Seeds Sunpride's positions and the standards the 2026-01-20 memo attaches to them.
 *
 * Idempotent: positions are matched by code and refreshed, standards are matched by
 * `positionId + sourceRef` so re-running never duplicates a standard and never overwrites a
 * value the client has since corrected by hand.
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
        .unique();
      if (existing) continue;
      await ctx.db.insert("positionStandards", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        positionId,
        effectiveFrom: now,
        sourceRef: standard.sourceRef,
        ...(standard.dailyCallsTarget === undefined
          ? {}
          : { dailyCallsTarget: standard.dailyCallsTarget }),
        ...(standard.productiveCallTargetPct === undefined
          ? {}
          : { productiveCallTargetPct: standard.productiveCallTargetPct }),
        ...(standard.workWithWeeklyMin === undefined
          ? {}
          : { workWithWeeklyMin: standard.workWithWeeklyMin }),
        ...(standard.workWithMonthlyMin === undefined
          ? {}
          : { workWithMonthlyMin: standard.workWithMonthlyMin }),
        createdAt: now,
        updatedAt: now,
      });
      standardsCreated += 1;
    }

    const positions = await ctx.db.query("positions").collect();
    const standards = await ctx.db.query("positionStandards").collect();
    return {
      positionCount: positions.length,
      positionsCreated,
      standardCount: standards.length,
      standardsCreated,
    };
  },
});
