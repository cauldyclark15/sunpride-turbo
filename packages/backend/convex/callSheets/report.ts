import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { monthBounds } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { requireOutletCapability } from "../outlets/validation";
import { headerDTOValidator } from "./accounts";
import { accountFor, CALL_SHEET_WEEKS, headerDTO } from "./model";
import { CALL_SHEET_MEASURES, type CallSheetMeasure } from "./validators";

export const MAX_MONTH_ENTRIES_PER_WEEK = 2_000;

const quantity = v.union(v.number(), v.null());
const weekCells = v.object({
  week: v.number(),
  order: quantity,
  beginningInventory: quantity,
  take: quantity,
  delivered: quantity,
  offtake: quantity,
  endInventory: quantity,
});
type WeekCells = typeof weekCells.type;

function emptyWeek(week: number): WeekCells {
  return {
    week,
    order: null,
    beginningInventory: null,
    take: null,
    delivered: null,
    offtake: null,
    endInventory: null,
  };
}

/**
 * Annex C month view for one account: header plus, per product and week, the latest value
 * captured for each measure (a later visit in the same week fills or corrects a cell; a blank
 * capture never erases an earlier value).
 */
export const month = query({
  args: { outletId: v.id("outlets"), localMonth: v.string() },
  returns: v.object({
    outlet: v.object({
      id: v.id("outlets"),
      code: v.string(),
      name: v.string(),
    }),
    localMonth: v.string(),
    configured: v.boolean(),
    revision: v.union(v.number(), v.null()),
    header: headerDTOValidator,
    rows: v.array(
      v.object({
        productId: v.id("products"),
        code: v.string(),
        name: v.string(),
        uom: v.string(),
        barcode: v.union(v.string(), v.null()),
        pricing: v.union(v.string(), v.null()),
        onSheet: v.boolean(),
        weeks: v.array(weekCells),
      }),
    ),
    capturedVisits: v.number(),
    lastCapturedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, { outletId, localMonth }) => {
    monthBounds(localMonth);
    const scope = await requireOutletCapability(ctx, "outlet.read", outletId);
    await requireCapability(ctx, "visit.read", scope.orgUnitId);
    const account = await accountFor(ctx, outletId);
    const cells = new Map<Id<"products">, Map<number, WeekCells>>();
    const visits = new Set<Id<"visitExecutions">>();
    let lastCapturedAt: number | null = null;
    for (const week of CALL_SHEET_WEEKS) {
      const entries = await ctx.db
        .query("callSheetEntries")
        .withIndex("by_outletId_and_localMonth_and_week", (q) =>
          q
            .eq("outletId", outletId)
            .eq("localMonth", localMonth)
            .eq("week", week),
        )
        .take(MAX_MONTH_ENTRIES_PER_WEEK + 1);
      if (entries.length > MAX_MONTH_ENTRIES_PER_WEEK)
        throw new ConvexError("Too many call sheet captures for one week");
      // Index order within a week is creation order, so later captures overwrite earlier ones.
      for (const entry of entries) {
        if (entry.organizationId !== SUNPRIDE_ORGANIZATION_ID) continue;
        visits.add(entry.visitId);
        lastCapturedAt = Math.max(lastCapturedAt ?? 0, entry.serverTime);
        let byWeek = cells.get(entry.productId);
        if (!byWeek) cells.set(entry.productId, (byWeek = new Map()));
        const cell = byWeek.get(week) ?? emptyWeek(week);
        for (const measure of CALL_SHEET_MEASURES)
          if (entry[measure] !== null)
            cell[measure as CallSheetMeasure] = entry[measure];
        byWeek.set(week, cell);
      }
    }
    const order: { productId: Id<"products">; pricing: string | null }[] = (
      account?.lines ?? []
    ).map((line) => ({
      productId: line.productId,
      pricing: line.pricing ?? null,
    }));
    const onSheet = new Set(order.map((line) => line.productId));
    const extra: Doc<"products">[] = [];
    for (const productId of cells.keys()) {
      if (onSheet.has(productId)) continue;
      const product = await ctx.db.get(productId);
      if (product) extra.push(product);
    }
    extra.sort((a, b) => a.code.localeCompare(b.code));
    for (const product of extra)
      order.push({ productId: product._id, pricing: null });
    const rows = [];
    for (const line of order) {
      const product = await ctx.db.get(line.productId);
      const barcode = (
        await ctx.db
          .query("productBarcodes")
          .withIndex("by_organizationId_and_productId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", line.productId),
          )
          .take(20)
      ).find((row) => row.active);
      const byWeek = cells.get(line.productId);
      rows.push({
        productId: line.productId,
        code: product?.code ?? "",
        name: product?.name ?? "Removed product",
        uom: product?.uom ?? "",
        barcode: barcode?.barcode ?? null,
        pricing: line.pricing,
        onSheet: onSheet.has(line.productId),
        weeks: CALL_SHEET_WEEKS.map(
          (week) => byWeek?.get(week) ?? emptyWeek(week),
        ),
      });
    }
    return {
      outlet: {
        id: scope.outlet._id,
        code: scope.outlet.code,
        name: scope.outlet.name,
      },
      localMonth,
      configured: !!account,
      revision: account?.revision ?? null,
      header: account
        ? headerDTO(account.header)
        : headerDTO({
            accountName: scope.outlet.name,
            ...(scope.outlet.address ? { address: scope.outlet.address } : {}),
          }),
      rows,
      capturedVisits: visits.size,
      lastCapturedAt,
    };
  },
});
