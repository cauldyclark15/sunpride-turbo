import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { activeAt, topology } from "../org/validation";
import { outletRows, resolveOutletScopeAt } from "../outlets/validation";
import {
  LOCATION_POLICY,
  liveStatus,
  liveStatusValidator,
  manilaMidnight,
  pingKindValidator,
} from "./model";

const SERVICE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3_600_000;

/**
 * Who may see which pings (SP-0135): `location.read` holders see people and trucks in their
 * CURRENT organizational scope; `super_admin`/`analyst` see every unit (analyst read-only);
 * `sales` see only themselves. Scope is always resolved on the server.
 */
async function viewer(ctx: QueryCtx) {
  const { profile } = await requireCapability(ctx, "location.read");
  const selfOnly = profile.role === "sales";
  const crossScope =
    profile.role === "super_admin" || profile.role === "analyst";
  const tree = await topology(ctx, Date.now());
  let scope: Set<Id<"orgUnits">>;
  if (crossScope) scope = new Set(tree.map((unit) => unit._id));
  else if (selfOnly && !profile.orgUnitId) scope = new Set();
  else {
    if (
      !profile.orgUnitId ||
      !tree.some((unit) => unit._id === profile.orgUnitId)
    )
      throw new ConvexError("Your access has no organizational scope");
    const ids: Id<"orgUnits">[] = [profile.orgUnitId];
    for (let i = 0; i < ids.length; i++)
      for (const unit of tree) if (unit.parentId === ids[i]) ids.push(unit._id);
    scope = new Set(ids);
  }
  const subtree = (root: Id<"orgUnits">) => {
    const ids = [root];
    for (let i = 0; i < ids.length; i++)
      for (const unit of tree)
        if (unit.parentId === ids[i] && scope.has(unit._id)) ids.push(unit._id);
    return ids;
  };
  const people = new Map<Id<"profiles">, Doc<"profiles"> | null>();
  const person = async (id: Id<"profiles">) => {
    if (!people.has(id)) people.set(id, await ctx.db.get(id));
    return people.get(id) ?? null;
  };
  /** A field position is visible while its person CURRENTLY sits in scope. */
  const seesPerson = async (id: Id<"profiles">) => {
    if (selfOnly) return id === profile._id;
    const row = await person(id);
    return !!row?.orgUnitId && scope.has(row.orgUnitId);
  };
  /** A truck position is visible inside the trip's unit (or to its own seller). */
  const seesRow = async (row: {
    kind: "field" | "van";
    profileId: Id<"profiles">;
    orgUnitId: Id<"orgUnits">;
  }) =>
    selfOnly
      ? row.profileId === profile._id
      : row.kind === "van"
        ? scope.has(row.orgUnitId)
        : await seesPerson(row.profileId);
  return {
    profile,
    selfOnly,
    crossScope,
    scope,
    subtree,
    tree,
    person,
    seesPerson,
    seesRow,
  };
}

const position = v.object({
  id: v.id("liveLocations"),
  kind: pingKindValidator,
  profileId: v.id("profiles"),
  name: v.string(),
  vehicleId: v.union(v.id("vehicles"), v.null()),
  vehicleLabel: v.union(v.string(), v.null()),
  tripNumber: v.union(v.string(), v.null()),
  orgUnitId: v.id("orgUnits"),
  unitName: v.string(),
  teamId: v.union(v.id("teams"), v.null()),
  teamName: v.union(v.string(), v.null()),
  latitude: v.number(),
  longitude: v.number(),
  accuracyMeters: v.number(),
  speedMetersPerSecond: v.union(v.number(), v.null()),
  headingDegrees: v.union(v.number(), v.null()),
  batteryPercent: v.union(v.number(), v.null()),
  mockLocation: v.boolean(),
  recordedAt: v.number(),
  receivedAt: v.number(),
  serviceDate: v.string(),
  status: liveStatusValidator,
  /** The open call's store, when the ping came from inside a visit. */
  visitOutletName: v.union(v.string(), v.null()),
  sample: v.boolean(),
});

/**
 * Live positions for the web map (Convex subscription). `now` comes from the client and is
 * refreshed on a timer, so status (moving/idle/stale/offline) advances without the query
 * reading the wall clock. Positions older than 24 hours are not shown.
 */
export const live = query({
  args: {
    now: v.number(),
    kind: v.optional(pingKindValidator),
    orgUnitId: v.optional(v.id("orgUnits")),
    teamId: v.optional(v.id("teams")),
  },
  returns: v.object({
    now: v.number(),
    truncated: v.boolean(),
    selfOnly: v.boolean(),
    positions: v.array(position),
    units: v.array(v.object({ id: v.id("orgUnits"), name: v.string() })),
    teams: v.array(v.object({ id: v.id("teams"), name: v.string() })),
  }),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.now) || args.now <= 0)
      throw new ConvexError("invalid_request");
    const sc = await viewer(ctx);
    if (args.orgUnitId && !sc.scope.has(args.orgUnitId))
      throw new ConvexError(
        "Requested scope is outside your organizational scope",
      );
    const since = args.now - LOCATION_POLICY.liveWindowMs;
    const cap = LOCATION_POLICY.maxLiveRows;
    let rows: Doc<"liveLocations">[] = [];
    let truncated = false;
    if (sc.selfOnly) {
      rows = await ctx.db
        .query("liveLocations")
        .withIndex("by_profileId_and_recordedAt", (q) =>
          q.eq("profileId", sc.profile._id).gte("recordedAt", since),
        )
        .take(20);
    } else if (sc.crossScope && !args.orgUnitId) {
      rows = await ctx.db
        .query("liveLocations")
        .withIndex("by_recordedAt", (q) => q.gte("recordedAt", since))
        .order("desc")
        .take(cap + 1);
    } else {
      const units = args.orgUnitId ? sc.subtree(args.orgUnitId) : [...sc.scope];
      for (const unitId of units) {
        if (rows.length > cap) break;
        rows.push(
          ...(await ctx.db
            .query("liveLocations")
            .withIndex("by_orgUnitId_and_recordedAt", (q) =>
              q.eq("orgUnitId", unitId).gte("recordedAt", since),
            )
            .order("desc")
            .take(cap + 1 - rows.length)),
        );
      }
    }
    if (rows.length > cap) {
      truncated = true;
      rows = rows.slice(0, cap);
    }
    const filterUnits = args.orgUnitId
      ? new Set(sc.subtree(args.orgUnitId))
      : null;
    const unitNames = new Map(sc.tree.map((unit) => [unit._id, unit.name]));
    const vehicles = new Map<Id<"vehicles">, Doc<"vehicles"> | null>();
    const teams = new Map<Id<"profiles">, Doc<"teams"> | null>();
    const teamOptions = new Map<Id<"teams">, string>();
    const teamOf = async (profileId: Id<"profiles">) => {
      if (teams.has(profileId)) return teams.get(profileId) ?? null;
      const memberships = await ctx.db
        .query("teamMemberships")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profileId),
        )
        .order("desc")
        .take(20);
      const current = memberships.find((row) =>
        activeAt(row.effectiveFrom, row.effectiveTo, args.now),
      );
      const team = current ? await ctx.db.get(current.teamId) : null;
      const active = team?.status === "active" ? team : null;
      teams.set(profileId, active);
      return active;
    };
    const positions = [];
    for (const row of rows) {
      if (row.organizationId !== SUNPRIDE_ORGANIZATION_ID) continue;
      if (!(await sc.seesRow(row))) continue;
      const person = await sc.person(row.profileId);
      if (!person) continue;
      const unitId =
        row.kind === "field" && person.orgUnitId
          ? person.orgUnitId
          : row.orgUnitId;
      if (filterUnits && !filterUnits.has(unitId)) continue;
      if (args.kind && row.kind !== args.kind) continue;
      const team = await teamOf(row.profileId);
      if (team) teamOptions.set(team._id, team.name);
      if (args.teamId && team?._id !== args.teamId) continue;
      let vehicle: Doc<"vehicles"> | null = null;
      if (row.vehicleId) {
        if (!vehicles.has(row.vehicleId))
          vehicles.set(row.vehicleId, await ctx.db.get(row.vehicleId));
        vehicle = vehicles.get(row.vehicleId) ?? null;
      }
      const trip = row.tripId ? await ctx.db.get(row.tripId) : null;
      const visit = row.visitId ? await ctx.db.get(row.visitId) : null;
      const outlet =
        visit && visit.checkedOutAt === undefined
          ? await ctx.db.get(visit.outletId)
          : null;
      positions.push({
        id: row._id,
        kind: row.kind,
        profileId: row.profileId,
        name: person.name,
        vehicleId: row.vehicleId ?? null,
        vehicleLabel: vehicle
          ? `${vehicle.vehicleCode} · ${vehicle.plateNumber}`
          : null,
        tripNumber: trip?.tripNumber ?? null,
        orgUnitId: unitId,
        unitName: unitNames.get(unitId) ?? "—",
        teamId: team?._id ?? null,
        teamName: team?.name ?? null,
        latitude: row.latitude,
        longitude: row.longitude,
        accuracyMeters: row.accuracyMeters,
        speedMetersPerSecond: row.speedMetersPerSecond,
        headingDegrees: row.headingDegrees,
        batteryPercent: row.batteryPercent,
        mockLocation: row.mockLocation,
        recordedAt: row.recordedAt,
        receivedAt: row.receivedAt,
        serviceDate: row.serviceDate,
        status: liveStatus(row, args.now),
        visitOutletName: outlet?.name ?? null,
        sample: row.sample === true,
      });
    }
    positions.sort(
      (a, b) => b.recordedAt - a.recordedAt || a.name.localeCompare(b.name),
    );
    return {
      now: args.now,
      truncated,
      selfOnly: sc.selfOnly,
      positions,
      units: sc.selfOnly
        ? []
        : sc.tree
            .filter((unit) => sc.scope.has(unit._id))
            .map((unit) => ({ id: unit._id, name: unit.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
      teams: [...teamOptions]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

const trailPing = v.object({
  kind: pingKindValidator,
  latitude: v.number(),
  longitude: v.number(),
  accuracyMeters: v.number(),
  speedMetersPerSecond: v.union(v.number(), v.null()),
  batteryPercent: v.union(v.number(), v.null()),
  mockLocation: v.boolean(),
  trigger: v.string(),
  recordedAt: v.number(),
});

/**
 * One person's day (Asia/Manila): their pings in time order — field and truck — with the
 * day's check-ins as stops (store pin, else the nearest ping). Same visibility as `live`.
 */
export const trail = query({
  args: { profileId: v.id("profiles"), serviceDate: v.string() },
  returns: v.object({
    profileId: v.id("profiles"),
    name: v.string(),
    serviceDate: v.string(),
    truncated: v.boolean(),
    pings: v.array(trailPing),
    stops: v.array(
      v.object({
        visitId: v.id("visitExecutions"),
        outletCode: v.string(),
        outletName: v.string(),
        state: v.string(),
        checkedInAt: v.union(v.number(), v.null()),
        checkedOutAt: v.union(v.number(), v.null()),
        latitude: v.union(v.number(), v.null()),
        longitude: v.union(v.number(), v.null()),
        pinned: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    if (
      !SERVICE_DATE.test(args.serviceDate) ||
      Number.isNaN(manilaMidnight(args.serviceDate))
    )
      throw new ConvexError("invalid_request");
    const sc = await viewer(ctx);
    if (sc.selfOnly && args.profileId !== sc.profile._id)
      throw new ConvexError(
        "Requested scope is outside your organizational scope",
      );
    const person = await sc.person(args.profileId);
    if (!person) throw new ConvexError("Person not found");
    const from = manilaMidnight(args.serviceDate);
    const to = from + DAY_MS;
    const cap = LOCATION_POLICY.maxTrailPings;
    const field = (await sc.seesPerson(args.profileId))
      ? await ctx.db
          .query("locationPings")
          .withIndex("by_profileId_and_kind_and_recordedAt", (q) =>
            q
              .eq("profileId", args.profileId)
              .eq("kind", "field")
              .gte("recordedAt", from)
              .lt("recordedAt", to),
          )
          .take(cap + 1)
      : [];
    const van = (
      await ctx.db
        .query("locationPings")
        .withIndex("by_profileId_and_kind_and_recordedAt", (q) =>
          q
            .eq("profileId", args.profileId)
            .eq("kind", "van")
            .gte("recordedAt", from)
            .lt("recordedAt", to),
        )
        .take(cap + 1)
    ).filter((row) => (sc.selfOnly ? true : sc.scope.has(row.orgUnitId)));
    if (!field.length && !van.length && !(await sc.seesPerson(args.profileId)))
      throw new ConvexError(
        "Requested scope is outside your organizational scope",
      );
    const all = [...field, ...van].sort((a, b) => a.recordedAt - b.recordedAt);
    const truncated = all.length > cap;
    const pings = all.slice(0, cap).map((row) => ({
      kind: row.kind,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyMeters: row.accuracyMeters,
      speedMetersPerSecond: row.speedMetersPerSecond,
      batteryPercent: row.batteryPercent,
      mockLocation: row.mockLocation,
      trigger: row.trigger,
      recordedAt: row.recordedAt,
    }));
    const stops = [];
    if (await sc.seesPerson(args.profileId)) {
      const visits = await ctx.db
        .query("visitExecutions")
        .withIndex(
          "by_organizationId_and_assigneeProfileId_and_serviceDate",
          (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("assigneeProfileId", args.profileId)
              .eq("serviceDate", args.serviceDate),
        )
        .take(LOCATION_POLICY.maxTrailStops);
      for (const visit of visits) {
        if (!sc.selfOnly && !sc.crossScope && !sc.scope.has(visit.orgUnitId))
          continue;
        const outlet = await ctx.db.get(visit.outletId);
        const instant = visit.checkedInAt ?? visit.createdAt;
        const pins = (
          await outletRows(ctx, "outletPins", visit.outletId)
        ).filter(
          (pin) =>
            pin.status === "verified" &&
            activeAt(pin.effectiveFrom, pin.effectiveTo, instant),
        );
        let point: { latitude: number; longitude: number } | null =
          pins.length === 1
            ? { latitude: pins[0]!.latitude, longitude: pins[0]!.longitude }
            : null;
        const pinned = point !== null;
        if (!point && pings.length) {
          const nearest = pings.reduce((best, ping) =>
            Math.abs(ping.recordedAt - instant) <
            Math.abs(best.recordedAt - instant)
              ? ping
              : best,
          );
          if (Math.abs(nearest.recordedAt - instant) <= 10 * 60_000)
            point = {
              latitude: nearest.latitude,
              longitude: nearest.longitude,
            };
        }
        stops.push({
          visitId: visit._id,
          outletCode: outlet?.code ?? "—",
          outletName: outlet?.name ?? "Unknown store",
          state: visit.state,
          checkedInAt: visit.checkedInAt ?? null,
          checkedOutAt: visit.checkedOutAt ?? null,
          latitude: point?.latitude ?? null,
          longitude: point?.longitude ?? null,
          pinned,
        });
      }
      stops.sort(
        (a, b) => (a.checkedInAt ?? Infinity) - (b.checkedInAt ?? Infinity),
      );
    }
    return {
      profileId: args.profileId,
      name: person.name,
      serviceDate: args.serviceDate,
      truncated,
      pings,
      stops,
    };
  },
});

/**
 * Verified store pins inside the caller's scope (current outlet owner, ADR-005), paged.
 * The web map loads pages until done; stores without a verified pin are skipped.
 */
export const storePins = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        outletId: v.id("outlets"),
        code: v.string(),
        name: v.string(),
        latitude: v.number(),
        longitude: v.number(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { paginationOpts }) => {
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 100
    )
      throw new ConvexError("Page size must be 1–100");
    const sc = await viewer(ctx);
    const result = await ctx.db
      .query("outlets")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(paginationOpts);
    const now = Date.now();
    const page = [];
    for (const outlet of result.page) {
      if (outlet.status === "inactive") continue;
      let unitId: Id<"orgUnits">;
      try {
        unitId = (await resolveOutletScopeAt(ctx, outlet._id, now)).orgUnitId;
      } catch {
        continue;
      }
      if (!sc.scope.has(unitId)) continue;
      const pins = (await outletRows(ctx, "outletPins", outlet._id)).filter(
        (pin) =>
          pin.status === "verified" &&
          activeAt(pin.effectiveFrom, pin.effectiveTo, now),
      );
      if (pins.length !== 1) continue;
      page.push({
        outletId: outlet._id,
        code: outlet.code,
        name: outlet.name,
        latitude: pins[0]!.latitude,
        longitude: pins[0]!.longitude,
      });
    }
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
