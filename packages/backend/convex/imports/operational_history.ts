import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { readableLocationIds } from "../inventory/location_scope";
import { requireCapability } from "../lib/capabilities";

async function requireOperationalReader(ctx: QueryCtx) {
  try {
    await requireCapability(ctx, "inventory.adjustment.request");
  } catch {
    await requireCapability(ctx, "inventory.count.submit");
  }
}

const typeValidator = v.union(
  v.literal("stock_adjustment"),
  v.literal("cycle_count"),
);
async function visible(
  ctx: QueryCtx,
  run: Doc<"importRuns">,
  canRead: Awaited<ReturnType<typeof readableLocationIds>>,
) {
  if (run.importType !== "stock_adjustment" && run.importType !== "cycle_count")
    return false;
  try {
    await requireCapability(
      ctx,
      run.importType === "stock_adjustment"
        ? "inventory.adjustment.request"
        : "inventory.count.submit",
    );
  } catch {
    return false;
  }
  return (
    !!run.locationIds?.length &&
    (await Promise.all(run.locationIds.map((id) => canRead(id)))).every(Boolean)
  );
}
async function state(ctx: QueryCtx, run: Doc<"importRuns">) {
  const adjustment = run.adjustmentId
    ? await ctx.db.get(run.adjustmentId)
    : null;
  const session = run.sessionId ? await ctx.db.get(run.sessionId) : null;
  return {
    ...run,
    status: adjustment?.status ?? session?.status ?? run.status,
    movementId: adjustment?.movementId,
    linkedAdjustmentId: session?.adjustmentId ?? run.adjustmentId,
  };
}
/** Separate from legacy national list so existing two-type Web consumers retain their API. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireOperationalReader(ctx);
    const canRead = await readableLocationIds(ctx);
    const rows = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_createdAt", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .order("desc")
      .take(200);
    const output = [];
    for (const run of rows) {
      if (await visible(ctx, run, canRead)) output.push(await state(ctx, run));
      if (output.length >= Math.max(0, Math.min(args.limit ?? 100, 200))) break;
    }
    return output;
  },
});
export const detail = query({
  args: { runKey: v.string(), importType: typeValidator },
  returns: v.object({ runs: v.array(v.any()), errors: v.array(v.any()) }),
  handler: async (ctx, args) => {
    await requireOperationalReader(ctx);
    const canRead = await readableLocationIds(ctx);
    const rows = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_runKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("runKey", args.runKey),
      )
      .take(200);
    const runs = [],
      errors = [];
    for (const run of rows) {
      if (
        run.importType !== args.importType ||
        !(await visible(ctx, run, canRead))
      )
        continue;
      runs.push(await state(ctx, run));
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
    }
    return { runs, errors };
  },
});
