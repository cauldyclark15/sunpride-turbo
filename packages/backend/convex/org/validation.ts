import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  ORG_ROOT_UNIT_CODE,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";

export const ORG_TIMEZONE = "Asia/Manila";
export const MAX_TREE_UNITS = 500;
export type Ctx = QueryCtx | MutationCtx;

export function interval(from: number, to?: number) {
  if (
    !Number.isSafeInteger(from) ||
    (to !== undefined && (!Number.isSafeInteger(to) || to <= from))
  )
    throw new ConvexError("Invalid effective interval");
}
export function prospective(from: number) {
  interval(from);
  if (from < Date.now())
    throw new ConvexError("Changes must be future-effective");
}
export function normalizeCode(code: string) {
  const value = code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(value))
    throw new ConvexError("Invalid code");
  return value;
}
export function activeAt(from: number, to: number | undefined, asOf: number) {
  return from <= asOf && (to === undefined || asOf < to);
}

export async function edgeAt(ctx: Ctx, unit: Doc<"orgUnits">, asOf: number) {
  const edges = await ctx.db
    .query("orgUnitParentEdges")
    .withIndex("by_unitId_and_effectiveFrom", (q) =>
      q.eq("unitId", unit._id).lte("effectiveFrom", asOf),
    )
    .order("desc")
    .take(2);
  const edge = edges.find((e) =>
    activeAt(e.effectiveFrom, e.effectiveTo, asOf),
  );
  // Existing pre-backfill units retain the legacy projection until the migration runs.
  if (edge) return edge.parentId;
  if (edges.length) return null;
  return unit.parentId ?? null;
}

/** Bounded as-of topology. Rejects dangling, inactive and cyclic edges rather than leaking a partial tree. */
export async function topology(ctx: Ctx, asOf: number) {
  interval(asOf);
  const all = await ctx.db
    .query("orgUnits")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
    )
    .take(MAX_TREE_UNITS + 1);
  if (all.length > MAX_TREE_UNITS)
    throw new ConvexError(
      "Organizational scope exceeds the supported hierarchy size",
    );
  const units = all.filter(
    (u) =>
      activeAt(u.effectiveFrom, u.effectiveTo, asOf) &&
      (u.status === "active" || u.effectiveTo !== undefined),
  );
  const ids = new Set(units.map((u) => u._id));
  const parents = new Map<Id<"orgUnits">, Id<"orgUnits"> | null>();
  for (const unit of units) {
    const parent = await edgeAt(ctx, unit, asOf);
    if (parent && !ids.has(parent))
      throw new ConvexError("Orphaned organization unit");
    parents.set(unit._id, parent);
  }
  if (
    units.length &&
    (units.filter((u) => !parents.get(u._id)).length !== 1 ||
      units.find((u) => !parents.get(u._id))?.code !== ORG_ROOT_UNIT_CODE)
  )
    throw new ConvexError("Invalid organization root or orphaned unit");
  for (const unit of units) {
    const seen = new Set<Id<"orgUnits">>();
    let cursor: Id<"orgUnits"> | null = unit._id;
    while (cursor) {
      if (seen.has(cursor)) throw new ConvexError("Organization cycle");
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }
  return units.map((u) => ({
    ...u,
    parentId: parents.get(u._id) ?? undefined,
  }));
}

export async function assertParent(
  ctx: Ctx,
  childTypeCode: string,
  parentId: Id<"orgUnits">,
  from: number,
  to?: number,
) {
  interval(from, to);
  const parent = await ctx.db.get(parentId);
  if (
    !parent ||
    parent.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    parent.status !== "active" ||
    parent.effectiveFrom > from ||
    (parent.effectiveTo !== undefined &&
      (to === undefined || to > parent.effectiveTo))
  )
    throw new ConvexError("Parent interval does not cover child");
  const childType = await ctx.db
    .query("orgUnitTypes")
    .withIndex("by_organizationId_and_code", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("code", childTypeCode),
    )
    .unique();
  const parentType = await ctx.db
    .query("orgUnitTypes")
    .withIndex("by_organizationId_and_code", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("code", parent.typeCode),
    )
    .unique();
  if (
    !childType?.active ||
    !parentType?.active ||
    childType.level <= parentType.level
  )
    throw new ConvexError("Invalid parent level");
  return parent;
}

export async function audit(
  ctx: MutationCtx,
  subject: string,
  action: string,
  entityType: string,
  entityId: string,
  reason: string,
  now: number,
) {
  await ctx.db.insert("auditLogs", {
    subject,
    action,
    entityType,
    entityId,
    details: reason,
    createdAt: now,
  });
}
