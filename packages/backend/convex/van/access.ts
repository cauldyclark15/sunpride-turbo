import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { employeeAt } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt } from "../org/validation";
import { capabilityRoles, type Capability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import type { AppRole } from "../lib/roles";
import type { AuthorizedDevice } from "../mobile/types";

type Ctx = QueryCtx | MutationCtx;

export async function requireVehicle(ctx: Ctx, vehicleId: Id<"vehicles">) {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Vehicle not found");
  return vehicle;
}

export async function requireTrip(ctx: Ctx, tripId: Id<"vanTrips">) {
  const trip = await ctx.db.get(tripId);
  if (!trip || trip.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Trip not found");
  return trip;
}

export async function tripLoad(ctx: Ctx, tripId: Id<"vanTrips">) {
  const loads = await ctx.db
    .query("vanTripLoads")
    .withIndex("by_tripId_and_loadNumber", (q) => q.eq("tripId", tripId))
    .take(10);
  return loads.filter((load) => load.status !== "cancelled").at(-1) ?? null;
}

export async function loadLines(ctx: Ctx, loadId: Id<"vanTripLoads">) {
  return ctx.db
    .query("vanTripLoadLines")
    .withIndex("by_loadId_and_lineNumber", (q) => q.eq("loadId", loadId))
    .take(101);
}

/**
 * The HTTP gateway verifies the device proof once (mobile/device_auth.authorize) and then
 * runs each bootstrap/operation in its own transaction. Suspension, revocation, a profile
 * deactivation or a scope/role change can commit in between, so every van transaction
 * re-reads the persisted device, profile and effective assignment and refuses an actor
 * snapshot that no longer matches — before any trip lookup or idempotent replay.
 */
export async function requireCurrentDeviceActor(
  ctx: Ctx,
  actor: AuthorizedDevice,
): Promise<void> {
  const refuse = (): never => {
    throw new ConvexError("unauthorized");
  };
  const identity = await ctx.auth.getUserIdentity();
  if (identity && identity.tokenIdentifier !== actor.subject) refuse();
  const device = await ctx.db.get(actor.deviceId);
  if (
    !device ||
    device.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    device.status !== "active" ||
    device.allowedApp !== "VAN_ANDROID" ||
    device.profileId !== actor.profileId ||
    device.boundSubject !== actor.subject ||
    !device.publicKey ||
    !device.credentialId ||
    device.orgUnitId !== actor.orgUnitId
  )
    refuse();
  const profile = await ctx.db.get(actor.profileId);
  if (
    !profile ||
    profile.status !== "active" ||
    profile.authSubject !== actor.subject ||
    profile.role !== actor.role ||
    profile.orgUnitId !== actor.orgUnitId
  )
    refuse();
  const now = Date.now();
  let assignment;
  try {
    assignment = await employeeAt(ctx, actor.profileId, now);
  } catch {
    return refuse();
  }
  if (
    assignment.orgUnitId !== actor.orgUnitId ||
    assignment.role !== actor.role
  )
    refuse();
  const unit = await ctx.db.get(actor.orgUnitId);
  if (
    !unit ||
    unit.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    unit.status !== "active" ||
    !activeAt(unit.effectiveFrom, unit.effectiveTo, now)
  )
    refuse();
}

/**
 * A signed van-device request may act only on its own trip, inside the device holder's
 * current organizational scope, with a role that holds the capability. Callers first run
 * requireCurrentDeviceActor so the snapshot from the device proof is still current.
 */
export async function requireDeviceTrip(
  ctx: Ctx,
  actor: AuthorizedDevice,
  tripId: Id<"vanTrips">,
  capability: Capability = "van.operate",
): Promise<Doc<"vanTrips">> {
  const roles = capabilityRoles(capability) as readonly AppRole[];
  if (actor.role !== "super_admin" && !roles.includes(actor.role))
    throw new ConvexError("out_of_scope");
  const trip = await ctx.db.get(tripId);
  if (
    !trip ||
    trip.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    trip.salespersonProfileId !== actor.profileId ||
    trip.salespersonSubject !== actor.subject
  )
    throw new ConvexError("out_of_scope");
  const scope = await collectScopeUnitIds(ctx, actor.orgUnitId);
  if (!scope.includes(trip.orgUnitId)) throw new ConvexError("out_of_scope");
  return trip;
}
