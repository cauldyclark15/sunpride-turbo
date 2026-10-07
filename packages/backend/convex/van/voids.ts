/* Convex runtime secret is not a Turborepo build input. */
/* eslint-disable turbo/no-undeclared-env-vars */
import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { audit } from "../org/validation";
import {
  type TripStatus,
  VAN_POLICY,
  VOID_REASONS,
  type VoidReason,
} from "./model";

/**
 * VAN-021 supervisor approval of a van sale void.
 *
 * Van sales are saved on the handheld and voided there, offline, as an append-only compensating
 * transaction (the sale is never deleted). When the office requires approval, the handheld asks
 * for an 8-digit code bound to (trip, receipt number, total, reason). A supervisor in scope gets
 * that code here; the handheld checks it offline with the trip key it received in its bootstrap.
 *
 * key  = HMAC-SHA256(MOBILE_CURSOR_SECRET, "sunpride/van-void-approval/v1|" + tripId)  (base64url)
 * code = RFC 4226 dynamic truncation of HMAC-SHA256(key, "VOID|v1|tripId|receipt|total|reason")
 *        mod 10^8, zero padded. Vectors: packages/domain-contracts/fixtures/van-v1/void-approval.json.
 *
 * The secret is the existing runtime-only mobile secret with a separate domain label, so no new
 * deployment variable is needed; when it is absent the bootstrap sends no key (approval-required
 * voids are refused on the handheld) and no code can be issued.
 */
const KEY_LABEL = "sunpride/van-void-approval/v1|";
const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export async function hmac(
  key: Uint8Array,
  message: string,
): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, enc.encode(message)),
  );
}

/** The runtime-only mobile secret, or null when absent/short (approval keys are then not issued). */
export function approvalSecret(): string | null {
  const value = process.env.MOBILE_CURSOR_SECRET;
  return value && value.length >= 32 ? value : null;
}

/** The trip's void key (base64url, 43 chars), or null when the secret is not configured. */
export async function voidApprovalKey(tripId: string): Promise<string | null> {
  const configured = approvalSecret();
  if (!configured) return null;
  return b64url(await hmac(enc.encode(configured), KEY_LABEL + tripId));
}

/** Exported for the cross-language vector test; `key` is the base64url trip key. */
export async function voidApprovalCode(
  key: string,
  args: {
    tripId: string;
    receiptNumber: string;
    totalMinor: bigint;
    reasonCode: string;
  },
): Promise<string> {
  return approvalCodeFor(
    key,
    `VOID|v1|${args.tripId}|${args.receiptNumber}|${args.totalMinor.toString()}|${args.reasonCode}`,
  );
}

/** RFC 4226 dynamic truncation of HMAC-SHA256(base64url trip key, message) mod 10^8, zero padded. */
export async function approvalCodeFor(
  key: string,
  message: string,
): Promise<string> {
  const raw = key.replaceAll("-", "+").replaceAll("_", "/");
  const keyBytes = Uint8Array.from(
    atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
  const mac = await hmac(keyBytes, message);
  const offset = mac[31]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 100_000_000).padStart(8, "0");
}

/** The bootstrap's `policy.voidApproval` for a trip (key null when no trip or no secret). */
export async function voidApprovalPolicy(tripId: string | null) {
  return {
    required: VAN_POLICY.voidRequiresApproval,
    thresholdMinor: String(VAN_POLICY.voidApprovalThresholdMinor),
    key: tripId ? await voidApprovalKey(tripId) : null,
  };
}

/** Handheld receipt numbers are `<tripNumber>-<8 hex device tag>-<sequence>`. */
const RECEIPT = /^(.{1,64})-([0-9A-F]{8})-(\d{4,9})$/;
/** A sale can be voided on the handheld only while its trip is on the road or closing. */
const VOIDABLE: readonly TripStatus[] = [
  "loaded",
  "active",
  "closing",
  "reconciling",
  "review_required",
];

async function tripForReceipt(
  ctx: MutationCtx,
  receiptNumber: string,
): Promise<Doc<"vanTrips">> {
  const match = RECEIPT.exec(receiptNumber);
  if (!match) throw new ConvexError("Receipt number is not a van receipt");
  const trips = await ctx.db
    .query("vanTrips")
    .withIndex("by_organizationId_and_tripNumber", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("tripNumber", match[1]!),
    )
    .take(2);
  if (trips.length !== 1)
    throw new ConvexError("No trip matches this receipt number");
  return trips[0]!;
}

export const issueApprovalCode = mutation({
  args: {
    receiptNumber: v.string(),
    totalMinor: v.string(),
    reasonCode: v.string(),
  },
  returns: v.object({
    code: v.string(),
    tripNumber: v.string(),
    receiptNumber: v.string(),
    totalMinor: v.string(),
    reasonCode: v.string(),
  }),
  handler: async (ctx, args) => {
    // Role first, so a caller without the capability learns nothing about trip numbers.
    await requireCapability(ctx, "van.void.approve");
    const receiptNumber = args.receiptNumber.trim().toUpperCase();
    if (!/^\d{1,18}$/.test(args.totalMinor))
      throw new ConvexError("Enter the receipt total");
    const totalMinor = BigInt(args.totalMinor);
    if (!(VOID_REASONS as readonly string[]).includes(args.reasonCode))
      throw new ConvexError("Choose a void reason");
    const trip = await tripForReceipt(ctx, receiptNumber);
    const { identity } = await requireCapability(
      ctx,
      "van.void.approve",
      trip.orgUnitId,
    );
    // The seller never approves their own void.
    if (trip.salespersonSubject === identity.tokenIdentifier)
      throw new ConvexError("You cannot approve a void of your own sale");
    if (!VOIDABLE.includes(trip.status))
      throw new ConvexError("This trip is not on the road");
    const key = await voidApprovalKey(trip._id);
    if (!key) throw new ConvexError("Void approval is not configured");
    const reasonCode = args.reasonCode as VoidReason;
    const code = await voidApprovalCode(key, {
      tripId: trip._id,
      receiptNumber,
      totalMinor,
      reasonCode,
    });
    // The audit keeps what was approved and by whom; the code itself is never stored.
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.void.approval_issued",
      "vanTrip",
      trip._id,
      `${receiptNumber}|${totalMinor.toString()}|${reasonCode}`,
      Date.now(),
    );
    return {
      code,
      tripNumber: trip.tripNumber,
      receiptNumber,
      totalMinor: totalMinor.toString(),
      reasonCode,
    };
  },
});
