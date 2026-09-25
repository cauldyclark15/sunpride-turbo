import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { activeAt, audit, interval } from "../org/validation";
import {
  assertActiveOutlet,
  DEFAULT_RADIUS_METERS,
  outletRows,
  required,
  requireOutletCapability,
  validatePin,
} from "./validation";

export const propose = mutation({
  args: {
    outletId: v.id("outlets"),
    latitude: v.number(),
    longitude: v.number(),
    radiusMeters: v.optional(v.number()),
    source: v.string(),
    evidenceStorageId: v.optional(v.id("_storage")),
    evidenceNote: v.optional(v.string()),
    effectiveFrom: v.optional(v.number()),
    reason: v.string(),
  },
  returns: v.id("outletPins"),
  handler: async (ctx, args) => {
    const { outlet, identity } = await requireOutletCapability(
      ctx,
      "outlet.manage",
      args.outletId,
    );
    assertActiveOutlet(outlet);
    const now = Date.now();
    const from = args.effectiveFrom ?? now;
    interval(from);
    if (from < now) throw new ConvexError("Changes must be future-effective");
    validatePin(
      args.latitude,
      args.longitude,
      args.radiusMeters ?? DEFAULT_RADIUS_METERS,
    );
    const source = required(args.source, "Source", 100);
    const proposalReason = required(args.reason, "Reason", 500);
    if (args.evidenceNote && args.evidenceNote.length > 500)
      throw new ConvexError("Evidence note too long");
    if (
      args.evidenceStorageId &&
      !(await ctx.db.system.get(args.evidenceStorageId))
    )
      throw new ConvexError("Evidence attachment not found");
    const id = await ctx.db.insert("outletPins", {
      outletId: outlet._id,
      latitude: args.latitude,
      longitude: args.longitude,
      radiusMeters: args.radiusMeters ?? DEFAULT_RADIUS_METERS,
      source,
      evidenceStorageId: args.evidenceStorageId,
      // No proposal-reason column exists in slice A: retain it with restricted pin evidence, never generic audit.
      evidenceNote: `${args.evidenceNote?.trim() ? `${args.evidenceNote.trim()} · ` : ""}Proposal reason: ${proposalReason}`,
      status: "pending",
      effectiveFrom: from,
      proposedBy: identity.tokenIdentifier,
      proposedAt: now,
      createdAt: now,
    });
    // Generic audit details never contain coordinates, evidence text, or caller-supplied reason.
    await audit(
      ctx,
      identity.tokenIdentifier,
      "outlet.pin_proposed",
      "outletPin",
      id,
      "Pin proposed",
      now,
    );
    return id;
  },
});

export const decide = mutation({
  args: {
    pinId: v.id("outletPins"),
    decision: v.union(v.literal("verified"), v.literal("rejected")),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pin = await ctx.db.get(args.pinId);
    if (!pin) throw new ConvexError("Pin not found");
    const { outlet, identity } = await requireOutletCapability(
      ctx,
      "outlet.verify",
      pin.outletId,
    );
    assertActiveOutlet(outlet);
    if (pin.status !== "pending") throw new ConvexError("Pin already reviewed");
    if (pin.proposedBy === identity.tokenIdentifier)
      throw new ConvexError("Independent verifier required");
    const reason = required(args.reason, "Review reason", 500);
    const now = Date.now();
    if (args.decision === "verified") {
      const rows = await outletRows(ctx, "outletPins", pin.outletId);
      const from = Math.max(
        pin.effectiveFrom,
        now,
        ...rows
          .filter(
            (row) => row.status === "verified" && row.effectiveFrom <= now,
          )
          .map((row) => row.effectiveFrom + 1),
      );
      // A future verified version cannot be overwritten or made to overlap by a late review.
      if (
        rows.some(
          (row) =>
            row._id !== pin._id &&
            row.status === "verified" &&
            row.effectiveFrom >= from,
        )
      )
        throw new ConvexError("Future verified pin conflicts with proposal");
      const previous = rows.filter(
        (row) =>
          row.status === "verified" &&
          activeAt(row.effectiveFrom, row.effectiveTo, from),
      );
      if (previous.length > 1)
        throw new ConvexError("Overlapping verified pins");
      if (previous[0])
        await ctx.db.patch(previous[0]._id, { effectiveTo: from });
      await ctx.db.patch(pin._id, {
        status: "verified",
        effectiveFrom: from,
        verifiedBy: identity.tokenIdentifier,
        verifiedAt: now,
        reviewerReason: reason,
      });
    } else {
      await ctx.db.patch(pin._id, {
        status: "rejected",
        effectiveTo: Math.max(pin.effectiveFrom + 1, now),
        verifiedBy: identity.tokenIdentifier,
        verifiedAt: now,
        reviewerReason: reason,
      });
    }
    await audit(
      ctx,
      identity.tokenIdentifier,
      `outlet.pin_${args.decision}`,
      "outletPin",
      pin._id,
      "Pin reviewed",
      now,
    );
    return null;
  },
});
