import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  BOOTSTRAP_SUPER_ADMIN_EMAIL,
  isBootstrapSuperAdminEmail,
  normalizeEmail,
} from "../lib/access";
import {
  requireActiveProfile,
  requireAuthenticatedIdentity,
  requireRole,
} from "../lib/auth";
import { requireCapability } from "../lib/capabilities";
import {
  assignableRoleValidator,
  employmentTypeValidator,
  type AssignableRole,
} from "../lib/roles";
import {
  collectScopeUnitIds,
  requireNationalScope,
  rootOrgUnitId,
} from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { writeAssignment } from "../people/validation";
import { CHANNEL_SCOPE_CODES } from "../sfa/constants";

const assignableRoleValue = assignableRoleValidator;

// Return validators are derived from the schema (schema.doc) rather than re-declared by
// hand: a hand-written shape silently breaks every reader the moment a column is added.
const profileValue = schema.doc("profiles");
const invitationValue = schema.doc("accessInvitations");

const assertCanAssignRole = (actorRole: string, targetRole: AssignableRole) => {
  if (targetRole === "admin" && actorRole !== "super_admin")
    throw new ConvexError(
      "Only the super admin can grant administrator access",
    );
};

/** A position may only be attached if it exists and is active (ADR-009). */
async function assertActivePosition(
  ctx: Parameters<typeof rootOrgUnitId>[0],
  positionId: Id<"positions"> | undefined,
) {
  if (!positionId) return undefined;
  const position = await ctx.db.get(positionId);
  if (!position || !position.active)
    throw new ConvexError("Unknown or inactive position");
  return positionId;
}

export const current = query({
  args: {},
  returns: v.union(v.null(), profileValue),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return ctx.db
      .query("profiles")
      .withIndex("by_subject", (q) =>
        q.eq("authSubject", identity.tokenIdentifier),
      )
      .unique();
  },
});

/** The caller's own organizational scope (ADR-005). Used by scoped UI and tests. */
export const myScope = query({
  args: {},
  returns: v.object({
    profileId: v.id("profiles"),
    role: v.string(),
    orgUnitId: v.union(v.id("orgUnits"), v.null()),
    orgUnitCode: v.union(v.string(), v.null()),
    scopeUnitIds: v.array(v.id("orgUnits")),
  }),
  handler: async (ctx) => {
    const { profile } = await requireActiveProfile(ctx);
    if (!profile.orgUnitId)
      return {
        profileId: profile._id,
        role: profile.role,
        orgUnitId: null,
        orgUnitCode: null,
        scopeUnitIds: [],
      };
    const unit = await ctx.db.get(profile.orgUnitId);
    const scopeUnitIds = await collectScopeUnitIds(ctx, profile.orgUnitId);
    return {
      profileId: profile._id,
      role: profile.role,
      orgUnitId: profile.orgUnitId,
      orgUnitCode: unit?.code ?? null,
      scopeUnitIds,
    };
  },
});

export const ensure = mutation({
  args: {},
  returns: v.id("profiles"),
  handler: async (ctx) => {
    const identity = await requireAuthenticatedIdentity(ctx);
    if (!identity.email)
      throw new ConvexError("A verified email address is required");

    const email = normalizeEmail(identity.email);
    const now = Date.now();
    let invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (!invitation && isBootstrapSuperAdminEmail(email)) {
      const invitationId = await ctx.db.insert("accessInvitations", {
        email: BOOTSTRAP_SUPER_ADMIN_EMAIL,
        ...(identity.name ? { name: identity.name } : {}),
        role: "super_admin",
        status: "pending",
        invitedBy: "system:bootstrap",
        invitedAt: now,
        updatedAt: now,
      });
      invitation = await ctx.db.get(invitationId);
    }

    if (!invitation || invitation.status === "revoked")
      throw new ConvexError(
        "This email address has not been invited to Sunpride Operations",
      );

    const role = isBootstrapSuperAdminEmail(email)
      ? "super_admin"
      : invitation.role === "super_admin"
        ? "viewer"
        : invitation.role;
    const identityKey = identity.tokenIdentifier;
    const bySubject = await ctx.db
      .query("profiles")
      .withIndex("by_subject", (q) => q.eq("authSubject", identityKey))
      .unique();
    const byEmail = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    const existing = bySubject ?? byEmail;
    const name = identity.name ?? invitation.name ?? email;
    const rootUnitId =
      role === "super_admin" && !existing?.orgUnitId
        ? await rootOrgUnitId(ctx)
        : null;

    if (existing) {
      await ctx.db.patch(existing._id, {
        authSubject: identityKey,
        name,
        email,
        role: existing.role,
        status: "active",
        ...(existing.orgUnitId || !rootUnitId
          ? {}
          : {
              orgUnitId: rootUnitId,
              effectiveFrom: existing.effectiveFrom ?? now,
            }),
        updatedAt: now,
      });
      await ctx.db.patch(invitation._id, {
        status: "accepted",
        acceptedAt: invitation.acceptedAt ?? now,
        profileId: existing._id,
        updatedAt: now,
      });
      if (
        existing.status !== "active" ||
        existing.authSubject !== identityKey ||
        rootUnitId
      )
        await ctx.db.insert("auditLogs", {
          subject: identityKey,
          action: "profile.reactivated_or_rebound",
          entityType: "profile",
          entityId: existing._id,
          details: JSON.stringify({
            reason:
              existing.status !== "active"
                ? "invitation reactivation"
                : existing.authSubject !== identityKey
                  ? "verified email subject rebind"
                  : "bootstrap root assignment",
            previousSubject: existing.authSubject,
            previousStatus: existing.status,
            assignedRootUnitId: rootUnitId,
          }),
          createdAt: now,
        });
      return existing._id;
    }

    const profileId = await ctx.db.insert("profiles", {
      authSubject: identityKey,
      name,
      email,
      role,
      status: "active",
      ...(rootUnitId ? { orgUnitId: rootUnitId, effectiveFrom: now } : {}),
      ...(invitation.positionId ? { positionId: invitation.positionId } : {}),
      updatedAt: now,
    });
    await ctx.db.insert("employeeAssignments", {
      profileId,
      orgUnitId: rootUnitId ?? undefined,
      role,
      positionId: invitation.positionId,
      effectiveFrom: now,
      actorSubject: identityKey,
      reason: "provisioned",
      createdAt: now,
    });
    await ctx.db.patch(invitation._id, {
      status: "accepted",
      acceptedAt: now,
      profileId,
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identityKey,
      action: "profile.provisioned",
      entityType: "profile",
      entityId: profileId,
      details: role,
      createdAt: now,
    });
    return profileId;
  },
});

export const list = query({
  args: {},
  returns: v.array(profileValue),
  handler: async (ctx) => {
    const { profile } = await requireCapability(ctx, "people.read");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : profile.orgUnitId
          ? new Set(await collectScopeUnitIds(ctx, profile.orgUnitId))
          : new Set();
    const rows = await ctx.db.query("profiles").take(100);
    return rows.filter(
      (person) => !scope || (person.orgUnitId && scope.has(person.orgUnitId)),
    );
  },
});

/**
 * Organization units the caller may assign a person into (ADR-009): their own subtree, or
 * the whole organization for an unscoped platform administrator.
 */
export const listAssignableOrgUnits = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("orgUnits"),
      code: v.string(),
      name: v.string(),
      typeCode: v.string(),
      parentId: v.union(v.id("orgUnits"), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const { profile } = await requireCapability(ctx, "admin.manage");
    const units = await ctx.db
      .query("orgUnits")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .take(501);
    if (units.length > 500)
      throw new ConvexError("Organization hierarchy exceeds 500 units");
    if (profile.role !== "super_admin" && !profile.orgUnitId)
      throw new ConvexError("Your access has no organizational scope");
    const scopeUnitIds =
      profile.role === "super_admin"
        ? null
        : new Set(await collectScopeUnitIds(ctx, profile.orgUnitId!));
    return units
      .filter((unit) => !scopeUnitIds || scopeUnitIds.has(unit._id))
      .map((unit) => ({
        _id: unit._id,
        code: unit.code,
        name: unit.name,
        typeCode: unit.typeCode,
        parentId:
          unit.parentId && (!scopeUnitIds || scopeUnitIds.has(unit.parentId))
            ? unit.parentId
            : null,
      }))
      .sort((left, right) => left.code.localeCompare(right.code));
  },
});

export const listInvitations = query({
  args: {},
  returns: v.array(invitationValue),
  handler: async (ctx) => {
    await requireNationalScope(ctx, ["admin"]);
    return ctx.db
      .query("accessInvitations")
      .withIndex("by_status")
      .order("desc")
      .take(100);
  },
});

export const invite = mutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    role: assignableRoleValue,
    positionId: v.optional(v.id("positions")),
  },
  returns: v.id("accessInvitations"),
  handler: async (ctx, args) => {
    const { identity, profile: actor } = await requireNationalScope(ctx, [
      "admin",
    ]);
    assertCanAssignRole(actor.role, args.role);
    const positionId = await assertActivePosition(ctx, args.positionId);
    const email = normalizeEmail(args.email);
    if (!email.includes("@"))
      throw new ConvexError("Enter a valid email address");
    if (isBootstrapSuperAdminEmail(email))
      throw new ConvexError("The bootstrap super admin role cannot be changed");

    const now = Date.now();
    const existingProfile = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existingProfile?.role === "super_admin")
      throw new ConvexError("The super admin role cannot be changed");
    if (actor.role !== "super_admin" && existingProfile?.role === "admin")
      throw new ConvexError("Only the super admin can manage administrators");

    if (existingProfile) {
      await writeAssignment(
        ctx,
        existingProfile,
        { role: args.role, positionId },
        "invitation updated",
      );
      await ctx.db.patch(existingProfile._id, {
        name: args.name?.trim() || existingProfile.name,
        status: "active",
        updatedAt: now,
      });
    }

    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (invitation) {
      const invitedName = args.name?.trim();
      await ctx.db.patch(invitation._id, {
        ...(invitedName ? { name: invitedName } : {}),
        role: args.role,
        ...(positionId ? { positionId } : {}),
        status: existingProfile ? "accepted" : "pending",
        invitedBy: identity.tokenIdentifier,
        invitedAt: now,
        ...(existingProfile ? { profileId: existingProfile._id } : {}),
        updatedAt: now,
      });
      await ctx.db.insert("auditLogs", {
        subject: identity.tokenIdentifier,
        action: "access.invitation_updated",
        entityType: "accessInvitation",
        entityId: invitation._id,
        details: `${email}:${args.role}`,
        createdAt: now,
      });
      return invitation._id;
    }

    const invitedName = args.name?.trim();
    const invitationId = await ctx.db.insert("accessInvitations", {
      email,
      ...(invitedName ? { name: invitedName } : {}),
      role: args.role,
      ...(positionId ? { positionId } : {}),
      status: existingProfile ? "accepted" : "pending",
      invitedBy: identity.tokenIdentifier,
      invitedAt: now,
      ...(existingProfile ? { profileId: existingProfile._id } : {}),
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "access.invited",
      entityType: "accessInvitation",
      entityId: invitationId,
      details: `${email}:${args.role}`,
      createdAt: now,
    });
    return invitationId;
  },
});

export const revoke = mutation({
  args: { invitationId: v.id("accessInvitations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, profile: actor } = await requireNationalScope(ctx, [
      "admin",
    ]);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) throw new ConvexError("Invitation not found");
    if (invitation.role === "super_admin")
      throw new ConvexError("The super admin cannot be revoked");
    if (actor.role !== "super_admin" && invitation.role === "admin")
      throw new ConvexError("Only the super admin can revoke administrators");

    const now = Date.now();
    await ctx.db.patch(invitation._id, { status: "revoked", updatedAt: now });
    if (invitation.profileId)
      await ctx.db.patch(invitation.profileId, {
        status: "disabled",
        updatedAt: now,
      });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "access.revoked",
      entityType: "accessInvitation",
      entityId: invitation._id,
      details: invitation.email,
      createdAt: now,
    });
    return null;
  },
});

export const setRole = mutation({
  args: {
    profileId: v.id("profiles"),
    role: assignableRoleValue,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, profile: actor } = await requireRole(ctx, ["admin"]);
    assertCanAssignRole(actor.role, args.role);
    const target = await ctx.db.get(args.profileId);
    if (!target) throw new ConvexError("Profile not found");
    if (target.role === "super_admin")
      throw new ConvexError("The super admin role cannot be changed");
    if (actor.role !== "super_admin" && target.role === "admin")
      throw new ConvexError("Only the super admin can manage administrators");

    const now = Date.now();
    await writeAssignment(ctx, target, { role: args.role }, "role changed");
    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", target.email))
      .unique();
    if (invitation)
      await ctx.db.patch(invitation._id, { role: args.role, updatedAt: now });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "profile.role_changed",
      entityType: "profile",
      entityId: args.profileId,
      details: args.role,
      createdAt: now,
    });
    return null;
  },
});

/**
 * Assigns the persona attributes that are not access roles (ADR-009): organizational unit,
 * position, employment type, channel scope. Gated by the `admin.manage` capability and by
 * organizational scope against BOTH the person's current unit and the unit they are moving
 * to, so a scoped administrator can never pull someone in from, or push someone into, a
 * subtree they do not own.
 */
export const assignPersona = mutation({
  args: {
    profileId: v.id("profiles"),
    orgUnitId: v.optional(v.id("orgUnits")),
    positionId: v.optional(v.id("positions")),
    employmentType: v.optional(employmentTypeValidator),
    channelScope: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.profileId);
    if (!target) throw new ConvexError("Profile not found");

    const { identity, profile: actor } = target.orgUnitId
      ? await requireCapability(ctx, "admin.manage", target.orgUnitId)
      : await requireNationalScope(ctx, ["admin"]);
    if (args.orgUnitId)
      await requireCapability(ctx, "admin.manage", args.orgUnitId);
    if (target.role === "super_admin")
      throw new ConvexError("The super admin cannot be reassigned");
    if (actor.role !== "super_admin" && target.role === "admin")
      throw new ConvexError("Only the super admin can manage administrators");

    const positionId = await assertActivePosition(ctx, args.positionId);
    if (args.orgUnitId) {
      const unit = await ctx.db.get(args.orgUnitId);
      if (!unit) throw new ConvexError("Organization unit not found");
    }

    const channelScope = args.channelScope?.trim().toUpperCase();
    if (
      channelScope &&
      !CHANNEL_SCOPE_CODES.includes(
        channelScope as (typeof CHANNEL_SCOPE_CODES)[number],
      )
    )
      throw new ConvexError(
        `Channel scope must be one of ${CHANNEL_SCOPE_CODES.join(", ")}`,
      );

    const now = Date.now();
    await writeAssignment(
      ctx,
      target,
      { orgUnitId: args.orgUnitId, positionId },
      "persona changed",
    );
    await ctx.db.patch(args.profileId, {
      ...(args.employmentType ? { employmentType: args.employmentType } : {}),
      ...(channelScope ? { channelScope } : {}),
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "profile.persona_changed",
      entityType: "profile",
      entityId: args.profileId,
      details: [
        args.orgUnitId ? "orgUnit" : null,
        positionId ? "position" : null,
        args.employmentType ?? null,
        channelScope ?? null,
      ]
        .filter((part): part is string => part !== null)
        .join(","),
      createdAt: now,
    });
    return null;
  },
});
