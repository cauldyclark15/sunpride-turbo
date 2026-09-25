/* Territory ownership is interval authority, not a mutable unit projection.
 * resolveTerritoryOwnerAt returns the unique owner row effective at `at` (or null).
 * requireTerritoryCapability loads the persisted territory and gates its current owner
 * as well as resolving an optional as-of owner; future scheduling never grants early access.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { requireCapability, type Capability } from "../lib/capabilities";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt, interval, topology } from "../org/validation";

export type Ctx = QueryCtx | MutationCtx;
export const MAX_TERRITORY_HISTORY = 500;

export async function ownerships(ctx: Ctx, territoryId: Id<"territories">) {
  const rows = await ctx.db
    .query("territoryOwnerships")
    .withIndex("by_territoryId_and_effectiveFrom", (q) =>
      q.eq("territoryId", territoryId),
    )
    .take(MAX_TERRITORY_HISTORY + 1);
  if (rows.length > MAX_TERRITORY_HISTORY)
    throw new ConvexError("Territory history exceeds limit");
  return rows;
}

export async function resolveTerritoryOwnerAt(
  ctx: Ctx,
  territoryId: Id<"territories">,
  at: number,
) {
  interval(at);
  const territory = await ctx.db.get(territoryId);
  if (!territory || territory.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Territory not found");
  const matches = (await ownerships(ctx, territoryId)).filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, at),
  );
  if (matches.length > 1)
    throw new ConvexError("Overlapping territory ownership");
  if (
    activeAt(territory.effectiveFrom, territory.effectiveTo, at) &&
    matches.length !== 1
  )
    throw new ConvexError("Active territory has no unique owner");
  return matches[0] ?? null;
}

export async function requireTerritoryCapability(
  ctx: Ctx,
  capability: Capability,
  territoryId: Id<"territories">,
  at = Date.now(),
) {
  const territory = await ctx.db.get(territoryId);
  if (!territory || territory.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Territory not found");
  // The current owner is always the access boundary for historical reads.
  const current = await resolveTerritoryOwnerAt(ctx, territoryId, Date.now());
  const last =
    !current &&
    territory.effectiveTo !== undefined &&
    territory.effectiveTo <= Date.now()
      ? (await ownerships(ctx, territoryId)).at(-1)
      : undefined;
  const boundary = current ?? last;
  if (!boundary) throw new ConvexError("Territory has no current owner");
  const access = await requireCapability(ctx, capability, boundary.orgUnitId);
  const owner = await resolveTerritoryOwnerAt(ctx, territoryId, at);
  return { ...access, territory, owner };
}

export async function assertActiveUnit(
  ctx: Ctx,
  unitId: Id<"orgUnits">,
  from: number,
  to?: number,
) {
  interval(from, to);
  const unit = await ctx.db.get(unitId);
  if (
    !unit ||
    unit.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    unit.status !== "active" ||
    !activeAt(unit.effectiveFrom, unit.effectiveTo, from) ||
    (unit.effectiveTo !== undefined &&
      (to === undefined || to > unit.effectiveTo))
  )
    throw new ConvexError("Inactive or retired organization unit");
  if (!(await topology(ctx, from)).some((node) => node._id === unitId))
    throw new ConvexError("Invalid organization unit topology");
  return unit;
}

export function required(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new ConvexError(`${label} required`);
  return trimmed;
}

export function assertBoundary(raw?: string) {
  if (raw === undefined) return;
  if (raw.length > 50000) throw new ConvexError("Boundary too large");
  let geometry: { type?: string; coordinates?: unknown };
  try {
    geometry = JSON.parse(raw);
  } catch {
    throw new ConvexError("Invalid GeoJSON polygon");
  }
  if (
    geometry.type !== "Polygon" ||
    !Array.isArray(geometry.coordinates) ||
    !geometry.coordinates.length
  )
    throw new ConvexError("Invalid GeoJSON polygon");
  const rings = geometry.coordinates;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > 2000)
      throw new ConvexError("Invalid polygon ring");
    for (const point of ring) {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        typeof point[0] !== "number" ||
        typeof point[1] !== "number" ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 ||
        Math.abs(point[1]) > 90
      )
        throw new ConvexError("Invalid polygon coordinate");
    }
    if (JSON.stringify(ring[0]) !== JSON.stringify(ring[ring.length - 1]))
      throw new ConvexError("Polygon ring must close");
  }
}

export function overlaps(
  a: { effectiveFrom: number; effectiveTo?: number },
  from: number,
  to?: number,
) {
  return (
    a.effectiveFrom < (to ?? Infinity) && from < (a.effectiveTo ?? Infinity)
  );
}
