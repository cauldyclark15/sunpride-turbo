import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { employeeAt } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { activeAt, audit, normalizeCode } from "../org/validation";
import {
  assertProofTime,
  CHALLENGE_TTL_MS,
  consumeChallenge,
  devicePerson,
  importDeviceKey,
  verifyDeviceSignature,
} from "./device_auth";

const appValidator = v.union(
  v.literal("IOS"),
  v.literal("ANDROID"),
  v.literal("VAN_ANDROID"),
);
const fieldAppValidator = v.union(v.literal("IOS"), v.literal("ANDROID"));
const bounded = (value: string, max: number): string => {
  const text = value.trim();
  if (
    !text ||
    text.length > max ||
    Array.from(text).some((character) => character.charCodeAt(0) < 32)
  )
    throw new ConvexError("Invalid device metadata");
  return text;
};

/** Inventory is admin-owned; enrollment never grants an uninvited or unassigned user access. */
export const register = mutation({
  args: {
    inventoryTag: v.string(),
    allowedApp: appValidator,
    platform: v.string(),
    model: v.string(),
    osVersion: v.string(),
    appVersion: v.string(),
    profileId: v.id("profiles"),
    publicKey: v.string(),
  },
  returns: v.object({
    deviceId: v.id("registeredDevices"),
    status: v.literal("active"),
  }),
  handler: async (ctx, args) => {
    const employee = await ctx.db.get(args.profileId);
    if (!employee || employee.status !== "active")
      throw new ConvexError("Active employee required");
    const assignment = await employeeAt(ctx, employee._id, Date.now());
    const unit = await ctx.db.get(assignment.orgUnitId!);
    if (
      !unit ||
      unit.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
      unit.status !== "active" ||
      !activeAt(unit.effectiveFrom, unit.effectiveTo, Date.now()) ||
      employee.orgUnitId !== assignment.orgUnitId ||
      employee.role !== assignment.role
    )
      throw new ConvexError("Employee scope unavailable");
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      assignment.orgUnitId,
    );
    if (args.allowedApp === "VAN_ANDROID")
      throw new ConvexError("Van POS device enrollment is not supported here");
    if (
      (args.allowedApp === "IOS" && args.platform !== "iOS") ||
      (args.allowedApp === "ANDROID" && args.platform !== "Android")
    )
      throw new ConvexError("App and platform mismatch");
    const inventoryTag = normalizeCode(args.inventoryTag);
    const duplicates = await ctx.db
      .query("registeredDevices")
      .withIndex("by_organizationId_and_inventoryTag", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("inventoryTag", inventoryTag),
      )
      .take(100);
    if (
      duplicates.length === 100 ||
      duplicates.some((device) => device.status !== "revoked")
    )
      throw new ConvexError(
        "Inventory tag already in use; revoke old device first",
      );
    const activeDevices = await ctx.db
      .query("registeredDevices")
      .withIndex("by_profileId_and_status", (q) =>
        q.eq("profileId", employee._id).eq("status", "active"),
      )
      .take(2);
    if (activeDevices.length)
      throw new ConvexError(
        "Employee already has an active device; reconcile outbox before replacement",
      );
    await importDeviceKey(args.publicKey);
    const now = Date.now();
    const deviceId = await ctx.db.insert("registeredDevices", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId: assignment.orgUnitId,
      inventoryTag,
      profileId: employee._id,
      allowedApp: args.allowedApp,
      platform: args.platform,
      model: bounded(args.model, 100),
      osVersion: bounded(args.osVersion, 50),
      appVersion: bounded(args.appVersion, 50),
      publicKey: args.publicKey,
      registeredAt: now,
      status: "active",
      statusActor: identity.tokenIdentifier,
      statusReason: "registered",
      statusAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "device.registered",
      "registeredDevice",
      deviceId,
      "registered",
      now,
    );
    return { deviceId, status: "active" as const };
  },
});

/** Employee-only key lookup; never disclose another profile's device. */
export const mine = query({
  args: { publicKey: v.string(), app: fieldAppValidator },
  returns: v.union(
    v.null(),
    v.object({
      deviceId: v.id("registeredDevices"),
      status: v.string(),
      bound: v.boolean(),
      allowedApp: fieldAppValidator,
    }),
  ),
  handler: async (ctx, { publicKey, app }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_subject", (q) =>
        q.eq("authSubject", identity.tokenIdentifier),
      )
      .unique();
    if (!profile || profile.status !== "active") return null;

    // Prefer the current enrollment if an old, revoked row reused this key.
    for (const status of ["active", "suspended", "revoked"] as const) {
      const device = await ctx.db
        .query("registeredDevices")
        .withIndex("by_profileId_and_status", (q) =>
          q.eq("profileId", profile._id).eq("status", status),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("publicKey"), publicKey),
            q.eq(q.field("allowedApp"), app),
          ),
        )
        .first();
      if (device && device.organizationId === SUNPRIDE_ORGANIZATION_ID)
        return {
          deviceId: device._id,
          status: device.status,
          bound: Boolean(device.boundSubject && device.credentialId),
          allowedApp: app,
        };
    }
    return null;
  },
});

/** Online, bearer-authenticated one-time challenge (also used before the first bind). */
export const challenge = mutation({
  args: { deviceId: v.id("registeredDevices") },
  returns: v.object({ nonce: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { deviceId }) => {
    const { device } = await devicePerson(ctx, deviceId);
    if (!device.publicKey) throw new ConvexError("Missing enrolled key");
    const now = Date.now();
    const nonce = crypto.randomUUID();
    const expiresAt = now + CHALLENGE_TTL_MS;
    await ctx.db.insert("deviceChallenges", {
      organizationId: device.organizationId,
      deviceId,
      nonce,
      issuedAt: now,
      expiresAt,
    });
    return { nonce, expiresAt };
  },
});

/** Sign BIND|deviceId|credentialId|nonce|timestamp with the enrolled private key. */
export const bind = mutation({
  args: {
    deviceId: v.id("registeredDevices"),
    credentialId: v.string(),
    attestation: v.object({
      format: v.string(),
      keyId: v.optional(v.string()),
    }),
    nonce: v.string(),
    timestamp: v.number(),
    proof: v.string(),
  },
  returns: v.object({ bindingStatus: v.literal("bound") }),
  handler: async (ctx, args) => {
    const { device, subject } = await devicePerson(ctx, args.deviceId);
    if (!device.publicKey || device.boundSubject || device.credentialId)
      throw new ConvexError("Device already bound or missing key");
    const credentialId = bounded(args.credentialId, 128);
    const existing = await ctx.db
      .query("registeredDevices")
      .withIndex("by_credentialId", (q) => q.eq("credentialId", credentialId))
      .first();
    if (existing) throw new ConvexError("Credential already registered");
    const format = bounded(args.attestation.format, 64);
    const keyId =
      args.attestation.keyId === undefined
        ? undefined
        : bounded(args.attestation.keyId, 128);
    // Attestation is recorded as unverified metadata; this is possession proof, not MDM attestation.
    const now = Date.now();
    assertProofTime(args.timestamp, now);
    await verifyDeviceSignature(
      device.publicKey,
      args.proof,
      `BIND|${device._id}|${credentialId}|${args.nonce}|${args.timestamp}`,
    );
    await consumeChallenge(ctx, device, args.nonce, now);
    await ctx.db.patch(device._id, {
      boundSubject: subject,
      credentialId,
      attestation: { format, keyId },
    });
    await audit(
      ctx,
      subject,
      "device.bound",
      "registeredDevice",
      device._id,
      "bound",
      now,
    );
    return { bindingStatus: "bound" as const };
  },
});

export const revoke = mutation({
  args: { deviceId: v.id("registeredDevices"), reason: v.string() },
  returns: v.object({ status: v.literal("revoked"), revokedAt: v.number() }),
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (
      !device ||
      device.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
      !device.orgUnitId
    )
      throw new ConvexError("Device unavailable");
    const { identity } = await requireCapability(
      ctx,
      "admin.manage",
      device.orgUnitId,
    );
    if (device.profileId) {
      const employee = await ctx.db.get(device.profileId);
      // Disabling an employee must not prevent an administrator from revoking the phone.
      // An active transfer requires authority over both the stored and current units.
      if (employee?.status === "active") {
        const current = await ctx.db
          .query("employeeAssignments")
          .withIndex("by_profileId_and_effectiveFrom", (q) =>
            q
              .eq("profileId", device.profileId!)
              .lte("effectiveFrom", Date.now()),
          )
          .order("desc")
          .first();
        if (
          current?.orgUnitId &&
          activeAt(current.effectiveFrom, current.effectiveTo, Date.now())
        )
          await requireCapability(ctx, "admin.manage", current.orgUnitId);
      }
    }
    if (device.status === "revoked")
      throw new ConvexError("Device already revoked");
    const reason = bounded(args.reason, 200);
    if (
      ![
        "lost",
        "stolen",
        "suspected_compromise",
        "transfer",
        "replacement",
        "decommissioned",
        "other",
      ].includes(reason)
    )
      throw new ConvexError("Use a device incident reason code");
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "revoked",
      statusActor: identity.tokenIdentifier,
      statusReason: reason,
      statusAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "device.revoked",
      "registeredDevice",
      device._id,
      reason,
      now,
    );
    return { status: "revoked" as const, revokedAt: now };
  },
});
