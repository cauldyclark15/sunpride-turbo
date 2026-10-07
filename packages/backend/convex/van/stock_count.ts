import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { audit } from "../org/validation";
import { STOCK_VARIANCE_REASONS, type TripStatus, VAN_POLICY } from "./model";
import { approvalCodeFor, approvalSecret, b64url, hmac } from "./voids";

/**
 * VAN-023 end-of-trip stock reconciliation: supervisor approval of a truck stock variance.
 *
 * Van sales, voids, returns and damage are saved on the handheld (the gateway has no sale upload
 * yet), so only the handheld knows the stock the truck should hold. At the end of the trip the
 * seller counts every product on the truck by SKU in its own unit (sellable and damaged apart);
 * each line that differs from the expected stock needs a reason. When anything differs the
 * handheld shows a 12-character count code (a SHA-256 fingerprint of the whole count: every
 * product, status, expected, counted and reason), the number of lines that differ and the base
 * units short and over. The seller reads those to a supervisor, who gets the 8-digit approval
 * code here; the handheld checks it offline with the trip key from its bootstrap, then writes
 * the approved ADJUSTMENT movements that bring its truck stock to the count.
 *
 * key  = HMAC-SHA256(MOBILE_CURSOR_SECRET, "sunpride/van-stock-approval/v1|" + tripId)  (base64url)
 * code = RFC 4226 dynamic truncation of
 *        HMAC-SHA256(key, "STOCK|v1|tripId|countCode|varianceLines|shortBase|overBase") mod 10^8.
 * Vectors: packages/domain-contracts/fixtures/van-v1/stock-approval.json.
 *
 * Its own key label (not the void or cash key) means no other approval code approves stock.
 */
const KEY_LABEL = "sunpride/van-stock-approval/v1|";
const enc = new TextEncoder();

/** The trip's stock-approval key (base64url, 43 chars), or null when the secret is not configured. */
export async function stockApprovalKey(tripId: string): Promise<string | null> {
  const configured = approvalSecret();
  if (!configured) return null;
  return b64url(await hmac(enc.encode(configured), KEY_LABEL + tripId));
}

/** Exported for the cross-language vector test; `key` is the base64url trip key. */
export async function stockApprovalCode(
  key: string,
  args: {
    tripId: string;
    countCode: string;
    varianceLines: number;
    shortBase: bigint;
    overBase: bigint;
  },
): Promise<string> {
  return approvalCodeFor(
    key,
    `STOCK|v1|${args.tripId}|${args.countCode}|${args.varianceLines}|${args.shortBase.toString()}|${args.overBase.toString()}`,
  );
}

/** The bootstrap's `policy.stockReconciliation` for a trip (key null when no trip or no secret). */
export async function stockReconciliationPolicy(tripId: string | null) {
  return {
    approvalRequired: VAN_POLICY.stockVarianceRequiresApproval,
    reasons: [...STOCK_VARIANCE_REASONS],
    key: tripId ? await stockApprovalKey(tripId) : null,
  };
}

/** Stock is counted at the end of a trip that went on the road. */
const COUNTABLE: readonly TripStatus[] = [
  "active",
  "closing",
  "reconciling",
  "review_required",
];
const BASE = /^\d{1,18}$/;

/** The count code as typed ("abcd-ef12 3456") → "ABCDEF123456", or null when it is not 12 hex characters. */
export function normalizeCountCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(code) ? code : null;
}

export const issueApprovalCode = mutation({
  args: {
    tripNumber: v.string(),
    countCode: v.string(),
    varianceLines: v.number(),
    shortBase: v.string(),
    overBase: v.string(),
  },
  returns: v.object({
    code: v.string(),
    tripNumber: v.string(),
    countCode: v.string(),
    varianceLines: v.number(),
    shortBase: v.string(),
    overBase: v.string(),
  }),
  handler: async (ctx, args) => {
    // Role first, so a caller without the capability learns nothing about trip numbers.
    await requireCapability(ctx, "van.stock.approve");
    const tripNumber = args.tripNumber.trim().toUpperCase();
    if (!tripNumber || tripNumber.length > 64)
      throw new ConvexError("Enter the trip number");
    const countCode = normalizeCountCode(args.countCode);
    if (!countCode)
      throw new ConvexError("Enter the 12-character count code from the phone");
    if (
      !Number.isInteger(args.varianceLines) ||
      args.varianceLines < 1 ||
      args.varianceLines > VAN_POLICY.maxStockCountProducts * 2
    )
      throw new ConvexError("Enter how many lines differ");
    if (!BASE.test(args.shortBase))
      throw new ConvexError("Enter the units short (0 if none)");
    if (!BASE.test(args.overBase))
      throw new ConvexError("Enter the units over (0 if none)");
    const shortBase = BigInt(args.shortBase);
    const overBase = BigInt(args.overBase);
    if (shortBase === 0n && overBase === 0n)
      throw new ConvexError("The stock matches; no approval is needed");
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
      "van.stock.approve",
      trip.orgUnitId,
    );
    // The seller never approves their own stock count.
    if (trip.salespersonSubject === identity.tokenIdentifier)
      throw new ConvexError("You cannot approve your own stock count");
    if (!COUNTABLE.includes(trip.status))
      throw new ConvexError("This trip is not on the road");
    const key = await stockApprovalKey(trip._id);
    if (!key) throw new ConvexError("Stock approval is not configured");
    const code = await stockApprovalCode(key, {
      tripId: trip._id,
      countCode,
      varianceLines: args.varianceLines,
      shortBase,
      overBase,
    });
    // The audit keeps what was approved and by whom; the code itself is never stored.
    await audit(
      ctx,
      identity.tokenIdentifier,
      "van.stock.approval_issued",
      "vanTrip",
      trip._id,
      `${countCode}|${args.varianceLines}|${shortBase.toString()}|${overBase.toString()}`,
      Date.now(),
    );
    return {
      code,
      tripNumber: trip.tripNumber,
      countCode,
      varianceLines: args.varianceLines,
      shortBase: shortBase.toString(),
      overBase: overBase.toString(),
    };
  },
});
