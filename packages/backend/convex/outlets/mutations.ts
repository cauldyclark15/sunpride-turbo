import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { activeAt, audit, normalizeCode, prospective } from "../org/validation";
import { assertActiveUnit } from "../territories/validation";
import {
  assertActiveOutlet,
  currentRow,
  outletRows,
  required,
  requireOutletCapability,
  validateProfile,
} from "./validation";

const profileFields = {
  name: v.string(),
  channel: v.optional(v.string()),
  subchannel: v.optional(v.string()),
  classification: v.optional(v.string()),
  address: v.optional(v.string()),
  directions: v.optional(v.string()),
  contacts: v.optional(
    v.array(v.object({ name: v.string(), phone: v.optional(v.string()) })),
  ),
  salesPotential: v.optional(v.number()),
  preferredWeekday: v.optional(v.number()),
  visitFrequencyDays: v.optional(v.number()),
  visitWindow: v.optional(v.string()),
};

export const create = mutation({
  args: {
    code: v.string(),
    custodianOrgUnitId: v.id("orgUnits"),
    status: v.union(v.literal("prospect"), v.literal("active")),
    ...profileFields,
    reason: v.string(),
  },
  returns: v.id("outlets"),
  handler: async (ctx, args) => {
    const { identity } = await requireCapability(
      ctx,
      "outlet.manage",
      args.custodianOrgUnitId,
    );
    await assertActiveUnit(ctx, args.custodianOrgUnitId, Date.now());
    const code = normalizeCode(args.code);
    if (
      await ctx.db
        .query("outlets")
        .withIndex("by_organizationId_and_code", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
        )
        .first()
    )
      throw new ConvexError("Duplicate outlet code");
    validateProfile(args);
    required(args.reason, "Reason");
    const now = Date.now();
    const id = await ctx.db.insert("outlets", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      code,
      name: args.name.trim(),
      status: args.status,
      custodianOrgUnitId: args.custodianOrgUnitId,
      channel: args.channel?.trim(),
      subchannel: args.subchannel?.trim(),
      classification: args.classification?.trim(),
      address: args.address?.trim(),
      directions: args.directions?.trim(),
      contacts: args.contacts,
      salesPotential: args.salesPotential,
      preferredWeekday: args.preferredWeekday,
      visitFrequencyDays: args.visitFrequencyDays,
      visitWindow: args.visitWindow?.trim(),
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "outlet.created",
      "outlet",
      id,
      "Operational outlet created",
      now,
    );
    return id;
  },
});

export const edit = mutation({
  args: {
    outletId: v.id("outlets"),
    status: v.union(v.literal("prospect"), v.literal("active")),
    ...profileFields,
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { outlet, identity } = await requireOutletCapability(
      ctx,
      "outlet.manage",
      args.outletId,
    );
    assertActiveOutlet(outlet);
    validateProfile(args);
    required(args.reason, "Reason");
    const now = Date.now();
    await ctx.db.patch(outlet._id, {
      name: args.name.trim(),
      status: args.status,
      channel: args.channel?.trim(),
      subchannel: args.subchannel?.trim(),
      classification: args.classification?.trim(),
      address: args.address?.trim(),
      directions: args.directions?.trim(),
      contacts: args.contacts,
      salesPotential: args.salesPotential,
      preferredWeekday: args.preferredWeekday,
      visitFrequencyDays: args.visitFrequencyDays,
      visitWindow: args.visitWindow?.trim(),
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "outlet.edited",
      "outlet",
      outlet._id,
      "Operational profile edited",
      now,
    );
    return null;
  },
});

export const changeCustomerLink = mutation({
  args: {
    outletId: v.id("outlets"),
    customerId: v.optional(v.id("customers")),
    source: v.string(),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    const { outlet, identity } = await requireOutletCapability(
      ctx,
      "outlet.manage",
      args.outletId,
    );
    assertActiveOutlet(outlet);
    const reason = required(args.reason, "Reason");
    const source = required(args.source, "Source", 100);
    if (args.customerId) {
      const customer = await ctx.db.get(args.customerId);
      if (!customer || !customer.active)
        throw new ConvexError("Customer not active");
    }
    const rows = await outletRows(ctx, "outletCustomerLinks", outlet._id);
    const previous = currentRow(rows, args.effectiveFrom);
    if (
      rows.some((row) => row.effectiveFrom >= args.effectiveFrom) ||
      (previous &&
        (previous.customerId === args.customerId ||
          previous.effectiveFrom >= args.effectiveFrom)) ||
      (!previous &&
        rows.some(
          (row) =>
            row.effectiveTo === undefined ||
            row.effectiveTo > args.effectiveFrom,
        ))
    )
      throw new ConvexError("Invalid customer link transition");
    if (!previous && !args.customerId)
      throw new ConvexError("No customer link to remove");
    const now = Date.now();
    if (previous)
      await ctx.db.patch(previous._id, { effectiveTo: args.effectiveFrom });
    if (args.customerId)
      await ctx.db.insert("outletCustomerLinks", {
        outletId: outlet._id,
        customerId: args.customerId,
        source,
        effectiveFrom: args.effectiveFrom,
        actorSubject: identity.tokenIdentifier,
        reason,
        createdAt: now,
      });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "outlet.customer_link_changed",
      "outlet",
      outlet._id,
      "Customer link changed",
      now,
    );
    return null;
  },
});

export const deactivate = mutation({
  args: { outletId: v.id("outlets"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { outlet, identity } = await requireOutletCapability(
      ctx,
      "outlet.manage",
      args.outletId,
    );
    assertActiveOutlet(outlet);
    required(args.reason, "Reason");
    const now = Date.now();
    const links = await outletRows(ctx, "outletCustomerLinks", outlet._id);
    const pins = await outletRows(ctx, "outletPins", outlet._id);
    const assignments = await outletRows(ctx, "outletAssignments", outlet._id);
    if (
      [...links, ...pins, ...assignments].some(
        (row) =>
          row.effectiveFrom > now ||
          (row.effectiveTo !== undefined && row.effectiveTo > now),
      )
    )
      throw new ConvexError("Future outlet history must be resolved first");
    if (
      assignments.some((row) =>
        activeAt(row.effectiveFrom, row.effectiveTo, now),
      )
    )
      throw new ConvexError("End territory assignment before deactivation");
    if (pins.some((pin) => pin.status === "pending"))
      throw new ConvexError("Review pending pins before deactivation");
    const link = currentRow(links, now);
    if (link) await ctx.db.patch(link._id, { effectiveTo: now });
    for (const pin of pins) {
      if (
        pin.status === "verified" &&
        activeAt(pin.effectiveFrom, pin.effectiveTo, now)
      )
        await ctx.db.patch(pin._id, { effectiveTo: now });
    }
    await ctx.db.patch(outlet._id, { status: "inactive", updatedAt: now });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "outlet.deactivated",
      "outlet",
      outlet._id,
      "Outlet deactivated",
      now,
    );
    return null;
  },
});
