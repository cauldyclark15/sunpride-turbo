import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireNationalScope } from "../lib/scope";

const importTypeValidator = v.union(
  v.literal("products"),
  v.literal("opening_stock"),
);

type ImportType = "products" | "opening_stock";

type RunGroup = {
  runKey: string;
  importType: ImportType;
  status: string;
  chunkCount: number;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  movementIds: Id<"inventoryMovements">[];
  actorSubject: string;
  createdAt: number;
  completedAt: number | null;
};

/**
 * Import history grouped by run: one row per uploaded file, with its chunk counts and any
 * movement it produced. Bounded to the most recent runs (tracker SFD-017, QSR-011).
 */
export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      runKey: v.string(),
      importType: importTypeValidator,
      status: v.string(),
      chunkCount: v.number(),
      rowCount: v.number(),
      createdCount: v.number(),
      updatedCount: v.number(),
      skippedCount: v.number(),
      failedCount: v.number(),
      movementIds: v.array(v.id("inventoryMovements")),
      actorSubject: v.string(),
      createdAt: v.number(),
      completedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireNationalScope(ctx, ["admin", "analyst"]);
    const runs = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_createdAt", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .order("desc")
      .take(Math.min(args.limit ?? 100, 200));

    const groups = new Map<string, RunGroup>();

    for (const run of runs) {
      const key = `${run.importType}:${run.runKey}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          runKey: run.runKey,
          importType: run.importType,
          status: run.status,
          chunkCount: 1,
          rowCount: run.rowCount,
          createdCount: run.createdCount,
          updatedCount: run.updatedCount,
          skippedCount: run.skippedCount,
          failedCount: run.failedCount,
          movementIds: run.movementId ? [run.movementId] : [],
          actorSubject: run.actorSubject,
          createdAt: run.createdAt,
          completedAt: run.completedAt ?? null,
        });
        continue;
      }
      existing.chunkCount += 1;
      existing.rowCount += run.rowCount;
      existing.createdCount += run.createdCount;
      existing.updatedCount += run.updatedCount;
      existing.skippedCount += run.skippedCount;
      existing.failedCount += run.failedCount;
      existing.createdAt = Math.min(existing.createdAt, run.createdAt);
      if (run.movementId && !existing.movementIds.includes(run.movementId))
        existing.movementIds.push(run.movementId);
      if (run.status === "failed") existing.status = "failed";
      const completed = run.completedAt ?? null;
      if (completed !== null)
        existing.completedAt = Math.max(existing.completedAt ?? 0, completed);
    }

    return [...groups.values()].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
  },
});

/** One run in full: every chunk, every recorded row error, and the movement it produced. */
export const detail = query({
  args: { runKey: v.string(), importType: importTypeValidator },
  returns: v.object({
    runs: v.array(v.any()),
    errors: v.array(v.any()),
    movements: v.array(v.any()),
  }),
  handler: async (ctx, args) => {
    await requireNationalScope(ctx, ["admin", "analyst"]);
    const runs = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_runKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("runKey", args.runKey),
      )
      .take(200);
    const filtered = runs
      .filter((run) => run.importType === args.importType)
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    const errors = [];
    const movements = [];
    for (const run of filtered) {
      errors.push(
        ...(await ctx.db
          .query("importRunErrors")
          .withIndex("by_organizationId_and_runId_and_rowNumber", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("runId", run._id),
          )
          .take(500)),
      );
      if (run.movementId) {
        const movement = await ctx.db.get(run.movementId);
        if (movement) movements.push(movement);
      }
    }
    return { runs: filtered, errors, movements };
  },
});

export type { RunGroup };
