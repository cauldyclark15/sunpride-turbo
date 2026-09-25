import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability, type Capability } from "../lib/capabilities";
import { activeAt, interval } from "../org/validation";
import { resolveTerritoryOwnerAt } from "../territories/validation";

type Ctx = MutationCtx | QueryCtx;
export const MAX_OUTLET_HISTORY = 500;
// PROVISIONAL (ADR-017): client must confirm geofence policy and override authority.
export const DEFAULT_RADIUS_METERS = 75;
export const MAX_RADIUS_METERS = 500;

export function required(value: string, label: string, max = 500) {
  const result = value.trim();
  if (!result || result.length > max)
    throw new ConvexError(`${label} required (max ${max})`);
  return result;
}

export function validatePin(
  latitude: number,
  longitude: number,
  radiusMeters: number,
) {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  )
    throw new ConvexError("Invalid WGS84 coordinates");
  if (
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0 ||
    radiusMeters > MAX_RADIUS_METERS
  )
    throw new ConvexError("Invalid geofence radius");
}

export function validateProfile(fields: {
  name: string;
  address?: string;
  directions?: string;
  channel?: string;
  subchannel?: string;
  classification?: string;
  contacts?: { name: string; phone?: string }[];
  salesPotential?: number;
  preferredWeekday?: number;
  visitFrequencyDays?: number;
  visitWindow?: string;
}) {
  required(fields.name, "Name", 200);
  for (const value of [
    fields.address,
    fields.directions,
    fields.channel,
    fields.subchannel,
    fields.classification,
    fields.visitWindow,
  ])
    if (value !== undefined && value.length > 500)
      throw new ConvexError("Profile field too long");
  if (
    fields.contacts &&
    (fields.contacts.length > 10 ||
      fields.contacts.some(
        (c) =>
          !c.name.trim() || c.name.length > 100 || (c.phone?.length ?? 0) > 40,
      ))
  )
    throw new ConvexError("Invalid outlet contacts");
  if (
    fields.salesPotential !== undefined &&
    (!Number.isFinite(fields.salesPotential) || fields.salesPotential < 0)
  )
    throw new ConvexError("Invalid sales potential");
  if (
    fields.preferredWeekday !== undefined &&
    (!Number.isInteger(fields.preferredWeekday) ||
      fields.preferredWeekday < 0 ||
      fields.preferredWeekday > 6)
  )
    throw new ConvexError("Invalid preferred weekday");
  if (
    fields.visitFrequencyDays !== undefined &&
    (!Number.isSafeInteger(fields.visitFrequencyDays) ||
      fields.visitFrequencyDays < 1 ||
      fields.visitFrequencyDays > 365)
  )
    throw new ConvexError("Invalid visit frequency");
}

export async function outletRows(
  ctx: Ctx,
  table: "outletAssignments",
  outletId: Id<"outlets">,
): Promise<Doc<"outletAssignments">[]>;
export async function outletRows(
  ctx: Ctx,
  table: "outletCustomerLinks",
  outletId: Id<"outlets">,
): Promise<Doc<"outletCustomerLinks">[]>;
export async function outletRows(
  ctx: Ctx,
  table: "outletPins",
  outletId: Id<"outlets">,
): Promise<Doc<"outletPins">[]>;
export async function outletRows(
  ctx: Ctx,
  table: "outletAssignments" | "outletCustomerLinks" | "outletPins",
  outletId: Id<"outlets">,
) {
  const limit = MAX_OUTLET_HISTORY + 1;
  const rows =
    table === "outletAssignments"
      ? await ctx.db
          .query("outletAssignments")
          .withIndex("by_outletId_and_effectiveFrom", (q) =>
            q.eq("outletId", outletId),
          )
          .take(limit)
      : table === "outletPins"
        ? await ctx.db
            .query("outletPins")
            .withIndex("by_outletId_and_effectiveFrom", (q) =>
              q.eq("outletId", outletId),
            )
            .take(limit)
        : await ctx.db
            .query("outletCustomerLinks")
            .withIndex("by_outletId_and_effectiveFrom", (q) =>
              q.eq("outletId", outletId),
            )
            .take(limit);
  if (rows.length > MAX_OUTLET_HISTORY)
    throw new ConvexError("Outlet history exceeds limit");
  return rows;
}

/** As-of ownership for group-05 snapshots; callers must separately gate the CURRENT scope. */
export async function resolveOutletScopeAt(
  ctx: Ctx,
  outletId: Id<"outlets">,
  at: number,
) {
  interval(at);
  const outlet = await ctx.db.get(outletId);
  if (!outlet || outlet.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Outlet not found");
  const assignments = (
    await outletRows(ctx, "outletAssignments", outletId)
  ).filter((row) => activeAt(row.effectiveFrom, row.effectiveTo, at));
  if (assignments.length > 1)
    throw new ConvexError("Overlapping outlet assignments");
  const assignment = assignments[0] ?? null;
  const owner = assignment
    ? await resolveTerritoryOwnerAt(ctx, assignment.territoryId, at)
    : null;
  if (assignment && !owner)
    throw new ConvexError("Outlet assignment has no territory owner");
  return {
    outlet,
    assignment,
    orgUnitId: owner?.orgUnitId ?? outlet.custodianOrgUnitId,
  };
}

export async function requireOutletCapability(
  ctx: Ctx,
  capability: Capability,
  outletId: Id<"outlets">,
) {
  const scope = await resolveOutletScopeAt(ctx, outletId, Date.now());
  const access = await requireCapability(ctx, capability, scope.orgUnitId);
  if (
    capability === "outlet.read" &&
    access.profile.role === "sales" &&
    scope.assignment
  ) {
    const assignments = await ctx.db
      .query("territorySalespeople")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", scope.assignment!.territoryId),
      )
      .take(MAX_OUTLET_HISTORY + 1);
    if (assignments.length > MAX_OUTLET_HISTORY)
      throw new ConvexError("Territory assignments exceed limit");
    if (
      !assignments.some(
        (row) =>
          row.profileId === access.profile._id &&
          activeAt(row.effectiveFrom, row.effectiveTo, Date.now()),
      )
    )
      throw new ConvexError("Outlet outside salesperson assignment");
  }
  return { ...scope, ...access };
}

export function currentRow<
  T extends { effectiveFrom: number; effectiveTo?: number },
>(rows: T[], at: number): T | null {
  const matches = rows.filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, at),
  );
  if (matches.length > 1)
    throw new ConvexError("Overlapping effective intervals");
  return matches[0] ?? null;
}

export function assertActiveOutlet(outlet: Doc<"outlets">) {
  if (outlet.status === "inactive") throw new ConvexError("Inactive outlet");
}
