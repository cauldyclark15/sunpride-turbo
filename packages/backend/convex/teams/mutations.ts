import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, mutation } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { audit, normalizeCode, prospective } from "../org/validation";
import {
  activeTeam,
  activeUnit,
  assertSupervisor,
  required,
  teamMemberships,
} from "./validation";

export const create = mutation({
  args: {
    code: v.string(),
    name: v.string(),
    orgUnitId: v.id("orgUnits"),
    supervisorProfileId: v.optional(v.id("profiles")),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.id("teams"),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      args.orgUnitId,
    );
    await activeUnit(ctx, args.orgUnitId, args.effectiveFrom);
    const code = normalizeCode(args.code);
    if (
      await ctx.db
        .query("teams")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first()
    )
      throw new ConvexError("Duplicate team code");
    if (args.supervisorProfileId)
      await assertSupervisor(ctx, args.supervisorProfileId, args.orgUnitId);
    const name = required(args.name, "Name");
    const reason = required(args.reason, "Reason");
    const now = Date.now();
    const teamId = await ctx.db.insert("teams", {
      code,
      name,
      orgUnitId: args.orgUnitId,
      status: "active",
      supervisorProfileId: args.supervisorProfileId,
      effectiveFrom: args.effectiveFrom,
      createdAt: now,
      updatedAt: now,
      createdBy: identity.tokenIdentifier,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "team.created",
      "team",
      teamId,
      reason,
      now,
    );
    return teamId;
  },
});

export const edit = mutation({
  args: {
    teamId: v.id("teams"),
    name: v.string(),
    supervisorProfileId: v.optional(v.union(v.id("profiles"), v.null())),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new ConvexError("Team not found");
    if (
      team.status !== "active" ||
      (team.effectiveTo !== undefined && team.effectiveTo <= Date.now())
    )
      throw new ConvexError("Team is inactive");
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      team.orgUnitId,
    );
    if (args.supervisorProfileId)
      await assertSupervisor(ctx, args.supervisorProfileId, team.orgUnitId);
    const name = required(args.name, "Name");
    const reason = required(args.reason, "Reason");
    const now = Date.now();
    await ctx.db.patch(team._id, {
      name,
      ...(args.supervisorProfileId !== undefined
        ? { supervisorProfileId: args.supervisorProfileId ?? undefined }
        : {}),
      updatedAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "team.edited",
      "team",
      team._id,
      reason,
      now,
    );
    return null;
  },
});

export const deactivate = mutation({
  args: { teamId: v.id("teams"), effectiveTo: v.number(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    prospective(args.effectiveTo);
    const team = await ctx.db.get(args.teamId);
    if (
      !team ||
      team.status !== "active" ||
      args.effectiveTo <= team.effectiveFrom ||
      team.effectiveTo !== undefined
    )
      throw new ConvexError("Team cannot be deactivated");
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      team.orgUnitId,
    );
    const reason = required(args.reason, "Reason");
    const now = Date.now();
    // Deactivation is also a prospective end for all memberships, never a deletion.
    const rows = await teamMemberships(ctx, team._id);
    for (const row of rows) {
      if (row.effectiveTo !== undefined && row.effectiveTo <= args.effectiveTo)
        continue;
      if (row.effectiveFrom >= args.effectiveTo)
        throw new ConvexError("Future membership conflicts with deactivation");
      const member = await ctx.db.get(row.profileId);
      if (!member?.orgUnitId)
        throw new ConvexError("Member has no organizational scope");
      await requireCapability(ctx, "admin.manage", member.orgUnitId);
      await ctx.db.patch(row._id, { effectiveTo: args.effectiveTo });
      await audit(
        ctx,
        identity.tokenIdentifier,
        "team.member_removed",
        "teamMembership",
        row._id,
        reason,
        now,
      );
    }
    await ctx.db.patch(team._id, {
      effectiveTo: args.effectiveTo,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(
      args.effectiveTo,
      internal.teams.mutations.applyProjection,
      {
        teamId: team._id,
      },
    );
    await audit(
      ctx,
      identity.tokenIdentifier,
      "team.deactivated",
      "team",
      team._id,
      reason,
      now,
    );
    return null;
  },
});

export const addMember = mutation({
  args: {
    teamId: v.id("teams"),
    profileId: v.id("profiles"),
    effectiveFrom: v.number(),
    reason: v.string(),
  },
  returns: v.id("teamMemberships"),
  handler: async (ctx, args) => {
    prospective(args.effectiveFrom);
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new ConvexError("Team not found");
    activeTeam(team, args.effectiveFrom);
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      team.orgUnitId,
    );
    const member = await ctx.db.get(args.profileId);
    if (!member?.orgUnitId || member.status !== "active")
      throw new ConvexError("Member has no active organizational scope");
    await requireCapability(ctx, "admin.manage", member.orgUnitId);
    await activeUnit(ctx, member.orgUnitId, Date.now());
    if (
      !(await collectScopeUnitIds(ctx, team.orgUnitId)).includes(
        member.orgUnitId,
      )
    )
      throw new ConvexError("Member outside team hierarchy");
    if (
      (await teamMemberships(ctx, team._id)).some(
        (row) =>
          row.profileId === member._id &&
          (row.effectiveTo === undefined ||
            row.effectiveTo > args.effectiveFrom),
      )
    )
      throw new ConvexError("Overlapping team membership");
    const reason = required(args.reason, "Reason");
    const now = Date.now();
    const membershipId = await ctx.db.insert("teamMemberships", {
      teamId: team._id,
      profileId: member._id,
      effectiveFrom: args.effectiveFrom,
      effectiveTo: team.effectiveTo,
      actorSubject: identity.tokenIdentifier,
      reason,
      createdAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "team.member_added",
      "teamMembership",
      membershipId,
      reason,
      now,
    );
    return membershipId;
  },
});

export const removeMember = mutation({
  args: {
    teamId: v.id("teams"),
    profileId: v.id("profiles"),
    effectiveTo: v.number(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    prospective(args.effectiveTo);
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new ConvexError("Team not found");
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      team.orgUnitId,
    );
    const member = await ctx.db.get(args.profileId);
    if (!member?.orgUnitId)
      throw new ConvexError("Member has no organizational scope");
    await requireCapability(ctx, "admin.manage", member.orgUnitId);
    const row = (await teamMemberships(ctx, team._id)).find(
      (m) =>
        m.profileId === args.profileId &&
        m.effectiveFrom < args.effectiveTo &&
        (m.effectiveTo === undefined || m.effectiveTo > args.effectiveTo),
    );
    if (!row) throw new ConvexError("No open membership at effective time");
    const reason = required(args.reason, "Reason");
    const now = Date.now();
    await ctx.db.patch(row._id, { effectiveTo: args.effectiveTo });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "team.member_removed",
      "teamMembership",
      row._id,
      reason,
      now,
    );
    return null;
  },
});

/** Scheduled legacy status projection; effectiveTo is authoritative for queries. */
export const applyProjection = internalMutation({
  args: { teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (team?.effectiveTo !== undefined && team.effectiveTo <= Date.now())
      await ctx.db.patch(team._id, {
        status: "inactive",
        updatedAt: Date.now(),
      });
    return null;
  },
});
