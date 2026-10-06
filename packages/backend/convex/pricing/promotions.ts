import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt } from "../org/validation";

type Ctx = QueryCtx | MutationCtx;

/**
 * SP-0129 / ADR-008: governed promotions on the SP-0088 price lists. Promotions never combine
 * (assumption until Sunpride says otherwise); the van handheld evaluates them (SP-0105).
 */
export const MAX_PROMOTIONS = 100;

/**
 * Active promotions for a list (or every list) in force at `at`, in code order. More active
 * promotions than one read can hold returns `overflow: true` and no promotions: a partial set
 * would silently drop a governed rule, so the caller ships none (fail closed).
 */
export async function promotionsAt(
  ctx: Ctx,
  priceListId: Id<"priceLists"> | null,
  at: number,
) {
  const rows = await ctx.db
    .query("promotions")
    .withIndex("by_organizationId_and_status", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("status", "active"),
    )
    .take(MAX_PROMOTIONS + 1);
  if (rows.length > MAX_PROMOTIONS) return { overflow: true, promotions: [] };
  return {
    overflow: false,
    promotions: rows
      .filter(
        (row) =>
          activeAt(row.effectiveFrom, row.effectiveTo, at) &&
          (row.priceListId === undefined || row.priceListId === priceListId),
      )
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}
