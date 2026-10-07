import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { audit } from "../org/validation";
import {
  CASH_VARIANCE_REASONS,
  type CashVarianceReason,
  type TripStatus,
  VAN_POLICY,
} from "./model";
import { approvalCodeFor, approvalSecret, b64url, hmac } from "./voids";

/**
 * VAN-022 end-of-trip cash reconciliation: supervisor approval of a cash difference.
 *
 * Van sales and their payments are saved on the handheld (the gateway has no sale upload yet), so
 * the handheld itself adds up the cash it should hold — every cash payment of a sale that was not
 * voided — and the seller counts the cash by denomination. Any difference needs a reason; a
 * difference above `VAN_POLICY.cashVarianceToleranceMinor` also needs an 8-digit supervisor code.
 * The seller reads the trip number, expected cash, counted cash and reason to a supervisor, who
 * gets the code here; the handheld checks it offline with the trip key from its bootstrap.
 *
 * key  = HMAC-SHA256(MOBILE_CURSOR_SECRET, "sunpride/van-cash-approval/v1|" + tripId)  (base64url)
 * code = RFC 4226 dynamic truncation of
 *        HMAC-SHA256(key, "CASH|v1|tripId|expectedMinor|declaredMinor|reasonCode") mod 10^8.
 * Vectors: packages/domain-contracts/fixtures/van-v1/cash-approval.json.
 *
 * A separate key label from the void key (VAN-021) means a void code can never approve cash.
 */
const KEY_LABEL = "sunpride/van-cash-approval/v1|";
const enc = new TextEncoder();

/** The trip's cash-approval key (base64url, 43 chars), or null when the secret is not configured. */
export async function cashApprovalKey(tripId: string): Promise<string | null> {
  const configured = approvalSecret();
  if (!configured) return null;
  return b64url(await hmac(enc.encode(configured), KEY_LABEL + tripId));
}

/** Exported for the cross-language vector test; `key` is the base64url trip key. */
export async function cashApprovalCode(
  key: string,
  args: {
    tripId: string;
    expectedMinor: bigint;
    declaredMinor: bigint;
    reasonCode: string;
  },
): Promise<string> {
  return approvalCodeFor(
    key,
    `CASH|v1|${args.tripId}|${args.expectedMinor.toString()}|${args.declaredMinor.toString()}|${args.reasonCode}`,
  );
}

/** The bootstrap's `policy.cashReconciliation` for a trip (key null when no trip or no secret). */
export async function cashReconciliationPolicy(tripId: string | null) {
  return {
    approvalRequired: VAN_POLICY.cashVarianceRequiresApproval,
    toleranceMinor: String(VAN_POLICY.cashVarianceToleranceMinor),
    reasons: [...CASH_VARIANCE_REASONS],
    key: tripId ? await cashApprovalKey(tripId) : null,
  };
}

/** Cash is counted at the end of a trip that went on the road. */
const COUNTABLE: readonly TripStatus[] = [
  "active",
  "closing",
  "reconciling",
  "review_required",
];
const MINOR = /^\d{1,13}$/;

export const issueApprovalCode = mutation({
  args: {
    tripNumber: v.string(),
    expectedMinor: v.string(),
    declaredMinor: v.string(),
    reasonCode: v.string(),
  },
  returns: v.object({
    code: v.string(),
    tripNumber: v.string(),
    expectedMinor: v.string(),
    declaredMinor: v.string(),
    varianceMinor: v.string(),
    reasonCode: v.string(),
  }),
  handler: async (ctx, args) => {
    // Role first, so a caller without the capability learns nothing about trip numbers.
    await requireCapability(ctx, "van.cash.approve");
    const tripNumber = args.tripNumber.trim().toUpperCase();
    if (!tripNumber || tripNumber.length > 64)
      throw new ConvexError("Enter the trip number");
    if (!MINOR.test(args.expectedMinor))
      throw new ConvexError("Enter the expected cash");
    if (!MINOR.test(args.declaredMinor))
      throw new ConvexError("Enter the counted cash");
    const expectedMinor = BigInt(args.expectedMinor);
    const declaredMinor = BigInt(args.declaredMinor);
    if (expectedMinor === declaredMinor)
      throw new ConvexError("The cash matches; no approval is needed");
    if (!(CASH_VARIANCE_REASONS as readonly string[]).includes(args.reasonCode))
      throw new ConvexError("Choose a cash difference reason");
    const trips = await ctx.db
      .query("vanTrips")
      .withIndex("by_organizationId_and_tripNumber", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("tripNumber", tripNumber),
      )
      .take(2);
    if (trips.length !== 1)
      throw new ConvexError("No trip matches this trip number");
    const trip = trips[0]!;
    const { identity } = await requireCapability(
      ctx,
      "van.cash.approve",
      trip.orgUnitId,
    );
    // The seller never approves their own cash difference.
    if (trip.salespersonSubject === identity.tokenIdentifier)
      throw new ConvexError("You cannot approve your own cash count");
    if (!COUNTABLE.includes(trip.status))
      throw new ConvexError("This trip is not on the road");
    const key = await cashApprovalKey(trip._id);
    if (!key) throw new ConvexError("Cash approval is not configured");
    const reasonCode = args.reasonCode as CashVarianceReason;
    const code = await cashApprovalCode(key, {
      tripId: trip._id,
      expectedMinor,
      declaredMinor,
      reasonCode,
    });
    const varianceMinor = (declaredMinor - expectedMinor).toString();
    // The audit keeps what was approved and by whom; the code itself is never stored.
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.cash.approval_issued",
      "vanTrip",
      trip._id,
      `${expectedMinor.toString()}|${declaredMinor.toString()}|${varianceMinor}|${reasonCode}`,
      Date.now(),
    );
    return {
      code,
      tripNumber: trip.tripNumber,
      expectedMinor: expectedMinor.toString(),
      declaredMinor: declaredMinor.toString(),
      varianceMinor,
      reasonCode,
    };
  },
});
