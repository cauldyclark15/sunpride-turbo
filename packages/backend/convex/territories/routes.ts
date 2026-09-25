import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, mutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  activeAt,
  audit,
  interval,
  normalizeCode,
  prospective,
} from "../org/validation";
import schema from "../schema";
import {
  required,
  resolveTerritoryOwnerAt,
  requireTerritoryCapability,
} from "./validation";
import {
  assertRoutePerson,
  assertTerritoryWindow,
  at,
  MAX_ROUTE_HISTORY,
  overlaps,
  requireRoute,
  routeAt,
  routeSalespeople,
  routeTerritories,
  salesCanReadRoute,
  template,
} from "./route_validation";

async function uniqueCode(
  ctx: MutationCtx,
  code: string,
  territoryId: Id<"territories">,
  exclude?: Id<"routes">,
) {
  const candidates = await ctx.db
    .query("routes")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
    )
    .take(MAX_ROUTE_HISTORY + 1);
  if (candidates.length > MAX_ROUTE_HISTORY)
    throw new ConvexError("Route code namespace exceeds limit");
  for (const candidate of candidates) {
    if (candidate._id === exclude) continue;
    for (const association of await routeTerritories(ctx, candidate._id)) {
      if (association.territoryId === territoryId)
        throw new ConvexError("Duplicate route code in territory");
    }
  }
}
async function ownerForWrite(
  ctx: MutationCtx,
  territoryId: Id<"territories">,
  from: number,
  to?: number,
) {
  const owner = await assertTerritoryWindow(ctx, territoryId, from, to);
  await requireCapability(ctx, "route.manage", owner.orgUnitId);
  return owner;
}
async function routeWrite(
  ctx: MutationCtx,
  routeId: Id<"routes">,
  from: number,
) {
  prospective(from);
  const access = await requireRoute(ctx, "route.manage", routeId);
  if (
    access.route.status !== "active" ||
    !activeAt(access.route.effectiveFrom, access.route.effectiveTo, from)
  )
    throw new ConvexError("Route not active at effective time");
  const association = (await routeAt(ctx, routeId, from)).association;
  if (!association) throw new ConvexError("Route territory missing");
  const owner = await ownerForWrite(
    ctx,
    association.territoryId,
    from,
    association.effectiveTo,
  );
  return { ...access, association, owner };
}
export const list = query({
  args: {
    territoryId: v.id("territories"),
    paginationOpts: paginationOptsValidator,
    asOf: v.optional(v.number()),
  },
  returns: paginationResultValidator(schema.doc("routes")),
  handler: async (ctx, args) => {
    const { profile } = await requireTerritoryCapability(
      ctx,
      "route.read",
      args.territoryId,
    );
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      throw new ConvexError("Page size must be 1–100");
    const instant = args.asOf ?? Date.now();
    interval(instant);
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const result = await ctx.db
      .query("routes")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(args.paginationOpts);
    const page = [];
    for (const route of result.page) {
      if (!activeAt(route.effectiveFrom, route.effectiveTo, instant)) continue;
      const rows = await routeTerritories(ctx, route._id);
      if (at(rows, instant)?.territoryId !== args.territoryId) continue;
      const current =
        at(rows, Date.now()) ??
        (route.effectiveFrom > Date.now() ? rows[0] : null);
      if (!current) continue;
      const owner = await resolveTerritoryOwnerAt(
        ctx,
        current.territoryId,
        Date.now(),
      );
      if (!owner || (scope && !scope.has(owner.orgUnitId))) continue;
      if (
        profile.role === "sales" &&
        !(await salesCanReadRoute(
          ctx,
          profile._id,
          route._id,
          current.territoryId,
        ))
      )
        continue;
      page.push(route);
    }
    return { ...result, page };
  },
});
export const detail = query({
  args: { routeId: v.id("routes"), asOf: v.optional(v.number()) },
  returns: v.object({
    route: schema.doc("routes"),
    territory: v.union(schema.doc("routeTerritories"), v.null()),
    salespeople: v.array(schema.doc("routeSalespeople")),
  }),
  handler: async (ctx, args) => {
    const instant = args.asOf ?? Date.now();
    const { route, association } = await requireRoute(
      ctx,
      "route.read",
      args.routeId,
      instant,
    );
    const salespeople = (await routeSalespeople(ctx, route._id)).filter((row) =>
      activeAt(row.effectiveFrom, row.effectiveTo, instant),
    );
    return { route, territory: association, salespeople };
  },
});
export const history = query({
  args: { routeId: v.id("routes") },
  returns: v.object({
    territories: v.array(schema.doc("routeTerritories")),
    salespeople: v.array(schema.doc("routeSalespeople")),
  }),
  handler: async (ctx, args) => {
    const { profile } = await requireRoute(ctx, "route.read", args.routeId);
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const territories = [];
    for (const row of await routeTerritories(ctx, args.routeId)) {
      const owner = await resolveTerritoryOwnerAt(
        ctx,
        row.territoryId,
        row.effectiveFrom,
      );
      if (owner && (!scope || scope.has(owner.orgUnitId)))
        territories.push(row);
    }
    const salespeople = [];
    for (const row of await routeSalespeople(ctx, args.routeId)) {
      const person = await ctx.db.get(row.profileId);
      if (person?.orgUnitId && (!scope || scope.has(person.orgUnitId)))
        salespeople.push(row);
    }
    return { territories, salespeople };
  },
});
export const create = mutation({
  args: {
    territoryId: v.id("territories"),
    code: v.string(),
    name: v.string(),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    weekdayTemplate: v.optional(v.array(v.number())),
    cycleDays: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.id("routes"),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    interval(args.effectiveFrom, args.effectiveTo);
    const owner = await ownerForWrite(
      ctx,
      args.territoryId,
      args.effectiveFrom,
      args.effectiveTo,
    );
    // Current scope is authoritative even for future intervals.
    await requireTerritoryCapability(ctx, "route.manage", args.territoryId);
    const code = normalizeCode(args.code),
      name = required(args.name, "Name"),
      reason = required(args.reason, "Reason");
    template(args.weekdayTemplate, args.cycleDays);
    await uniqueCode(ctx, code, args.territoryId);
    const { identity } = await requireCapability(
      ctx,
      "route.manage",
      owner.orgUnitId,
    );
    const now = Date.now();
    const id = await ctx.db.insert("routes", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      code,
      name,
      status: "active",
      effectiveFrom: args.effectiveFrom,
      effectiveTo: args.effectiveTo,
      weekdayTemplate: args.weekdayTemplate,
      cycleDays: args.cycleDays,
      createdAt: now,
      updatedAt: now,
      createdBy: identity.tokenIdentifier,
    });
    await ctx.db.insert("routeTerritories", {
      routeId: id,
      territoryId: args.territoryId,
      effectiveFrom: args.effectiveFrom,
      effectiveTo: args.effectiveTo,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    if (args.effectiveTo !== undefined)
      await ctx.scheduler.runAt(
        args.effectiveTo,
        internal.territories.routes.applyProjection,
        { routeId: id },
      );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "route.created",
      "route",
      id,
      reason,
      now,
    );
    return id;
  },
});
export const edit = mutation({
  args: {
    routeId: v.id("routes"),
    name: v.string(),
    weekdayTemplate: v.optional(v.array(v.number())),
    cycleDays: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { route, identity } = await requireRoute(
      ctx,
      "route.manage",
      args.routeId,
    );
    if (
      route.status !== "active" ||
      (route.effectiveTo !== undefined && route.effectiveTo <= Date.now())
    )
      throw new ConvexError("Inactive route");
    template(args.weekdayTemplate, args.cycleDays);
    const reason = required(args.reason, "Reason"),
      now = Date.now();
    await ctx.db.patch(route._id, {
      name: required(args.name, "Name"),
      weekdayTemplate: args.weekdayTemplate,
      cycleDays: args.cycleDays,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "route.edited",
      "route",
      route._id,
      reason,
      now,
    );
    return null;
  },
});
export const move = mutation({
  args: {
    routeId: v.id("routes"),
    territoryId: v.id("territories"),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { route, identity } = await routeWrite(
      ctx,
      args.routeId,
      args.effectiveFrom,
    );
    const rows = await routeTerritories(ctx, route._id);
    const previous = rows.at(-1);
    if (
      !previous ||
      previous.effectiveFrom >= args.effectiveFrom ||
      (previous.effectiveTo !== undefined &&
        previous.effectiveTo <= args.effectiveFrom) ||
      previous.territoryId === args.territoryId
    )
      throw new ConvexError("Overlapping or invalid route move");
    const target = await ownerForWrite(
      ctx,
      args.territoryId,
      args.effectiveFrom,
      route.effectiveTo,
    );
    await requireTerritoryCapability(ctx, "route.manage", args.territoryId);
    await uniqueCode(ctx, route.code, args.territoryId, route._id);
    const oldOwner = await resolveTerritoryOwnerAt(
      ctx,
      previous.territoryId,
      args.effectiveFrom,
    );
    if (!oldOwner) throw new ConvexError("Source territory owner missing");
    await requireCapability(ctx, "route.manage", oldOwner.orgUnitId);
    const stops = await ctx.db
      .query("outletAssignments")
      .withIndex("by_routeId_and_effectiveFrom", (q) =>
        q.eq("routeId", route._id),
      )
      .take(MAX_ROUTE_HISTORY + 1);
    if (
      stops.length > MAX_ROUTE_HISTORY ||
      stops.some(
        (row) =>
          row.effectiveFrom < (route.effectiveTo ?? Infinity) &&
          args.effectiveFrom < (row.effectiveTo ?? Infinity),
      )
    )
      throw new ConvexError("Move requires outlet reassignment first");
    for (const row of await routeSalespeople(ctx, route._id))
      if (overlaps(row, args.effectiveFrom, route.effectiveTo))
        await assertRoutePerson(
          ctx,
          row.profileId,
          target.orgUnitId,
          Math.max(args.effectiveFrom, row.effectiveFrom),
          row.effectiveTo ?? route.effectiveTo,
        );
    const reason = required(args.reason, "Reason"),
      now = Date.now();
    await ctx.db.patch(previous._id, { effectiveTo: args.effectiveFrom });
    await ctx.db.insert("routeTerritories", {
      routeId: route._id,
      territoryId: args.territoryId,
      effectiveFrom: args.effectiveFrom,
      effectiveTo: route.effectiveTo,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "route.moved",
      "route",
      route._id,
      reason,
      now,
    );
    return null;
  },
});
export const deactivate = mutation({
  args: {
    routeId: v.id("routes"),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { route, identity } = await routeWrite(
      ctx,
      args.routeId,
      args.effectiveTo,
    );
    if (
      route.effectiveFrom >= args.effectiveTo ||
      route.effectiveTo !== undefined
    )
      throw new ConvexError("Route already ends");
    const rows = await routeTerritories(ctx, route._id),
      last = rows.at(-1);
    if (!last || last.effectiveFrom >= args.effectiveTo)
      throw new ConvexError("Invalid route end");
    const stops = await ctx.db
      .query("outletAssignments")
      .withIndex("by_routeId_and_effectiveFrom", (q) =>
        q.eq("routeId", route._id),
      )
      .take(MAX_ROUTE_HISTORY + 1);
    if (
      stops.length > MAX_ROUTE_HISTORY ||
      stops.some(
        (row) =>
          row.effectiveFrom >= args.effectiveTo ||
          row.effectiveTo === undefined ||
          row.effectiveTo > args.effectiveTo,
      )
    )
      throw new ConvexError("Route has dependent stops");
    const reason = required(args.reason, "Reason"),
      now = Date.now();
    for (const row of await routeSalespeople(ctx, route._id)) {
      if (row.effectiveFrom >= args.effectiveTo)
        throw new ConvexError(
          "Future salesperson assignment conflicts with deactivation",
        );
      if (row.effectiveTo === undefined || row.effectiveTo > args.effectiveTo) {
        const person = await ctx.db.get(row.profileId);
        if (!person?.orgUnitId)
          throw new ConvexError("Salesperson has no unit");
        await requireCapability(ctx, "route.manage", person.orgUnitId);
        await ctx.db.patch(row._id, { effectiveTo: args.effectiveTo });
      }
    }
    await ctx.db.patch(last._id, { effectiveTo: args.effectiveTo });
    await ctx.db.patch(route._id, {
      effectiveTo: args.effectiveTo,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      args.effectiveTo,
      internal.territories.routes.applyProjection,
      { routeId: route._id },
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "route.deactivated",
      "route",
      route._id,
      reason,
      now,
    );
    return null;
  },
});
export const duplicateTemplate = mutation({
  args: {
    routeId: v.id("routes"),
    territoryId: v.id("territories"),
    code: v.string(),
    name: v.string(),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.id("routes"),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    const { route } = await requireRoute(ctx, "route.manage", args.routeId);
    const owner = await ownerForWrite(
      ctx,
      args.territoryId,
      args.effectiveFrom,
    );
    await requireTerritoryCapability(ctx, "route.manage", args.territoryId);
    const code = normalizeCode(args.code),
      reason = required(args.reason, "Reason");
    await uniqueCode(ctx, code, args.territoryId);
    const { identity } = await requireCapability(
      ctx,
      "route.manage",
      owner.orgUnitId,
    );
    const now = Date.now();
    const id = await ctx.db.insert("routes", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      code,
      name: required(args.name, "Name"),
      status: "active",
      effectiveFrom: args.effectiveFrom,
      weekdayTemplate: route.weekdayTemplate,
      cycleDays: route.cycleDays,
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("routeTerritories", {
      routeId: id,
      territoryId: args.territoryId,
      effectiveFrom: args.effectiveFrom,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "route.template_duplicated",
      "route",
      id,
      reason,
      now,
    );
    return id;
  },
});
export const assignSalesperson = mutation({
  args: {
    routeId: v.id("routes"),
    profileId: v.id("profiles"),
    primary: v.boolean(),
    effectiveFrom: v.number(),
    effectiveTo: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.id("routeSalespeople"),
  handler: async (ctx, args) => {
    interval(args.effectiveFrom, args.effectiveTo);
    const { route, association, identity } = await routeWrite(
      ctx,
      args.routeId,
      args.effectiveFrom,
    );
    if (
      (route.effectiveTo !== undefined &&
        (args.effectiveTo === undefined ||
          args.effectiveTo > route.effectiveTo)) ||
      (association.effectiveTo !== undefined &&
        (args.effectiveTo === undefined ||
          args.effectiveTo > association.effectiveTo))
    )
      throw new ConvexError("Assignment crosses route territory interval");
    const owner = await ownerForWrite(
      ctx,
      association.territoryId,
      args.effectiveFrom,
      args.effectiveTo,
    );
    await assertRoutePerson(
      ctx,
      args.profileId,
      owner.orgUnitId,
      args.effectiveFrom,
      args.effectiveTo,
    );
    if (
      (await routeSalespeople(ctx, route._id)).some(
        (row) =>
          overlaps(row, args.effectiveFrom, args.effectiveTo) &&
          (row.profileId === args.profileId || (row.primary && args.primary)),
      )
    )
      throw new ConvexError("Overlapping route salesperson assignment");
    const reason = required(args.reason, "Reason"),
      now = Date.now();
    const id = await ctx.db.insert("routeSalespeople", {
      routeId: route._id,
      profileId: args.profileId,
      primary: args.primary,
      effectiveFrom: args.effectiveFrom,
      effectiveTo: args.effectiveTo,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "route.salesperson_assigned",
      "routeSalesperson",
      id,
      reason,
      now,
    );
    return id;
  },
});
export const endSalespersonAssignment = mutation({
  args: {
    assignmentId: v.id("routeSalespeople"),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    prospective(args.effectiveTo);
    const row = await ctx.db.get(args.assignmentId);
    if (!row) throw new ConvexError("Assignment not found");
    const { identity } = await requireRoute(ctx, "route.manage", row.routeId);
    const { association } = await routeAt(
      ctx,
      row.routeId,
      args.effectiveTo - 1,
    );
    if (!association) throw new ConvexError("Route territory missing");
    await ownerForWrite(
      ctx,
      association.territoryId,
      args.effectiveTo - 1,
      args.effectiveTo,
    );
    const person = await ctx.db.get(row.profileId);
    if (!person?.orgUnitId) throw new ConvexError("Salesperson has no unit");
    await requireCapability(ctx, "route.manage", person.orgUnitId);
    if (
      args.effectiveTo <= row.effectiveFrom ||
      (row.effectiveTo !== undefined && row.effectiveTo <= args.effectiveTo)
    )
      throw new ConvexError("Invalid assignment end");
    const reason = required(args.reason, "Reason"),
      now = Date.now();
    await ctx.db.patch(row._id, { effectiveTo: args.effectiveTo });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "route.salesperson_ended",
      "routeSalesperson",
      row._id,
      reason,
      now,
    );
    return null;
  },
});
export const applyProjection = internalMutation({
  args: { routeId: v.id("routes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const route = await ctx.db.get(args.routeId);
    if (route?.effectiveTo !== undefined && route.effectiveTo <= Date.now())
      await ctx.db.patch(route._id, {
        status: "inactive",
        updatedAt: Date.now(),
      });
    return null;
  },
});
