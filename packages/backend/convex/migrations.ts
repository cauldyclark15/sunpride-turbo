import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  ORG_ROOT_UNIT_CODE,
  SUNPRIDE_ORGANIZATION_ID,
} from "./inventory/constants";
import { BOOTSTRAP_SUPER_ADMIN_EMAIL } from "./lib/access";

const ORG_UNIT_LEVELS = [
  { code: "NATIONAL", label: "National", level: 1 },
  { code: "REGION", label: "Region", level: 2 },
  { code: "AREA", label: "Area", level: 3 },
  { code: "TERRITORY", label: "Territory", level: 4 },
] as const;

const ROOT_ORG_UNIT_CODE = ORG_ROOT_UNIT_CODE;

/**
 * Idempotent: creates the configurable level vocabulary and the root organization unit,
 * then assigns the root unit only to unscoped super admins. Other roles remain unscoped
 * until explicitly assigned. Run once per deployment
 * (`bunx convex run migrations:seedOrganizationFoundation`). Level names are data, not
 * code (ADR-005).
 */
export const seedOrganizationFoundation = internalMutation({
  args: {},
  returns: v.object({
    rootUnitId: v.id("orgUnits"),
    rootUnitCreated: v.boolean(),
    typeCount: v.number(),
    scopedProfileCount: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    let typeCount = 0;
    for (const level of ORG_UNIT_LEVELS) {
      const existing = await ctx.db
        .query("orgUnitTypes")
        .withIndex("by_organizationId_and_code", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("code", level.code),
        )
        .unique();
      if (existing) {
        if (existing.label !== level.label || existing.level !== level.level)
          await ctx.db.patch(existing._id, {
            label: level.label,
            level: level.level,
            updatedAt: now,
          });
        typeCount += 1;
        continue;
      }
      await ctx.db.insert("orgUnitTypes", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        code: level.code,
        label: level.label,
        level: level.level,
        active: true,
        updatedAt: now,
      });
      typeCount += 1;
    }

    let root = await ctx.db
      .query("orgUnits")
      .withIndex("by_organizationId_and_code", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("code", ROOT_ORG_UNIT_CODE),
      )
      .unique();
    const rootUnitCreated = root === null;
    if (!root) {
      const rootId = await ctx.db.insert("orgUnits", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        code: ROOT_ORG_UNIT_CODE,
        name: "Sunpride",
        typeCode: "NATIONAL",
        status: "active",
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
      });
      root = await ctx.db.get(rootId);
    }
    if (!root)
      throw new Error("Could not provision the root organization unit");

    let scopedProfileCount = 0;
    const profiles = await ctx.db.query("profiles").take(200);
    for (const profile of profiles) {
      if (profile.orgUnitId || profile.role !== "super_admin") continue;
      await ctx.db.patch(profile._id, {
        orgUnitId: root._id,
        effectiveFrom: profile.effectiveFrom ?? now,
        updatedAt: now,
      });
      scopedProfileCount += 1;
    }

    return {
      rootUnitId: root._id,
      rootUnitCreated,
      typeCount,
      scopedProfileCount,
    };
  },
});

export const bootstrapSuperAdmin = internalMutation({
  args: {},
  returns: v.object({
    email: v.string(),
    invitationCreated: v.boolean(),
    profilePromoted: v.boolean(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", BOOTSTRAP_SUPER_ADMIN_EMAIL))
      .unique();

    if (invitation) {
      await ctx.db.patch(invitation._id, {
        role: "super_admin",
        status: invitation.status === "accepted" ? "accepted" : "pending",
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("accessInvitations", {
        email: BOOTSTRAP_SUPER_ADMIN_EMAIL,
        role: "super_admin",
        status: "pending",
        invitedBy: "system:bootstrap",
        invitedAt: now,
        updatedAt: now,
      });
    }

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", BOOTSTRAP_SUPER_ADMIN_EMAIL))
      .unique();
    if (profile)
      await ctx.db.patch(profile._id, {
        role: "super_admin",
        status: "active",
        updatedAt: now,
      });

    return {
      email: BOOTSTRAP_SUPER_ADMIN_EMAIL,
      invitationCreated: invitation === null,
      profilePromoted: profile !== null,
    };
  },
});

/** Bounded, idempotent legacy projection backfill. Repeat with returned cursor until done. */
export const backfillOrganizationEdges = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    count: v.number(),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("orgUnits")
      .paginate({ cursor: args.cursor, numItems: 100 });
    let count = 0;
    for (const unit of page.page) {
      if (!unit.parentId) continue;
      const edge = await ctx.db
        .query("orgUnitParentEdges")
        .withIndex("by_unitId_and_effectiveFrom", (q) =>
          q.eq("unitId", unit._id),
        )
        .first();
      if (edge) continue;
      await ctx.db.insert("orgUnitParentEdges", {
        unitId: unit._id,
        parentId: unit.parentId,
        effectiveFrom: unit.effectiveFrom,
        effectiveTo: unit.effectiveTo,
        actorSubject: "system:backfill",
        reason: "legacy projection",
        createdAt: Date.now(),
      });
      count++;
    }
    return { count, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const backfillEmployeeAssignments = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    count: v.number(),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("profiles")
      .paginate({ cursor: args.cursor, numItems: 100 });
    let count = 0;
    for (const profile of page.page) {
      const row = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profile._id),
        )
        .first();
      if (row) continue;
      const supervisor = profile.supervisorSubject
        ? await ctx.db
            .query("profiles")
            .withIndex("by_subject", (q) =>
              q.eq("authSubject", profile.supervisorSubject!),
            )
            .unique()
        : null;
      await ctx.db.insert("employeeAssignments", {
        profileId: profile._id,
        orgUnitId: profile.orgUnitId,
        role: profile.role,
        positionId: profile.positionId,
        supervisorId: supervisor?._id,
        effectiveFrom: profile.effectiveFrom ?? profile._creationTime,
        actorSubject: "system:backfill",
        reason: "legacy projection",
        createdAt: Date.now(),
      });
      count++;
    }
    return { count, cursor: page.continueCursor, isDone: page.isDone };
  },
});
