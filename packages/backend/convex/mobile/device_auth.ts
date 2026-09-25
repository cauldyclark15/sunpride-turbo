import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { employeeAt } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import type { AppRole } from "../lib/roles";
import { activeAt } from "../org/validation";
import type { AuthorizedDevice } from "./types";

export const CHALLENGE_TTL_MS = 60_000;
export const PROOF_SKEW_MS = 60_000;
const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const decode = (value: string, maxBytes: number): Uint8Array => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > maxBytes * 2)
    throw new ConvexError("Invalid device proof");
  try {
    const bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
    if (
      bytes.length === 0 ||
      bytes.length > maxBytes ||
      base64(bytes) !== value
    )
      throw new Error("Invalid encoding");
    return bytes;
  } catch {
    throw new ConvexError("Invalid device proof");
  }
};

/** Public keys are base64 DER SubjectPublicKeyInfo, ECDSA P-256 only. */
export async function importDeviceKey(publicKey: string): Promise<CryptoKey> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      decode(publicKey, 256) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    if (
      key.algorithm.name !== "ECDSA" ||
      (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
    )
      throw new Error("Unexpected curve");
    return key;
  } catch {
    throw new ConvexError("Invalid device public key");
  }
}

export async function verifyDeviceSignature(
  publicKey: string,
  proof: string,
  message: string,
): Promise<void> {
  const key = await importDeviceKey(publicKey);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decode(proof, 128) as BufferSource,
      encoder.encode(message),
    );
  } catch {
    // Reject malformed signatures without returning key or proof material.
  }
  if (!valid) throw new ConvexError("Invalid device proof");
}

export function assertProofTime(timestamp: number, now: number): void {
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(timestamp - now) > PROOF_SKEW_MS
  )
    throw new ConvexError("Device proof expired");
}

/** Mutation-local consumption: a failed signature/authorization never consumes a challenge. */
export async function consumeChallenge(
  ctx: MutationCtx,
  device: Doc<"registeredDevices">,
  nonce: string,
  now: number,
): Promise<void> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      nonce,
    )
  )
    throw new ConvexError("Invalid device challenge");
  const challenge = await ctx.db
    .query("deviceChallenges")
    .withIndex("by_deviceId_and_nonce", (q) =>
      q.eq("deviceId", device._id).eq("nonce", nonce),
    )
    .unique();
  if (
    !challenge ||
    challenge.organizationId !== device.organizationId ||
    challenge.consumedAt !== undefined ||
    challenge.expiresAt <= now ||
    challenge.issuedAt > now
  )
    throw new ConvexError("Device challenge expired or used");
  await ctx.db.patch(challenge._id, { consumedAt: now });
}

export async function devicePerson(
  ctx: MutationCtx,
  deviceId: Id<"registeredDevices">,
): Promise<{
  device: Doc<"registeredDevices">;
  profile: Doc<"profiles">;
  assignment: Doc<"employeeAssignments">;
  subject: string;
}> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Authentication required");
  const device = await ctx.db.get(deviceId);
  if (
    !device ||
    device.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    device.status !== "active" ||
    !device.profileId ||
    !device.orgUnitId ||
    device.allowedApp === "VAN_ANDROID"
  )
    throw new ConvexError("Device unavailable");
  const profile = await ctx.db.get(device.profileId);
  if (
    !profile ||
    profile.status !== "active" ||
    profile.authSubject !== identity.tokenIdentifier ||
    (device.boundSubject && device.boundSubject !== identity.tokenIdentifier)
  )
    throw new ConvexError("Device identity mismatch");
  const assignment = await employeeAt(ctx, profile._id, Date.now());
  const unit = await ctx.db.get(assignment.orgUnitId!);
  if (
    !unit ||
    unit.organizationId !== device.organizationId ||
    unit.status !== "active" ||
    !activeAt(unit.effectiveFrom, unit.effectiveTo, Date.now())
  )
    throw new ConvexError("Device scope unavailable");
  // A transfer requires a newly enrolled device; even an otherwise valid bearer/key fails.
  if (
    assignment.orgUnitId !== device.orgUnitId ||
    assignment.role !== profile.role ||
    profile.orgUnitId !== assignment.orgUnitId
  )
    throw new ConvexError("Device scope changed");
  return { device, profile, assignment, subject: identity.tokenIdentifier };
}

export const authorize = internalMutation({
  args: {
    deviceId: v.id("registeredDevices"),
    app: v.union(v.literal("IOS"), v.literal("ANDROID")),
    proof: v.string(),
    method: v.string(),
    path: v.string(),
    bodyDigest: v.string(),
    nonce: v.string(),
    timestamp: v.number(),
  },
  returns: v.object({
    deviceId: v.id("registeredDevices"),
    profileId: v.id("profiles"),
    subject: v.string(),
    orgUnitId: v.id("orgUnits"),
    role: v.union(
      v.literal("super_admin"),
      v.literal("admin"),
      v.literal("operations"),
      v.literal("manager"),
      v.literal("approver"),
      v.literal("sales"),
      v.literal("analyst"),
      v.literal("viewer"),
    ),
    scopeFingerprint: v.string(),
  }),
  handler: async (ctx, args): Promise<AuthorizedDevice> => {
    const now = Date.now();
    const { device, profile, assignment, subject } = await devicePerson(
      ctx,
      args.deviceId,
    );
    if (
      !device.boundSubject ||
      !device.credentialId ||
      !device.publicKey ||
      device.allowedApp !== args.app
    )
      throw new ConvexError("Device not bound for this app");
    assertProofTime(args.timestamp, now);
    if (
      args.method !== "POST" ||
      !/^\/mobile\/v1\/(bootstrap|pull|push)$/.test(args.path) ||
      !/^[0-9a-f]{64}$/.test(args.bodyDigest)
    )
      throw new ConvexError("Invalid mobile request proof fields");
    await verifyDeviceSignature(
      device.publicKey,
      args.proof,
      `${args.method}|${args.path}|${args.bodyDigest}|${args.nonce}|${args.timestamp}`,
    );
    await consumeChallenge(ctx, device, args.nonce, now);
    const scope = `${profile._id}|${subject}|${assignment._id}|${assignment.orgUnitId}|${assignment.role}|${device._id}|${device.allowedApp}|${device.credentialId}`;
    const fingerprint = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(scope),
    );
    await ctx.db.patch(device._id, { lastSeenAt: now });
    return {
      deviceId: device._id,
      profileId: profile._id,
      subject,
      orgUnitId: assignment.orgUnitId!,
      role: assignment.role as AppRole,
      scopeFingerprint: Array.from(new Uint8Array(fingerprint), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  },
});
