import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { requireActiveProfile } from "../lib/auth";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { audit } from "../org/validation";
import { at } from "../territories/route_validation";
import schema from "../schema";
import {
  MAX_PLAN_ROWS,
  bounded,
  localDate,
  manilaDate,
  required,
} from "./validation";

const DAY = 86_400_000;
const MAX_AWAY_DAYS = 92;
const awayDoc = schema.doc("supervisorAwayPeriods");

type Ctx = QueryCtx | MutationCtx;

async function currentSupervisorOf(ctx: Ctx, profileId: Id<"profiles">) {
  const rows = await bounded(
    ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", profileId),
      )
      .take(MAX_PLAN_ROWS + 1),
    "Employee assignment history",
  );
  return at(rows, Date.now());
}

/**
 * The supervisor records their own leave; their own manager, or a people administrator
 * over their unit, may record it for them (e.g. sudden sick leave).
 */
async function authorizeFor(ctx: MutationCtx, target: Doc<"profiles">) {
  const { identity, profile } = await requireActiveProfile(ctx);
  if (!capabilityRoles("mcp.approve").includes(target.role as AppRole))
    throw new ConvexError("Away periods apply only to MCP approvers");
  if (profile._id === target._id) return identity;
  const assignment = await currentSupervisorOf(ctx, target._id);
  if (assignment?.supervisorId === profile._id) return identity;
  const unit = assignment?.orgUnitId ?? target.orgUnitId;
  if (!unit)
    throw new ConvexError("Only the supervisor or their manager can do this");
  await requireCapability(ctx, "admin.manage", unit);
  return identity;
}

export const record = mutation({
  args: {
    profileId: v.id("profiles"),
    fromDate: v.string(),
    toDate: v.string(),
    reason: v.string(),
  },
  returns: awayDoc,
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.profileId);
    if (!target || target.status !== "active")
      throw new ConvexError("Active supervisor required");
    const identity = await authorizeFor(ctx, target);
    const reason = required(args.reason, "Away reason");
    const now = Date.now();
    const from = localDate(args.fromDate);
    const to = localDate(args.toDate) + DAY;
    if (to <= from) throw new ConvexError("Away end must be on or after start");
    if (from < localDate(manilaDate(now)))
      throw new ConvexError("Away period cannot be backdated");
    if (to - from > MAX_AWAY_DAYS * DAY)
      throw new ConvexError(`Away period is limited to ${MAX_AWAY_DAYS} days`);
    const earlier = await ctx.db
      .query("supervisorAwayPeriods")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", target._id).lt("effectiveFrom", to),
      )
      .order("desc")
      .take(MAX_PLAN_ROWS + 1);
    if (
      earlier.some(
        (row) => row.effectiveTo > from && row.effectiveTo > row.effectiveFrom,
      )
    )
      throw new ConvexError("Overlaps an existing away period");
    const id = await ctx.db.insert("supervisorAwayPeriods", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      profileId: target._id,
      effectiveFrom: from,
      effectiveTo: to,
      reason,
      recordedBy: identity.tokenIdentifier,
      recordedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "supervisor.away.recorded",
      "supervisorAwayPeriod",
      id,
      reason,
      now,
    );
    return (await ctx.db.get(id))!;
  },
});

/** Ends a period now (or cancels a future one as a zero-length row); never deletes. */
export const end = mutation({
  args: { awayId: v.id("supervisorAwayPeriods") },
  returns: awayDoc,
  handler: async (ctx, { awayId }) => {
    const row = await ctx.db.get(awayId);
    if (!row) throw new ConvexError("Away period not found");
    const target = await ctx.db.get(row.profileId);
    if (!target) throw new ConvexError("Supervisor not found");
    const identity = await authorizeFor(ctx, target);
    const now = Date.now();
    if (row.effectiveTo <= now || row.effectiveTo === row.effectiveFrom)
      throw new ConvexError("Away period already ended");
    await ctx.db.patch(awayId, {
      effectiveTo: Math.max(row.effectiveFrom, now),
      endedBy: identity.tokenIdentifier,
      endedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "supervisor.away.ended",
      "supervisorAwayPeriod",
      awayId,
      "ended",
      now,
    );
    return (await ctx.db.get(awayId))!;
  },
});

/** Current and upcoming away periods for a person (self, or within MCP read scope). */
export const list = query({
  args: { profileId: v.id("profiles"), asOf: v.number() },
  returns: v.array(awayDoc),
  handler: async (ctx, { profileId, asOf }) => {
    const { profile } = await requireActiveProfile(ctx);
    if (profile._id !== profileId) {
      const target = await ctx.db.get(profileId);
      if (!target?.orgUnitId) throw new ConvexError("Supervisor not found");
      await requireCapability(ctx, "mcp.read", target.orgUnitId);
    }
    const rows = await ctx.db
      .query("supervisorAwayPeriods")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", profileId),
      )
      .order("desc")
      .take(50);
    return rows
      .filter(
        (row) => row.effectiveTo > asOf && row.effectiveTo > row.effectiveFrom,
      )
      .reverse();
  },
});
