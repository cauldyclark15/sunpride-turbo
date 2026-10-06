import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import type { PromotionRule } from "./validators";

type Ctx = QueryCtx | MutationCtx;

/**
 * SP-0129 / ADR-008 price resolution. Prices are resolved server-side from the governed
 * baseline: outlet channel -> exactly one active price list -> exactly one effective line for
 * the product and unit at the instant. Missing or ambiguous data fails closed (null), which
 * the apps show as "Priced by the office"; nothing is ever derived from `products.unitPrice`.
 */
export const MAX_PRICE_LISTS = 50;
/** Lines read per list; more fails closed instead of silently truncating a price list. */
export const MAX_PRICE_LIST_LINES = 2_000;
export const MAX_PROMOTIONS = 100;
const MAX_LINE_HISTORY = 50;

/**
 * Channel names as the field says them map to one key. Assumption until Sunpride confirms
 * pricing scope (SP-0033): price by channel only — Key Accounts, Route Sales (PMOT, RDS,
 * extruck; the call of 2 Oct 2026 groups them as the Route Salesman) and Public Market.
 */
const CHANNEL_ALIASES: Record<string, string> = {
  KA: "KEY_ACCOUNTS",
  KAS: "KEY_ACCOUNTS",
  KEY_ACCOUNT: "KEY_ACCOUNTS",
  MODERN_TRADE: "KEY_ACCOUNTS",
  RS: "ROUTE_SALES",
  PMOT: "ROUTE_SALES",
  PMOT_EXTRUCK: "ROUTE_SALES",
  RDS: "ROUTE_SALES",
  GENERAL_TRADE: "ROUTE_SALES",
  ROUTE_SALES_PMOT: "ROUTE_SALES",
  PMS: "PUBLIC_MARKET",
  PM_STALLS: "PUBLIC_MARKET",
  PUBLIC_MARKET_STALLS: "PUBLIC_MARKET",
};

export function channelKey(channel: string | undefined | null) {
  const key = (channel ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return CHANNEL_ALIASES[key] ?? key;
}

export function effectiveAt(
  row: { effectiveFrom: number; effectiveTo?: number },
  at: number,
) {
  return (
    row.effectiveFrom <= at &&
    (row.effectiveTo === undefined || at < row.effectiveTo)
  );
}

export async function activePriceLists(ctx: Ctx) {
  return ctx.db
    .query("priceLists")
    .withIndex("by_organizationId_and_status", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("status", "active"),
    )
    .take(MAX_PRICE_LISTS);
}

/** The single active list for a channel, or null when none or more than one matches. */
export async function priceListForChannel(
  ctx: Ctx,
  channel: string | undefined | null,
  lists?: Doc<"priceLists">[],
) {
  const key = channelKey(channel);
  if (!key) return null;
  const matches = (lists ?? (await activePriceLists(ctx))).filter(
    (list) => channelKey(list.channel) === key,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export async function priceListForOutlet(
  ctx: Ctx,
  outlet: Pick<Doc<"outlets">, "channel">,
  lists?: Doc<"priceLists">[],
) {
  return priceListForChannel(ctx, outlet.channel, lists);
}

/** The single effective line for product+unit, or null (none, or conflicting rows). */
export async function priceLineAt(
  ctx: Ctx,
  priceListId: Id<"priceLists">,
  productId: Id<"products">,
  uomId: Id<"unitsOfMeasure">,
  at: number,
) {
  const rows = await ctx.db
    .query("priceListLines")
    .withIndex("by_priceListId_and_productId_and_uomId", (q) =>
      q
        .eq("priceListId", priceListId)
        .eq("productId", productId)
        .eq("uomId", uomId),
    )
    .take(MAX_LINE_HISTORY + 1);
  if (rows.length > MAX_LINE_HISTORY) return null;
  const effective = rows.filter((row) => effectiveAt(row, at));
  return effective.length === 1 ? effective[0]! : null;
}

/**
 * Every line of a list effective at `at`, one per product+unit. A product+unit with
 * overlapping effective rows is dropped (fail closed); an oversized list throws.
 */
export async function effectiveLines(
  ctx: Ctx,
  priceListId: Id<"priceLists">,
  at: number,
) {
  const rows = await ctx.db
    .query("priceListLines")
    .withIndex("by_priceListId_and_effectiveFrom", (q) =>
      q.eq("priceListId", priceListId).lte("effectiveFrom", at),
    )
    .take(MAX_PRICE_LIST_LINES + 1);
  if (rows.length > MAX_PRICE_LIST_LINES)
    throw new ConvexError("reference_data_too_large");
  const byKey = new Map<string, Doc<"priceListLines"> | null>();
  for (const row of rows) {
    if (!effectiveAt(row, at)) continue;
    const key = `${row.productId}:${row.uomId}`;
    byKey.set(key, byKey.has(key) ? null : row);
  }
  return [...byKey.values()].filter(
    (row): row is Doc<"priceListLines"> => row !== null,
  );
}

/** Active promotions for a list (or every list) in force at `at`, in code order. */
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
    .take(MAX_PROMOTIONS);
  return rows
    .filter(
      (row) =>
        effectiveAt(row, at) &&
        (row.priceListId === undefined || row.priceListId === priceListId),
    )
    .sort((a, b) => a.code.localeCompare(b.code));
}

export type PricedLineInput = {
  productId: Id<"products">;
  uomId: Id<"unitsOfMeasure">;
  quantity: number;
  unitPriceMinor: bigint | null;
};
export type PricedLine = PricedLineInput & {
  grossMinor: bigint | null;
  discountMinor: bigint;
  freeQuantity: number;
  promotionCode: string | null;
};
export type FreeGood = {
  productId: Id<"products">;
  uomId: Id<"unitsOfMeasure">;
  quantity: number;
  promotionCode: string;
};
type PromotionInput = { code: string; rule: PromotionRule };

const sameUnit = (
  line: PricedLineInput,
  unit: { productId: Id<"products">; uomId: Id<"unitsOfMeasure"> },
) => line.productId === unit.productId && line.uomId === unit.uomId;

/**
 * Pure promotion evaluation (ADR-008). Promotions are applied in code order and never
 * combine: a line takes part in at most one promotion (assumption until Sunpride answers
 * whether promotions stack). Any rule that needs an unpriced line, a missing component or a
 * non-whole quantity is skipped, never approximated.
 */
export function applyPromotions(
  input: PricedLineInput[],
  promotions: PromotionInput[],
) {
  const lines: PricedLine[] = input.map((line) => ({
    ...line,
    grossMinor:
      line.unitPriceMinor === null
        ? null
        : line.unitPriceMinor * BigInt(line.quantity),
    discountMinor: 0n,
    freeQuantity: 0,
    promotionCode: null,
  }));
  const freeGoods: FreeGood[] = [];
  const applied: string[] = [];
  const valid = (n: number) => Number.isSafeInteger(n) && n > 0;
  for (const promotion of promotions) {
    const rule = promotion.rule;
    if (rule.kind === "buy_x_get_y") {
      if (!valid(rule.buy.quantity) || !valid(rule.free.quantity)) continue;
      const line = lines.find(
        (row) => row.promotionCode === null && sameUnit(row, rule.buy),
      );
      if (!line) continue;
      const multiples = Math.floor(line.quantity / rule.buy.quantity);
      if (multiples < 1) continue;
      const quantity = multiples * rule.free.quantity;
      line.promotionCode = promotion.code;
      if (sameUnit(line, rule.free)) line.freeQuantity += quantity;
      freeGoods.push({
        productId: rule.free.productId,
        uomId: rule.free.uomId,
        quantity,
        promotionCode: promotion.code,
      });
      applied.push(promotion.code);
    } else if (rule.kind === "percent_off") {
      const bp = rule.percentOffBasisPoints;
      if (
        !valid(rule.item.quantity) ||
        !Number.isSafeInteger(bp) ||
        bp < 1 ||
        bp > 10_000
      )
        continue;
      const line = lines.find(
        (row) =>
          row.promotionCode === null &&
          sameUnit(row, rule.item) &&
          row.quantity >= rule.item.quantity &&
          row.grossMinor !== null,
      );
      if (!line || line.grossMinor === null) continue;
      line.discountMinor = (line.grossMinor * BigInt(bp) + 5_000n) / 10_000n;
      line.promotionCode = promotion.code;
      applied.push(promotion.code);
    } else {
      if (
        rule.components.length < 2 ||
        rule.bundlePriceMinor < 0n ||
        rule.components.some((c) => !valid(c.quantity))
      )
        continue;
      const parts = rule.components.map((component) => ({
        component,
        line: lines.find(
          (row) => row.promotionCode === null && sameUnit(row, component),
        ),
      }));
      if (
        parts.some(({ line }) => !line || line.unitPriceMinor === null) ||
        new Set(parts.map(({ line }) => line)).size !== parts.length
      )
        continue;
      const bundles = Math.min(
        ...parts.map(({ component, line }) =>
          Math.floor(line!.quantity / component.quantity),
        ),
      );
      if (bundles < 1) continue;
      const regular = parts.reduce(
        (sum, { component, line }) =>
          sum + line!.unitPriceMinor! * BigInt(component.quantity),
        0n,
      );
      const perBundle = regular - rule.bundlePriceMinor;
      if (perBundle <= 0n) continue;
      const total = perBundle * BigInt(bundles);
      // Split the bundle saving across its components by their regular value.
      let left = total;
      parts.forEach(({ component, line }, index) => {
        const share =
          index === parts.length - 1
            ? left
            : (total * line!.unitPriceMinor! * BigInt(component.quantity)) /
              regular;
        line!.discountMinor = share;
        line!.promotionCode = promotion.code;
        left -= share;
      });
      applied.push(promotion.code);
    }
  }
  const priced = lines.every((line) => line.grossMinor !== null);
  const grossMinor = lines.reduce((sum, l) => sum + (l.grossMinor ?? 0n), 0n);
  const discountMinor = lines.reduce((sum, l) => sum + l.discountMinor, 0n);
  return {
    lines,
    freeGoods,
    applied,
    priced,
    grossMinor,
    discountMinor,
    totalMinor: grossMinor - discountMinor,
  };
}
