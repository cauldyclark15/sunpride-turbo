import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { activeAt } from "../org/validation";
import schema from "../schema";
import { teamMemberships } from "./validation";

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("teams")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "people.read");
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 100)
      throw new ConvexError("Page size must be 1–100");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : profile.orgUnitId
          ? new Set(await collectScopeUnitIds(ctx, profile.orgUnitId))
          : new Set();
    const result = await ctx.db.query("teams").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.filter((team) => !scope || scope.has(team.orgUnitId)),
    };
  },
});

export const detail = query({
  args: { teamId: v.id("teams") },
  returns: v.object({
    team: schema.doc("teams"),
    members: v.array(
      v.object({
        membership: schema.doc("teamMemberships"),
        profile: schema.doc("profiles"),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new ConvexError("Team not found");
    await requireCapability(ctx, "people.read", team.orgUnitId);
    const now = Date.now();
    const members = [];
    if (
      team.status === "active" &&
      activeAt(team.effectiveFrom, team.effectiveTo, now)
    ) {
      const teamScope = new Set(await collectScopeUnitIds(ctx, team.orgUnitId));
      for (const membership of await teamMemberships(ctx, team._id)) {
        if (!activeAt(membership.effectiveFrom, membership.effectiveTo, now))
          continue;
        const profile = await ctx.db.get(membership.profileId);
        // A later reassignment must not leak an out-of-scope profile via an old membership.
        if (
          profile?.status === "active" &&
          profile.orgUnitId &&
          teamScope.has(profile.orgUnitId)
        )
          members.push({ membership, profile });
      }
    }
    return { team, members };
  },
});

export const memberHistory = query({
  args: { teamId: v.id("teams"), profileId: v.id("profiles") },
  returns: v.array(schema.doc("teamMemberships")),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team) throw new ConvexError("Team not found");
    await requireCapability(ctx, "people.read", team.orgUnitId);
    const person = await ctx.db.get(args.profileId);
    if (!person) throw new ConvexError("Profile not found");
    if (person.orgUnitId)
      await requireCapability(ctx, "people.read", person.orgUnitId);
    else {
      const { profile } = await requireCapability(ctx, "people.read");
      if (profile.role !== "super_admin")
        throw new ConvexError(
          "Requested scope is outside your organizational scope",
        );
    }
    return (await teamMemberships(ctx, team._id)).filter(
      (membership) => membership.profileId === args.profileId,
    );
  },
});
