import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import schema from "../schema";
import { localDate, manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireLocationCapability } from "../inventory/location_scope";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import { audit } from "../org/validation";
import { requireRoute } from "../territories/route_validation";
import { loadLines, requireTrip, requireVehicle, tripLoad } from "./access";
import { postLeftoverReturn, truckBalances } from "./ledger";
import {
  boundedText,
  OPEN_TRIP_STATUSES,
  SERVICE_DATE,
  VAN_POLICY,
} from "./model";

/**
 * CVX-027: the office plans a truck's day — vehicle, salesman (with optional crew names),
 * route and depot. Loading, starting and selling happen afterwards on the van device.
 */
export const plan = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    serviceDate: v.string(),
    salespersonProfileId: v.id("profiles"),
    routeId: v.optional(v.id("routes")),
    sourceLocationId: v.optional(v.id("inventoryLocations")),
    driverName: v.optional(v.string()),
    helperName: v.optional(v.string()),
  },
  returns: v.object({ tripId: v.id("vanTrips"), tripNumber: v.string() }),
  handler: async (ctx, args) => {
    const vehicle = await requireVehicle(ctx, args.vehicleId);
    if (vehicle.status !== "active")
      throw new ConvexError("Vehicle is not active");
    const { identity } = await requireCapability(
      ctx,
      "van.manage",
      vehicle.orgUnitId,
    );
    const sourceLocationId = args.sourceLocationId ?? vehicle.homeLocationId;
    const { location: source } = await requireLocationCapability(
      ctx,
      "van.manage",
      sourceLocationId,
    );
    if (source.type === "truck")
      throw new ConvexError("A trip loads from a depot, not another truck");
    await requireLocationCapability(ctx, "van.manage", vehicle.truckLocationId);
    if (!SERVICE_DATE.test(args.serviceDate))
      throw new ConvexError("Service date must be YYYY-MM-DD");
    // A regex alone admits impossible days (for example February 29 in a non-leap year).
    localDate(args.serviceDate);
    if (args.serviceDate < manilaDate(Date.now()))
      throw new ConvexError("A trip cannot be planned for a past day");
    const seller = await ctx.db.get(args.salespersonProfileId);
    if (
      !seller ||
      seller.status !== "active" ||
      !seller.authSubject ||
      !seller.orgUnitId ||
      !(capabilityRoles("van.operate") as readonly AppRole[]).includes(
        seller.role as AppRole,
      )
    )
      throw new ConvexError("An active van salesman is required");
    await requireCapability(ctx, "van.manage", seller.orgUnitId);
    if (args.routeId) {
      const { route } = await requireRoute(ctx, "route.read", args.routeId);
      if (route.status !== "active") throw new ConvexError("Route is inactive");
    }
    const sameVehicle = await ctx.db
      .query("vanTrips")
      .withIndex("by_vehicleId_and_serviceDate", (q) =>
        q.eq("vehicleId", vehicle._id).eq("serviceDate", args.serviceDate),
      )
      .take(50);
    if (
      sameVehicle.filter((trip) => OPEN_TRIP_STATUSES.includes(trip.status))
        .length >= VAN_POLICY.maxOpenTripsPerVehicleDay
    )
      throw new ConvexError("This truck already has a trip that day");
    const sameSeller = await ctx.db
      .query("vanTrips")
      .withIndex("by_salespersonProfileId_and_serviceDate", (q) =>
        q
          .eq("salespersonProfileId", seller._id)
          .eq("serviceDate", args.serviceDate),
      )
      .take(50);
    if (sameSeller.some((trip) => OPEN_TRIP_STATUSES.includes(trip.status)))
      throw new ConvexError("This salesman already has a trip that day");
    const tripNumber = `TRIP-${args.serviceDate.replaceAll("-", "")}-${vehicle.vehicleCode}-${sameVehicle.length + 1}`;
    const now = Date.now();
    const driverName = boundedText(
      args.driverName,
      VAN_POLICY.maxCrewNameLength,
      "Driver name",
    );
    const helperName = boundedText(
      args.helperName,
      VAN_POLICY.maxCrewNameLength,
      "Helper name",
    );
    const tripId = await ctx.db.insert("vanTrips", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: vehicle.orgUnitId,
      tripNumber,
      vehicleId: vehicle._id,
      truckLocationId: vehicle.truckLocationId,
      sourceLocationId,
      ...(args.routeId ? { routeId: args.routeId } : {}),
      serviceDate: args.serviceDate,
      salespersonProfileId: seller._id,
      salespersonSubject: seller.authSubject,
      ...(driverName ? { driverName } : {}),
      ...(helperName ? { helperName } : {}),
      status: "planned",
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.trip.planned",
      "vanTrip",
      tripId,
      tripNumber,
      now,
    );
    return { tripId, tripNumber };
  },
});

/** Before departure only; a posted load must be returned through the ledger first. */
export const cancel = mutation({
  args: { tripId: v.id("vanTrips"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const trip = await requireTrip(ctx, args.tripId);
    const { identity } = await requireCapability(
      ctx,
      "van.manage",
      trip.orgUnitId,
    );
    if (trip.status !== "planned" && trip.status !== "loading")
      throw new ConvexError("Only a trip that has not loaded can be cancelled");
    const reason = boundedText(args.reason, 200, "Reason");
    if (!reason) throw new ConvexError("A reason is required");
    const load = await tripLoad(ctx, trip._id);
    const now = Date.now();
    if (load)
      await ctx.db.patch(load._id, { status: "cancelled", updatedAt: now });
    await ctx.db.patch(trip._id, {
      status: "cancelled",
      cancelledAt: now,
      cancelReason: reason,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.trip.cancelled",
      "vanTrip",
      trip._id,
      reason,
      now,
    );
    return null;
  },
});

/**
 * Evening (blueprint §25): leftover sellable and damaged stock goes back to the depot
 * through one `van_unload` movement. The office (warehouse) records it after counting.
 */
export const returnLeftover = mutation({
  args: { tripId: v.id("vanTrips"), idempotencyKey: v.string() },
  returns: v.union(v.id("inventoryMovements"), v.null()),
  handler: async (ctx, args) => {
    const trip = await requireTrip(ctx, args.tripId);
    const { identity } = await requireCapability(
      ctx,
      "van.manage",
      trip.orgUnitId,
    );
    await requireLocationCapability(ctx, "van.manage", trip.sourceLocationId);
    if (!["active", "closing", "reconciling"].includes(trip.status))
      throw new ConvexError("Leftovers are returned from an active trip");
    const movement = await postLeftoverReturn(ctx, {
      trip,
      actorSubject: identity.tokenIdentifier,
      idempotencyKey: `van-unload:${trip._id}:${args.idempotencyKey}`,
    });
    if (trip.status === "active")
      await ctx.db.patch(trip._id, {
        status: "closing",
        updatedAt: Date.now(),
      });
    return movement?.movementId ?? null;
  },
});

/** Closes the trip and its POS route session once the truck holds no stock. */
export const close = mutation({
  args: { tripId: v.id("vanTrips") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const trip = await requireTrip(ctx, args.tripId);
    const { identity } = await requireCapability(
      ctx,
      "van.manage",
      trip.orgUnitId,
    );
    if (
      !["active", "closing", "reconciling", "review_required"].includes(
        trip.status,
      )
    )
      throw new ConvexError("Trip is not open");
    const balances = await truckBalances(ctx, trip.truckLocationId);
    if (balances.some((balance) => balance.physicalBase !== 0n))
      throw new ConvexError("Truck still holds stock; return leftovers first");
    const now = Date.now();
    if (trip.routeSessionId) {
      const session = await ctx.db.get(trip.routeSessionId);
      if (session && session.status !== "closed")
        await ctx.db.patch(session._id, {
          status: "closed",
          closedAt: now,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
    }
    await ctx.db.patch(trip._id, {
      status: "closed",
      closedAt: now,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.trip.closed",
      "vanTrip",
      trip._id,
      trip.tripNumber,
      now,
    );
    return null;
  },
});

const tripDetail = v.object({
  trip: schema.doc("vanTrips"),
  vehicle: schema.doc("vehicles"),
  load: v.union(schema.doc("vanTripLoads"), v.null()),
  lines: v.array(schema.doc("vanTripLoadLines")),
});

export const detail = query({
  args: { tripId: v.id("vanTrips") },
  returns: tripDetail,
  handler: async (ctx, args) => {
    const trip = await requireTrip(ctx, args.tripId);
    const { profile } = await requireCapability(
      ctx,
      "van.read",
      trip.orgUnitId,
    );
    if (profile.role === "sales" && trip.salespersonProfileId !== profile._id)
      throw new ConvexError("Trip belongs to another salesman");
    const vehicle = await requireVehicle(ctx, trip.vehicleId);
    const load = await tripLoad(ctx, trip._id);
    return {
      trip,
      vehicle,
      load,
      lines: load ? await loadLines(ctx, load._id) : [],
    };
  },
});

/** One unit's trips for a day (the office board). */
export const listForDay = query({
  args: { orgUnitId: v.id("orgUnits"), serviceDate: v.string() },
  returns: v.array(schema.doc("vanTrips")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(
      ctx,
      "van.read",
      args.orgUnitId,
    );
    const rows = await ctx.db
      .query("vanTrips")
      .withIndex("by_orgUnitId_and_serviceDate", (q) =>
        q.eq("orgUnitId", args.orgUnitId).eq("serviceDate", args.serviceDate),
      )
      .take(200);
    return profile.role === "sales"
      ? rows.filter((trip) => trip.salespersonProfileId === profile._id)
      : rows;
  },
});
