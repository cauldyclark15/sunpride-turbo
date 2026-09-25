import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { activeAt, interval } from "../org/validation";
import schema from "../schema";
import {
  currentRow,
  outletRows,
  requireOutletCapability,
  resolveOutletScopeAt,
} from "./validation";

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    asOf: v.optional(v.number()),
  },
  returns: paginationResultValidator(schema.doc("outlets")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "outlet.read");
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 100
    )
      throw new ConvexError("Page size must be 1–100");
    const now = Date.now();
    const at = args.asOf ?? now;
    interval(at);
    const allowed =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const salesTerritories = new Set<Id<"territories">>();
    if (profile.role === "sales") {
      const assigned = await ctx.db
        .query("territorySalespeople")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profile._id).lte("effectiveFrom", now),
        )
        .take(501);
      if (assigned.length > 500)
        throw new ConvexError("Salesperson assignments exceed limit");
      for (const row of assigned)
        if (activeAt(row.effectiveFrom, row.effectiveTo, now))
          salesTerritories.add(row.territoryId);
    }
    const result = await ctx.db
      .query("outlets")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(args.paginationOpts);
    const page = [];
    for (const outlet of result.page) {
      const current = await resolveOutletScopeAt(ctx, outlet._id, now);
      if (allowed && !allowed.has(current.orgUnitId)) continue;
      if (
        profile.role === "sales" &&
        current.assignment &&
        !salesTerritories.has(current.assignment.territoryId)
      )
        continue;
      // Historical preview must not change the current authorization boundary.
      await resolveOutletScopeAt(ctx, outlet._id, at);
      page.push(outlet);
    }
    return { ...result, page };
  },
});

export const detail = query({
  args: { outletId: v.id("outlets"), asOf: v.optional(v.number()) },
  returns: v.object({
    outlet: schema.doc("outlets"),
    assignment: v.union(schema.doc("outletAssignments"), v.null()),
    customerLink: v.union(schema.doc("outletCustomerLinks"), v.null()),
    pin: v.union(schema.doc("outletPins"), v.null()),
  }),
  handler: async (ctx, args) => {
    const { outlet } = await requireOutletCapability(
      ctx,
      "outlet.read",
      args.outletId,
    );
    const at = args.asOf ?? Date.now();
    interval(at);
    const customerLink = currentRow(
      await outletRows(ctx, "outletCustomerLinks", args.outletId),
      at,
    );
    const pins = (await outletRows(ctx, "outletPins", args.outletId)).filter(
      (pin) => pin.status === "verified",
    );
    const pin = currentRow(pins, at);
    const assignment = currentRow(
      await outletRows(ctx, "outletAssignments", args.outletId),
      at,
    );
    return { outlet, assignment, customerLink, pin };
  },
});

export const customerHistory = query({
  args: { outletId: v.id("outlets") },
  returns: v.array(schema.doc("outletCustomerLinks")),
  handler: async (ctx, args) => {
    await requireOutletCapability(ctx, "outlet.read", args.outletId);
    return outletRows(ctx, "outletCustomerLinks", args.outletId);
  },
});

export const pinHistory = query({
  args: { outletId: v.id("outlets") },
  returns: v.array(schema.doc("outletPins")),
  handler: async (ctx, args) => {
    await requireOutletCapability(ctx, "outlet.read", args.outletId);
    return outletRows(ctx, "outletPins", args.outletId);
  },
});
