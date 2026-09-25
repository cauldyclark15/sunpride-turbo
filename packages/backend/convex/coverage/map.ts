import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { outletRows, resolveOutletScopeAt } from "../outlets/validation";
import { at } from "../territories/route_validation";
import { planAccess, planRows } from "./validation";

const row = v.object({
  outletId: v.id("outlets"),
  outletCode: v.string(),
  outletName: v.string(),
  territoryId: v.optional(v.id("territories")),
  routeId: v.optional(v.id("routes")),
  sequence: v.optional(v.number()),
  inPlan: v.boolean(),
  assigned: v.boolean(),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  pinStatus: v.union(v.literal("verified"), v.literal("unmapped")),
});
export const forPlan = query({
  args: {
    planId: v.id("coveragePlans"),
    territoryId: v.optional(v.id("territories")),
    routeId: v.optional(v.id("routes")),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(row),
  handler: async (ctx, { planId, territoryId, routeId, paginationOpts }) => {
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 20
    )
      throw new ConvexError("Page size must be 1–20");
    const plan = await ctx.db.get(planId);
    if (!plan) throw new ConvexError("Plan not found");
    await planAccess(ctx, plan, "mcp.read");
    const { outlets, slots } = await planRows(ctx, planId);
    for (const id of new Set<Id<"outlets">>([
      ...outlets.map((o) => o.outletId),
      ...slots.flatMap((s) => (s.outletId ? [s.outletId] : [])),
    ])) {
      const current = await resolveOutletScopeAt(ctx, id, Date.now());
      await requireCapability(ctx, "mcp.read", current.orgUnitId);
    }
    const planned = new Map(outlets.map((o) => [o.outletId, o]));
    const allowedTerritories = new Set<Id<"territories">>([
      ...plan.territoryIds,
      ...outlets.map((o) => o.territoryId),
      ...slots.flatMap((s) =>
        s.approvedSnapshot ? [s.approvedSnapshot.territoryId] : [],
      ),
    ]);
    // A draft may contain slots without coveragePlanOutlets; derive only from scoped persisted owners.
    for (const slot of slots)
      if (slot.outletId && !slot.approvedSnapshot) {
        const current = await resolveOutletScopeAt(
          ctx,
          slot.outletId,
          Date.now(),
        );
        if (current.assignment)
          allowedTerritories.add(current.assignment.territoryId);
      }
    // A filter cannot grant access to a territory absent from this persisted plan.
    if (territoryId && !allowedTerritories.has(territoryId))
      throw new ConvexError("Territory not in plan");
    const roster = await ctx.db
      .query("outlets")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(paginationOpts);
    const page = [];
    const now = Date.now();
    for (const outlet of roster.page) {
      const current = await resolveOutletScopeAt(ctx, outlet._id, now);
      const membership = planned.get(outlet._id);
      const signed = slots.filter(
        (s) => s.outletId === outlet._id && s.approvedSnapshot,
      );
      const first = signed.length
        ? signed.sort(
            (a, b) =>
              a.serviceDate.localeCompare(b.serviceDate) ||
              a.sequence - b.sequence,
          )[0]
        : undefined;
      const planSlot = slots.some((s) => s.outletId === outlet._id);
      const displayedTerritory = first?.approvedSnapshot
        ? first.approvedSnapshot.territoryId
        : (membership?.territoryId ?? current.assignment?.territoryId);
      const displayedRoute = first?.approvedSnapshot
        ? first.approvedSnapshot.routeId
        : (membership?.routeId ?? current.assignment?.routeId);
      if (
        current.assignment &&
        !allowedTerritories.has(current.assignment.territoryId) &&
        !membership &&
        !planSlot
      )
        continue;
      if (
        !current.assignment &&
        !membership &&
        !planSlot &&
        (territoryId || routeId || current.orgUnitId !== plan.orgUnitId)
      )
        continue;
      if (territoryId && displayedTerritory !== territoryId) continue;
      if (routeId && displayedRoute !== routeId) continue;
      // Candidate rosters may span units. Skip hidden rows before touching their pins or metadata.
      try {
        await requireCapability(ctx, "mcp.read", current.orgUnitId);
      } catch {
        continue;
      }
      const pins = await outletRows(ctx, "outletPins", outlet._id);
      const pin = at(
        pins.filter((p) => p.status === "verified"),
        now,
      );
      page.push({
        outletId: outlet._id,
        outletCode: first?.approvedSnapshot?.outletCode ?? outlet.code,
        outletName: first?.approvedSnapshot?.outletName ?? outlet.name,
        territoryId: displayedTerritory,
        routeId: displayedRoute,
        sequence:
          first?.approvedSnapshot?.sequence ??
          membership?.sequence ??
          current.assignment?.sequence,
        inPlan: !!membership || slots.some((s) => s.outletId === outlet._id),
        assigned: !!current.assignment,
        ...(pin ? { latitude: pin.latitude, longitude: pin.longitude } : {}),
        pinStatus: pin ? ("verified" as const) : ("unmapped" as const),
      });
    }
    return { ...roster, page };
  },
});
