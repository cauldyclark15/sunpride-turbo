import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import {
  BOOTSTRAP_SUPER_ADMIN_EMAIL,
  isBootstrapSuperAdminEmail,
  normalizeEmail,
} from "../lib/access";
import {
  requireAuthenticatedIdentity,
  requireRole,
} from "../lib/auth";

const roleValue = v.union(
  v.literal("super_admin"),
  v.literal("admin"),
  v.literal("manager"),
  v.literal("approver"),
  v.literal("sales"),
  v.literal("viewer"),
);

const assignableRoleValue = v.union(
  v.literal("admin"),
  v.literal("manager"),
  v.literal("approver"),
  v.literal("sales"),
  v.literal("viewer"),
);

const profileValue = v.object({
  _id: v.id("profiles"),
  _creationTime: v.number(),
  authSubject: v.string(),
  name: v.string(),
  email: v.string(),
  role: roleValue,
  status: v.union(v.literal("active"), v.literal("disabled")),
  updatedAt: v.number(),
});

const invitationValue = v.object({
  _id: v.id("accessInvitations"),
  _creationTime: v.number(),
  email: v.string(),
  name: v.optional(v.string()),
  role: roleValue,
  status: v.union(
    v.literal("pending"),
    v.literal("accepted"),
    v.literal("revoked"),
  ),
  invitedBy: v.string(),
  invitedAt: v.number(),
  acceptedAt: v.optional(v.number()),
  profileId: v.optional(v.id("profiles")),
  updatedAt: v.number(),
});

const assertCanAssignRole = (
  actorRole: string,
  targetRole: "admin" | "manager" | "approver" | "sales" | "viewer",
) => {
  if (targetRole === "admin" && actorRole !== "super_admin")
    throw new ConvexError("Only the super admin can grant administrator access");
};

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

    if (existing) {
      await ctx.db.patch(existing._id, {
        authSubject: identityKey,
        name,
        email,
        role,
        status: "active",
        updatedAt: now,
      });
      await ctx.db.patch(invitation._id, {
        status: "accepted",
        acceptedAt: invitation.acceptedAt ?? now,
        profileId: existing._id,
        updatedAt: now,
      });
      return existing._id;
    }

    const profileId = await ctx.db.insert("profiles", {
      authSubject: identityKey,
      name,
      email,
      role,
      status: "active",
      updatedAt: now,
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
    await requireRole(ctx, ["admin"]);
    return ctx.db.query("profiles").take(100);
  },
});

export const listInvitations = query({
  args: {},
  returns: v.array(invitationValue),
  handler: async (ctx) => {
    await requireRole(ctx, ["admin"]);
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
  },
  returns: v.id("accessInvitations"),
  handler: async (ctx, args) => {
    const { identity, profile: actor } = await requireRole(ctx, ["admin"]);
    assertCanAssignRole(actor.role, args.role);
    const email = normalizeEmail(args.email);
    if (!email.includes("@")) throw new ConvexError("Enter a valid email address");
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

    if (existingProfile)
      await ctx.db.patch(existingProfile._id, {
        name: args.name?.trim() || existingProfile.name,
        role: args.role,
        status: "active",
        updatedAt: now,
      });

    const invitation = await ctx.db
      .query("accessInvitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (invitation) {
      const invitedName = args.name?.trim();
      await ctx.db.patch(invitation._id, {
        ...(invitedName ? { name: invitedName } : {}),
        role: args.role,
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
    const { identity, profile: actor } = await requireRole(ctx, ["admin"]);
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
    await ctx.db.patch(args.profileId, { role: args.role, updatedAt: now });
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
