import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { activeAt, interval, topology } from "../org/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { assertActiveUnit, resolveTerritoryOwnerAt } from "./validation";

type Ctx = QueryCtx | MutationCtx;
export const MAX_ROUTE_HISTORY = 500;

export async function routeTerritories(ctx: Ctx, routeId: Id<"routes">) {
  const rows = await ctx.db
    .query("routeTerritories")
    .withIndex("by_routeId_and_effectiveFrom", (q) => q.eq("routeId", routeId))
    .take(MAX_ROUTE_HISTORY + 1);
  if (rows.length > MAX_ROUTE_HISTORY)
    throw new ConvexError("Route history exceeds limit");
  return rows;
}
export async function routeSalespeople(ctx: Ctx, routeId: Id<"routes">) {
  const rows = await ctx.db
    .query("routeSalespeople")
    .withIndex("by_routeId_and_effectiveFrom", (q) => q.eq("routeId", routeId))
    .take(MAX_ROUTE_HISTORY + 1);
  if (rows.length > MAX_ROUTE_HISTORY)
    throw new ConvexError("Route assignments exceed limit");
  return rows;
}
export function at<T extends { effectiveFrom: number; effectiveTo?: number }>(
  rows: T[],
  instant: number,
) {
  interval(instant);
  const matches = rows.filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, instant),
  );
  if (matches.length > 1) throw new ConvexError("Overlapping route intervals");
  return matches[0] ?? null;
}
export async function routeAt(
  ctx: Ctx,
  routeId: Id<"routes">,
  instant: number,
) {
  const route = await ctx.db.get(routeId);
  if (!route || route.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Route not found");
  const association = at(await routeTerritories(ctx, routeId), instant);
  if (activeAt(route.effectiveFrom, route.effectiveTo, instant) && !association)
    throw new ConvexError("Route has no territory at effective time");
  return { route, association };
}
export async function salesCanReadRoute(
  ctx: Ctx,
  profileId: Id<"profiles">,
  routeId: Id<"routes">,
  territoryId: Id<"territories">,
) {
  const now = Date.now();
  if (
    (await routeSalespeople(ctx, routeId)).some(
      (row) =>
        row.profileId === profileId &&
        activeAt(row.effectiveFrom, row.effectiveTo, now),
    )
  )
    return true;
  const rows = await ctx.db
    .query("territorySalespeople")
    .withIndex("by_territoryId_and_effectiveFrom", (q) =>
      q.eq("territoryId", territoryId).lte("effectiveFrom", now),
    )
    .take(MAX_ROUTE_HISTORY + 1);
  if (rows.length > MAX_ROUTE_HISTORY)
    throw new ConvexError("Territory assignments exceed limit");
  return rows.some(
    (row) =>
      row.profileId === profileId &&
      activeAt(row.effectiveFrom, row.effectiveTo, now),
  );
}
export async function requireRoute(
  ctx: Ctx,
  key: "route.read" | "route.manage",
  routeId: Id<"routes">,
  instant = Date.now(),
) {
  const { route } = await routeAt(ctx, routeId, instant);
  const rows = await routeTerritories(ctx, routeId);
  const current = at(rows, Date.now());
  const boundary =
    current ??
    (route.effectiveFrom > Date.now()
      ? rows[0]
      : route.effectiveTo !== undefined && route.effectiveTo <= Date.now()
        ? rows.at(-1)
        : null);
  if (!boundary) throw new ConvexError("Route has no current territory");
  const owner = await resolveTerritoryOwnerAt(
    ctx,
    boundary.territoryId,
    Date.now(),
  );
  // Retired territory still belongs to its last owner for historical reads.
  const history = !owner
    ? await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", boundary.territoryId),
        )
        .order("desc")
        .first()
    : null;
  const unitId = owner?.orgUnitId ?? history?.orgUnitId;
  if (!unitId) throw new ConvexError("Route territory has no owner");
  const access = await requireCapability(ctx, key, unitId);
  if (
    key === "route.read" &&
    access.profile.role === "sales" &&
    !(await salesCanReadRoute(
      ctx,
      access.profile._id,
      routeId,
      boundary.territoryId,
    ))
  )
    throw new ConvexError("Route outside assigned coverage");
  const association = at(rows, instant);
  return { ...access, route, association };
}
export function template(weekdays?: number[], cycleDays?: number) {
  if (
    weekdays !== undefined &&
    (weekdays.length > 7 ||
      new Set(weekdays).size !== weekdays.length ||
      weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7))
  )
    throw new ConvexError(
      "Invalid weekday template (1=Monday through 7=Sunday)",
    );
  if (
    cycleDays !== undefined &&
    (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > 366)
  )
    throw new ConvexError("Invalid cycle days");
}
export async function assertTerritoryWindow(
  ctx: Ctx,
  territoryId: Id<"territories">,
  from: number,
  to?: number,
) {
  interval(from, to);
  const territory = await ctx.db.get(territoryId);
  if (
    !territory ||
    territory.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    territory.status !== "active" ||
    !activeAt(territory.effectiveFrom, territory.effectiveTo, from) ||
    (territory.effectiveTo !== undefined &&
      (to === undefined || to > territory.effectiveTo))
  )
    throw new ConvexError("Territory interval does not cover route");
  const owner = await resolveTerritoryOwnerAt(ctx, territoryId, from);
  if (
    !owner ||
    (owner.effectiveTo !== undefined &&
      (to === undefined || to > owner.effectiveTo))
  )
    throw new ConvexError("Route interval crosses owner transition");
  await assertActiveUnit(ctx, owner.orgUnitId, from, to);
  return owner;
}
export async function assertRoutePerson(
  ctx: MutationCtx,
  profileId: Id<"profiles">,
  ownerUnitId: Id<"orgUnits">,
  from: number,
  to?: number,
) {
  const person = await ctx.db.get(profileId);
  if (!person?.orgUnitId || person.status !== "active")
    throw new ConvexError("Salesperson has no active unit");
  await requireCapability(ctx, "route.manage", person.orgUnitId);
  const assignments = await ctx.db
    .query("employeeAssignments")
    .withIndex("by_profileId_and_effectiveFrom", (q) =>
      q.eq("profileId", profileId),
    )
    .take(MAX_ROUTE_HISTORY + 1);
  if (assignments.length > MAX_ROUTE_HISTORY)
    throw new ConvexError("Employee history exceeds limit");
  const assigned = at(
    assignments.filter((row) => row.effectiveFrom <= from),
    from,
  );
  if (assignments.length && !assigned)
    throw new ConvexError("Salesperson has no assignment at effective time");
  if (
    assignments.some(
      (row) => row.effectiveFrom > from && row.effectiveFrom < (to ?? Infinity),
    )
  )
    throw new ConvexError("Future employee assignment needs revalidation");
  const unitId = assigned?.orgUnitId ?? person.orgUnitId;
  await assertActiveUnit(ctx, unitId, from, to);
  const tree = await topology(ctx, from);
  const parent = new Map(tree.map((row) => [row._id, row.parentId]));
  let cursor: Id<"orgUnits"> | undefined = unitId;
  while (cursor && cursor !== ownerUnitId) cursor = parent.get(cursor);
  if (cursor !== ownerUnitId)
    throw new ConvexError("Salesperson outside route territory hierarchy");
}
export function overlaps(
  row: Doc<"routeSalespeople">,
  from: number,
  to?: number,
) {
  return (
    row.effectiveFrom < (to ?? Infinity) && from < (row.effectiveTo ?? Infinity)
  );
}
