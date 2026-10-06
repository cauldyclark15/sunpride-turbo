import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { VAN_MAX_CREDIT_TERMS_DAYS } from "./model";

/**
 * VAN-012 customer credit terms for van selling. The office sets terms per outlet
 * (effective-dated, one open row at a time); the van bootstrap sends the current terms with
 * each customer so the handheld can charge a sale to the account offline. No row means the
 * customer pays cash or another immediate method.
 *
 * `availableMinor` is the limit: open receivables are not on the server yet (sales post
 * through a later lane and SAP owns the ledger), so the handheld also subtracts credit it has
 * sold itself that the office has not acknowledged.
 */
const MAX_LIMIT_MINOR = 1_000_000_000_000n;

export async function creditFor(
  ctx: QueryCtx,
  outletId: Id<"outlets">,
  now: number,
): Promise<{ termsDays: number; availableMinor: string } | null> {
  const row = await ctx.db
    .query("outletCreditTerms")
    .withIndex("by_outletId_and_effectiveFrom", (q) =>
      q.eq("outletId", outletId).lte("effectiveFrom", now),
    )
    .order("desc")
    .first();
  if (
    !row ||
    row.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
    (row.effectiveTo !== undefined && row.effectiveTo <= now) ||
    row.currency !== "PHP"
  )
    return null;
  return {
    termsDays: row.termsDays,
    availableMinor: String(row.creditLimitMinor),
  };
}

/**
 * Office/seed configuration (no web screen yet): starts new terms for an outlet from
 * `effectiveFrom`, or ends credit when `terms` is null. Any open row is closed at that instant.
 */
export const setOutletCreditTerms = internalMutation({
  args: {
    outletId: v.id("outlets"),
    terms: v.union(
      v.null(),
      v.object({ termsDays: v.number(), creditLimitMinor: v.int64() }),
    ),
    effectiveFrom: v.number(),
    sourceRef: v.string(),
    actorSubject: v.string(),
  },
  returns: v.union(v.null(), v.id("outletCreditTerms")),
  handler: async (ctx, args) => {
    const outlet = await ctx.db.get(args.outletId);
    if (!outlet || outlet.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      throw new ConvexError("outlet_not_found");
    if (args.sourceRef.trim().length === 0 || args.sourceRef.length > 200)
      throw new ConvexError("invalid_source_ref");
    if (args.terms) {
      const { termsDays, creditLimitMinor } = args.terms;
      if (
        !Number.isInteger(termsDays) ||
        termsDays < 1 ||
        termsDays > VAN_MAX_CREDIT_TERMS_DAYS
      )
        throw new ConvexError("invalid_terms_days");
      if (creditLimitMinor <= 0n || creditLimitMinor > MAX_LIMIT_MINOR)
        throw new ConvexError("invalid_credit_limit");
    }
    const open = await ctx.db
      .query("outletCreditTerms")
      .withIndex("by_outletId_and_effectiveFrom", (q) =>
        q.eq("outletId", args.outletId),
      )
      .order("desc")
      .take(20);
    for (const row of open) {
      if (row.effectiveFrom >= args.effectiveFrom)
        throw new ConvexError("terms_already_scheduled");
      if (row.effectiveTo === undefined || row.effectiveTo > args.effectiveFrom)
        await ctx.db.patch(row._id, { effectiveTo: args.effectiveFrom });
    }
    if (!args.terms) return null;
    return await ctx.db.insert("outletCreditTerms", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      outletId: args.outletId,
      termsDays: args.terms.termsDays,
      creditLimitMinor: args.terms.creditLimitMinor,
      currency: "PHP",
      effectiveFrom: args.effectiveFrom,
      sourceRef: args.sourceRef.trim(),
      actorSubject: args.actorSubject,
      createdAt: Date.now(),
    });
  },
});
