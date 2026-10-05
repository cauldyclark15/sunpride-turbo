import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { employeeAt } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
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

const REVOKE_REASONS = [
  "lost",
  "stolen",
  "suspected_compromise",
  "transfer",
  "replacement",
  "decommissioned",
  "other",
] as const;
/** Suspension is the reversible hold for a phone that may still turn up. */
const SUSPEND_REASONS = [
  "lost",
  "stolen",
  "suspected_compromise",
  "other",
] as const;
const REINSTATE_REASONS = ["found", "other"] as const;

function reasonCode<T extends string>(value: string, allowed: readonly T[]): T {
  const reason = bounded(value, 200);
  if (!(allowed as readonly string[]).includes(reason))
    throw new ConvexError("Use a device incident reason code");
  return reason as T;
}

/**
 * Status changes need `admin.manage` over the device's stored unit and, while the employee
 * is active, over their current unit too (a transfer needs authority over both).
 * Disabling an employee must not prevent an administrator from acting on the phone.
 */
async function requireDeviceAdmin(
  ctx: MutationCtx,
  deviceId: Id<"registeredDevices">,
) {
  const device = await ctx.db.get(deviceId);
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
    if (employee?.status === "active") {
      const current = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", device.profileId!).lte("effectiveFrom", Date.now()),
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
  return { device, identity };
}

export const revoke = mutation({
  args: { deviceId: v.id("registeredDevices"), reason: v.string() },
  returns: v.object({ status: v.literal("revoked"), revokedAt: v.number() }),
  handler: async (ctx, args) => {
    const { device, identity } = await requireDeviceAdmin(ctx, args.deviceId);
    if (device.status === "revoked")
      throw new ConvexError("Device already revoked");
    const reason = reasonCode(args.reason, REVOKE_REASONS);
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

/** Reversible hold: every challenge, bind, bootstrap, pull and push fails until reinstated or revoked. */
export const suspend = mutation({
  args: { deviceId: v.id("registeredDevices"), reason: v.string() },
  returns: v.object({
    status: v.literal("suspended"),
    suspendedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const { device, identity } = await requireDeviceAdmin(ctx, args.deviceId);
    if (device.status !== "active")
      throw new ConvexError("Only an active device can be suspended");
    const reason = reasonCode(args.reason, SUSPEND_REASONS);
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "suspended",
      statusActor: identity.tokenIdentifier,
      statusReason: reason,
      statusAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "device.suspended",
      "registeredDevice",
      device._id,
      reason,
      now,
    );
    return { status: "suspended" as const, suspendedAt: now };
  },
});

/** A recovered phone returns to its own employee only; a revoked phone never comes back. */
export const reinstate = mutation({
  args: { deviceId: v.id("registeredDevices"), reason: v.string() },
  returns: v.object({ status: v.literal("active"), reinstatedAt: v.number() }),
  handler: async (ctx, args) => {
    const { device, identity } = await requireDeviceAdmin(ctx, args.deviceId);
    if (device.status !== "suspended")
      throw new ConvexError("Only a suspended device can be reinstated");
    const reason = reasonCode(args.reason, REINSTATE_REASONS);
    const employee = device.profileId
      ? await ctx.db.get(device.profileId)
      : null;
    if (!employee || employee.status !== "active")
      throw new ConvexError("Active employee required");
    const assignment = await employeeAt(ctx, employee._id, Date.now());
    if (assignment.orgUnitId !== device.orgUnitId)
      throw new ConvexError(
        "Employee moved since enrollment; revoke and enroll again",
      );
    const activeDevices = await ctx.db
      .query("registeredDevices")
      .withIndex("by_profileId_and_status", (q) =>
        q.eq("profileId", employee._id).eq("status", "active"),
      )
      .take(1);
    if (activeDevices.length)
      throw new ConvexError(
        "Employee already has an active device; revoke it first",
      );
    const now = Date.now();
    await ctx.db.patch(device._id, {
      status: "active",
      statusActor: identity.tokenIdentifier,
      statusReason: reason,
      statusAt: now,
    });
    await audit(
      ctx,
      identity.tokenIdentifier,
      "device.reinstated",
      "registeredDevice",
      device._id,
      reason,
      now,
    );
    return { status: "active" as const, reinstatedAt: now };
  },
});

const deviceSummary = v.object({
  deviceId: v.id("registeredDevices"),
  inventoryTag: v.string(),
  allowedApp: appValidator,
  platform: v.string(),
  model: v.string(),
  osVersion: v.string(),
  appVersion: v.string(),
  orgUnitId: v.union(v.id("orgUnits"), v.null()),
  employeeName: v.union(v.string(), v.null()),
  status: v.union(
    v.literal("active"),
    v.literal("suspended"),
    v.literal("revoked"),
  ),
  statusReason: v.union(v.string(), v.null()),
  statusAt: v.union(v.number(), v.null()),
  registeredAt: v.number(),
  lastSeenAt: v.union(v.number(), v.null()),
  bound: v.boolean(),
  offlineLeaseExpiresAt: v.union(v.number(), v.null()),
});

/** Units the caller may administer; `null` means national (super administrator). */
async function adminScope(ctx: QueryCtx) {
  const { profile } = await requireCapability(ctx, "admin.manage");
  if (profile.role === "super_admin") return null;
  if (!profile.orgUnitId)
    throw new ConvexError("Your access has no organizational scope");
  return new Set(await collectScopeUnitIds(ctx, profile.orgUnitId));
}

async function summarize(ctx: QueryCtx, device: Doc<"registeredDevices">) {
  const employee = device.profileId ? await ctx.db.get(device.profileId) : null;
  const sync = await ctx.db
    .query("mobileSyncState")
    .withIndex("by_deviceId", (q) => q.eq("deviceId", device._id))
    .first();
  // Never return key, credential or bound subject material to the console.
  return {
    deviceId: device._id,
    inventoryTag: device.inventoryTag,
    allowedApp: device.allowedApp,
    platform: device.platform,
    model: device.model,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    orgUnitId: device.orgUnitId ?? null,
    employeeName: employee ? employee.name || employee.email : null,
    status: device.status,
    statusReason: device.statusReason ?? null,
    statusAt: device.statusAt ?? null,
    registeredAt: device.registeredAt,
    lastSeenAt: device.lastSeenAt ?? null,
    bound: Boolean(device.boundSubject && device.credentialId),
    offlineLeaseExpiresAt: sync?.leaseExpiresAt ?? null,
  };
}

/** Scoped device register for the admin console. Filtered pages may be empty; keep paging. */
export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(
      v.union(
        v.literal("active"),
        v.literal("suspended"),
        v.literal("revoked"),
      ),
    ),
  },
  returns: v.object({
    page: v.array(deviceSummary),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const scope = await adminScope(ctx);
    const result = await ctx.db
      .query("registeredDevices")
      .withIndex("by_organizationId_and_inventoryTag", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(args.paginationOpts);
    const visible = result.page.filter(
      (device) =>
        (!args.status || device.status === args.status) &&
        (scope === null ||
          (device.orgUnitId !== undefined && scope.has(device.orgUnitId))),
    );
    return {
      page: await Promise.all(visible.map((device) => summarize(ctx, device))),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

const RECENT_ACKS = 50;
const HISTORY = 20;

/**
 * What the server holds from one phone, for a lost/stolen reconciliation. Anything the
 * phone recorded after `lastSeenAt` is NOT on the server; it may keep working offline
 * until `offlineLeaseExpiresAt`, and its uploads are refused once suspended or revoked.
 */
export const lostDeviceReport = query({
  args: { deviceId: v.id("registeredDevices") },
  returns: v.object({
    device: deviceSummary,
    acknowledged: v.array(
      v.object({
        kind: v.string(),
        clientRequestId: v.string(),
        serverAt: v.number(),
      }),
    ),
    acknowledgedMore: v.boolean(),
    lastAcknowledgedAt: v.union(v.number(), v.null()),
    history: v.array(
      v.object({
        action: v.string(),
        reason: v.union(v.string(), v.null()),
        at: v.number(),
        actorName: v.union(v.string(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, { deviceId }) => {
    const scope = await adminScope(ctx);
    const device = await ctx.db.get(deviceId);
    if (
      !device ||
      device.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
      (scope !== null &&
        (device.orgUnitId === undefined || !scope.has(device.orgUnitId)))
    )
      throw new ConvexError("Device unavailable");
    const acks = await ctx.db
      .query("processedMobileOperations")
      .withIndex("by_deviceId_and_serverAt", (q) => q.eq("deviceId", deviceId))
      .order("desc")
      .take(RECENT_ACKS + 1);
    const logs = await ctx.db
      .query("auditLogs")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", "registeredDevice").eq("entityId", deviceId),
      )
      .order("desc")
      .take(HISTORY);
    const names = new Map<string, string | null>();
    for (const log of logs) {
      if (names.has(log.subject)) continue;
      const person = await ctx.db
        .query("profiles")
        .withIndex("by_subject", (q) => q.eq("authSubject", log.subject))
        .first();
      names.set(log.subject, person ? person.name || person.email : null);
    }
    return {
      device: await summarize(ctx, device),
      acknowledged: acks.slice(0, RECENT_ACKS).map((ack) => ({
        kind: ack.kind,
        clientRequestId: ack.clientRequestId,
        serverAt: ack.serverAt,
      })),
      acknowledgedMore: acks.length > RECENT_ACKS,
      lastAcknowledgedAt: acks[0]?.serverAt ?? null,
      history: logs.map((log) => ({
        action: log.action,
        reason: log.details ?? null,
        at: log.createdAt,
        actorName: names.get(log.subject) ?? null,
      })),
    };
  },
});
