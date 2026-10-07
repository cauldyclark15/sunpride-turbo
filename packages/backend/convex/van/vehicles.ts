import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import schema from "../schema";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireLocationCapability } from "../inventory/location_scope";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { audit, normalizeCode } from "../org/validation";
import { requireVehicle } from "./access";
import { boundedText, vehicleStatusValidator } from "./model";

/** CVX-027: register a truck. Its stock location must be a sellable `truck` location. */
export const create = mutation({
  args: {
    orgUnitId: v.id("orgUnits"),
    vehicleCode: v.string(),
    plateNumber: v.string(),
    name: v.optional(v.string()),
    truckLocationId: v.id("inventoryLocations"),
    homeLocationId: v.id("inventoryLocations"),
    capacityNote: v.optional(v.string()),
  },
  returns: v.id("vehicles"),
  handler: async (ctx, args) => {
    const { identity } = await requireCapability(
      ctx,
      "van.manage",
      args.orgUnitId,
    );
    const { location: truck } = await requireLocationCapability(
      ctx,
      "van.manage",
      args.truckLocationId,
    );
    const { location: home } = await requireLocationCapability(
      ctx,
      "van.manage",
      args.homeLocationId,
    );
    if (truck.type !== "truck" || !truck.allowsSale)
      throw new ConvexError("A sellable truck location is required");
    if (home.type === "truck" || home._id === truck._id)
      throw new ConvexError("The home location must be a depot, not a truck");
    const vehicleCode = normalizeCode(args.vehicleCode);
    const plateNumber = boundedText(args.plateNumber, 20, "Plate number");
    if (!plateNumber) throw new ConvexError("Plate number is required");
    const duplicate = await ctx.db
      .query("vehicles")
      .withIndex("by_organizationId_and_vehicleCode", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("vehicleCode", vehicleCode),
      )
      .first();
    if (duplicate) throw new ConvexError("Vehicle code already exists");
    const sameTruck = await ctx.db
      .query("vehicles")
      .withIndex("by_truckLocationId", (q) =>
        q.eq("truckLocationId", truck._id),
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (sameTruck)
      throw new ConvexError("Truck location already belongs to a vehicle");
    const now = Date.now();
    const name = boundedText(args.name, 80, "Vehicle name");
    const capacityNote = boundedText(args.capacityNote, 200, "Capacity note");
    const vehicleId = await ctx.db.insert("vehicles", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: args.orgUnitId,
      vehicleCode,
      plateNumber: plateNumber.toUpperCase(),
      ...(name ? { name } : {}),
      truckLocationId: truck._id,
      homeLocationId: home._id,
      ...(capacityNote ? { capacityNote } : {}),
      status: "active",
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.vehicle.created",
      "vehicle",
      vehicleId,
      vehicleCode,
      now,
    );
    return vehicleId;
  },
});

export const setStatus = mutation({
  args: {
    vehicleId: v.id("vehicles"),
    status: vehicleStatusValidator,
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const vehicle = await requireVehicle(ctx, args.vehicleId);
    const { identity } = await requireCapability(
      ctx,
      "van.manage",
      vehicle.orgUnitId,
    );
    const reason = boundedText(args.reason, 200, "Reason");
    if (!reason) throw new ConvexError("A reason is required");
    if (args.status === "active") {
      const assigned = await ctx.db
        .query("vehicles")
        .withIndex("by_truckLocationId", (q) =>
          q.eq("truckLocationId", vehicle.truckLocationId),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("status"), "active"),
            q.neq(q.field("_id"), vehicle._id),
          ),
        )
        .first();
      if (assigned)
        throw new ConvexError("Truck location already belongs to a vehicle");
    }
    const now = Date.now();
    await ctx.db.patch(vehicle._id, { status: args.status, updatedAt: now });
    await audit(
      ctx,
      identity.tokenIdentifier,
      `van.vehicle.${args.status}`,
      "vehicle",
      vehicle._id,
      reason,
      now,
    );
    return null;
  },
});

/** Vehicles in the caller's scope (bounded). */
export const list = query({
  args: { status: v.optional(vehicleStatusValidator) },
  returns: v.array(schema.doc("vehicles")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "van.read");
    const units =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : profile.orgUnitId
          ? await collectScopeUnitIds(ctx, profile.orgUnitId)
          : [];
    const status = args.status ?? "active";
    if (units === null)
      return ctx.db
        .query("vehicles")
        .withIndex("by_organizationId_and_vehicleCode", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
        )
        .filter((q) => q.eq(q.field("status"), status))
        .take(200);
    const rows = [];
    for (const unit of units.slice(0, 200)) {
      rows.push(
        ...(await ctx.db
          .query("vehicles")
          .withIndex("by_orgUnitId_and_status", (q) =>
            q.eq("orgUnitId", unit).eq("status", status),
          )
          .take(200)),
      );
      if (rows.length >= 200) break;
    }
    return rows.slice(0, 200);
  },
});
