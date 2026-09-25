import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt, interval } from "../org/validation";
import schema from "../schema";
import {
  MAX_TERRITORY_HISTORY,
  ownerships,
  requireTerritoryCapability,
  resolveTerritoryOwnerAt,
} from "./validation";

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    asOf: v.optional(v.number()),
  },
  returns: paginationResultValidator(schema.doc("territories")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "territory.read");
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      throw new ConvexError("Page size must be 1–100");
    const at = args.asOf ?? Date.now();
    interval(at);
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const result = await ctx.db
      .query("territories")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(args.paginationOpts);
    const page = [];
    for (const territory of result.page) {
      if (!activeAt(territory.effectiveFrom, territory.effectiveTo, at))
        continue;
      const current = await resolveTerritoryOwnerAt(
        ctx,
        territory._id,
        Date.now(),
      );
      const last =
        !current &&
        territory.effectiveTo !== undefined &&
        territory.effectiveTo <= Date.now()
          ? (await ownerships(ctx, territory._id)).at(-1)
          : undefined;
      const boundary = current ?? last;
      if (!boundary || (scope && !scope.has(boundary.orgUnitId))) continue;
      const owner = await resolveTerritoryOwnerAt(ctx, territory._id, at);
      if (owner) page.push(territory);
    }
    return { ...result, page };
  },
});

export const detail = query({
  args: { territoryId: v.id("territories"), asOf: v.optional(v.number()) },
  returns: v.object({
    territory: schema.doc("territories"),
    owner: v.union(schema.doc("territoryOwnerships"), v.null()),
  }),
  handler: async (ctx, args) => {
    const { territory, owner } = await requireTerritoryCapability(
      ctx,
      "territory.read",
      args.territoryId,
      args.asOf,
    );
    return { territory, owner };
  },
});

export const ownershipHistory = query({
  args: { territoryId: v.id("territories") },
  returns: v.array(schema.doc("territoryOwnerships")),
  handler: async (ctx, args) => {
    const { profile } = await requireTerritoryCapability(
      ctx,
      "territory.read",
      args.territoryId,
    );
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    return (await ownerships(ctx, args.territoryId)).filter(
      (row) => !scope || scope.has(row.orgUnitId),
    );
  },
});

export const salespeopleAt = query({
  args: { territoryId: v.id("territories"), asOf: v.number() },
  returns: v.array(schema.doc("territorySalespeople")),
  handler: async (ctx, args) => {
    interval(args.asOf);
    const { profile } = await requireTerritoryCapability(
      ctx,
      "territory.read",
      args.territoryId,
      args.asOf,
    );
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const rows = await ctx.db
      .query("territorySalespeople")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", args.territoryId).lte("effectiveFrom", args.asOf),
      )
      .take(MAX_TERRITORY_HISTORY + 1);
    if (rows.length > MAX_TERRITORY_HISTORY)
      throw new ConvexError("Territory assignments exceed limit");
    const visible = [];
    for (const row of rows) {
      if (!activeAt(row.effectiveFrom, row.effectiveTo, args.asOf)) continue;
      const person = await ctx.db.get(row.profileId);
      if (person?.orgUnitId && (!scope || scope.has(person.orgUnitId)))
        visible.push(row);
    }
    return visible;
  },
});
