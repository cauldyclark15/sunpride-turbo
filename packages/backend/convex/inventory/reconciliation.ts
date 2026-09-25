import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import {
  collectScopeUnitIds,
  requireNationalScope,
  rootOrgUnitId,
} from "../lib/scope";
import { readableLocationIds } from "./location_scope";
import { SUNPRIDE_ORGANIZATION_ID } from "./constants";

export const run = mutation({
  args: { sapCutoff: v.number(), scope: v.optional(v.string()) },
  returns: v.id("inventoryReconciliationRuns"),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(ctx, ["admin"]);
    const now = Date.now();
    const runId = await ctx.db.insert("inventoryReconciliationRuns", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      scope: args.scope ?? "all",
      status: "running",
      convexCutoff: now,
      sapCutoff: args.sapCutoff,
      comparedCount: 0,
      differenceCount: 0,
      startedBy: identity.tokenIdentifier,
      startedAt: now,
    });
    const snapshots = await ctx.db
      .query("sapInventorySnapshots")
      .withIndex("by_organizationId_and_resolutionStatus_and_asOf", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .order("desc")
      .take(500);
    const newest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (snapshot.asOf > args.sapCutoff) continue;
      const key = `${snapshot.productCode}:${snapshot.warehouseCode}`;
      if (!newest.has(key)) newest.set(key, snapshot);
    }
    let differenceCount = 0;
    for (const snapshot of newest.values()) {
      const balance =
        snapshot.productId && snapshot.locationId
          ? await ctx.db
              .query("inventoryBalances")
              .withIndex(
                "by_organizationId_and_productId_and_locationId",
                (q) =>
                  q
                    .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                    .eq("productId", snapshot.productId!)
                    .eq("locationId", snapshot.locationId!),
              )
              .unique()
          : null;
      const convexBase = balance?.physicalBase ?? 0n;
      const differenceBase = convexBase - snapshot.onHandBase;
      const matched = differenceBase === 0n;
      await ctx.db.patch(snapshot._id, {
        resolutionStatus: matched
          ? "matched"
          : snapshot.productId && snapshot.locationId
            ? "different"
            : "unmapped",
      });
      if (!matched) {
        differenceCount += 1;
        await ctx.db.insert("inventoryReconciliationDifferences", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          runId,
          ...(snapshot.productId ? { productId: snapshot.productId } : {}),
          ...(snapshot.locationId ? { locationId: snapshot.locationId } : {}),
          productCode: snapshot.productCode,
          warehouseCode: snapshot.warehouseCode,
          convexBase,
          sapBase: snapshot.onHandBase,
          differenceBase,
          classification:
            snapshot.productId && snapshot.locationId
              ? "unresolved"
              : "mapping",
          resolutionStatus: "open",
          createdAt: now,
        });
      }
    }
    await ctx.db.patch(runId, {
      status: "completed",
      comparedCount: newest.size,
      differenceCount,
      completedAt: Date.now(),
    });
    return runId;
  },
});

export const runs = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "inventory.read");
    if (profile.role !== "super_admin") {
      if (!["admin", "analyst"].includes(profile.role) || !profile.orgUnitId)
        return [];
      const root = await rootOrgUnitId(ctx);
      if (!root || profile.orgUnitId !== root) return [];
      // A national reader's own subtree must include the national root.
      if (!(await collectScopeUnitIds(ctx, profile.orgUnitId)).includes(root))
        return [];
    }
    return ctx.db
      .query("inventoryReconciliationRuns")
      .withIndex("by_organizationId_and_status_and_startedAt", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .order("desc")
      .take(Math.min(args.limit ?? 50, 100));
  },
});

export const differences = query({
  args: {
    runId: v.id("inventoryReconciliationRuns"),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "inventory.read");
    const run = await ctx.db.get(args.runId);
    if (!run || run.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("Reconciliation run not found");
    const canRead = await readableLocationIds(ctx);
    const rows = await ctx.db
      .query("inventoryReconciliationDifferences")
      .withIndex("by_organizationId_and_runId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("runId", args.runId),
      )
      .take(Math.min(args.limit ?? 100, 250));
    const visible = [];
    for (const row of rows) {
      if (row.locationId) {
        if (await canRead(row.locationId)) visible.push(row);
      } else {
        // Mapping failures have no trusted location boundary.
        try {
          await requireNationalScope(ctx, ["admin"]);
          visible.push(row);
        } catch {
          // No national access: omit unmapped reconciliation details.
        }
      }
    }
    return visible;
  },
});
