import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { activeAt } from "../org/validation";
import {
  MAX_LINES_PER_PRODUCT,
  channelKey,
  customerAt,
  listFor,
  pricingCache,
  priceListFor,
  productPrices,
  type PricingCache,
} from "./model";
import { promotionsAt } from "./promotions";

type Ctx = QueryCtx | MutationCtx;

/**
 * Van trucks sell at the Route Sales / PMOT list (call of 2 Oct 2026: PMOT, PMOT Extruck and
 * RDS are the same route-selling job), else the default list, resolved exactly as a field
 * outlet of that channel would be (SP-0088 `priceListFor`). SP-0105: a customer whose outlet
 * (else linked accounting customer) channel has its own list is priced by that list instead.
 */
export const VAN_PRICE_CHANNEL = "Route Sales";

/** Effective window of the line(s) giving `price` for `uom` at `at` (all agree on the value). */
async function lineWindow(
  ctx: Ctx,
  listId: Id<"priceLists">,
  productId: Id<"products">,
  uom: string,
  price: number,
  at: number,
) {
  const rows = await ctx.db
    .query("priceListLines")
    .withIndex("by_priceListId_and_productId", (q) =>
      q.eq("priceListId", listId).eq("productId", productId),
    )
    .take(MAX_LINES_PER_PRODUCT + 1);
  const live = rows.filter(
    (row) =>
      row.uom === uom &&
      row.unitPriceMinor === price &&
      activeAt(row.effectiveFrom, row.effectiveTo, at),
  );
  if (live.length === 0) return null;
  const ends = live.flatMap((row) =>
    row.effectiveTo === undefined ? [] : [row.effectiveTo],
  );
  return {
    effectiveFrom: Math.max(...live.map((row) => row.effectiveFrom)),
    effectiveTo: ends.length > 0 ? Math.min(...ends) : null,
  };
}

/** Promotion units travel as unit codes (`uomCode`), money as decimal strings (van-v1). */
function wirePromotion(promotion: Doc<"promotions">) {
  const unit = (u: {
    productId: Id<"products">;
    uom: string;
    quantity: number;
  }) => ({ productId: u.productId, uomCode: u.uom, quantity: u.quantity });
  const rule = promotion.rule;
  return {
    promotionId: promotion._id,
    code: promotion.code,
    name: promotion.name,
    priceListId: promotion.priceListId ?? null,
    effectiveFrom: promotion.effectiveFrom,
    effectiveTo: promotion.effectiveTo ?? null,
    rule:
      rule.kind === "buy_x_get_y"
        ? { kind: rule.kind, buy: unit(rule.buy), free: unit(rule.free) }
        : rule.kind === "percent_off"
          ? {
              kind: rule.kind,
              item: unit(rule.item),
              percentOffBasisPoints: rule.percentOffBasisPoints,
            }
          : {
              kind: rule.kind,
              components: rule.components.map(unit),
              bundlePriceMinor: String(rule.bundlePriceMinor),
            },
  };
}

/** Price lines one bootstrap carries (van-v1 `priceLines.maxItems`). */
export const VAN_MAX_PRICE_LINES = 600;
/** Promotions one bootstrap carries (van-v1 `promotions.maxItems`); more ship none (fail closed). */
export const VAN_MAX_PROMOTIONS = 50;

type VanProduct = { productId: Id<"products">; uomCode: string };
type ListDoc = Doc<"priceLists">;

/**
 * SP-0105: the list that prices one van customer — its outlet channel's list, else its linked
 * accounting customer's channel list, else the van Route Sales list (`base`). A channel with
 * competing effective lists prices nothing (null), exactly as SP-0088 field pricing.
 */
async function customerList(
  ctx: Ctx,
  outletId: Id<"outlets">,
  base: ListDoc | null,
  at: number,
  cache: PricingCache,
) {
  const outlet = await ctx.db.get(outletId);
  const key =
    channelKey(outlet?.channel) ??
    channelKey((await customerAt(ctx, outletId, at))?.channel);
  if (key !== null) {
    const byChannel = await listFor(ctx, key, at, cache);
    if (byChannel.found) return byChannel.list;
  }
  return base;
}

async function listLines(
  ctx: Ctx,
  list: ListDoc,
  products: VanProduct[],
  at: number,
  cache: PricingCache,
) {
  const lines = [];
  for (const product of products) {
    const price = (
      await productPrices(ctx, list._id, product.productId, at, cache)
    ).get(product.uomCode);
    if (price === undefined) continue;
    const window = await lineWindow(
      ctx,
      list._id,
      product.productId,
      product.uomCode,
      price,
      at,
    );
    if (!window) continue;
    lines.push({
      priceListId: list._id,
      priceListCode: list.code,
      productId: product.productId,
      uomCode: product.uomCode,
      unitPriceMinor: String(price),
      currency: list.currency,
      ...window,
    });
  }
  return lines;
}

/**
 * VAN bootstrap pricing: the Route Sales line of each truck product in the van's selling unit
 * (only where SP-0088 resolves exactly one effective price), plus that list's promotions whose
 * products are all on the truck. Integers travel as decimal strings (van-v1). A promotion
 * read that overflows ships no promotions (fail closed).
 *
 * SP-0105: with `outletIds` (the trip's customers), each customer's own list (see
 * `customerList`) is shipped too, with its promotions, and `customerPriceListIds` names the
 * list pricing each customer (null = none: the handheld sells nothing at a price to it). Lists
 * are added base first, then by code, while their lines fit the bootstrap bound; a list that
 * does not fit is not shipped and its customers are null (never priced from another list).
 */
export async function vanCustomerPricing(
  ctx: Ctx,
  products: VanProduct[],
  outletIds: Id<"outlets">[],
  at: number,
) {
  const cache = pricingCache();
  const base = await priceListFor(
    ctx,
    { channel: VAN_PRICE_CHANNEL },
    null,
    at,
    cache,
  );
  const wanted = new Map<Id<"outlets">, ListDoc | null>();
  for (const outletId of outletIds)
    wanted.set(outletId, await customerList(ctx, outletId, base, at, cache));
  const candidates = new Map<Id<"priceLists">, ListDoc>();
  for (const list of wanted.values())
    if (list && list._id !== base?._id) candidates.set(list._id, list);
  const ordered = [
    ...(base ? [base] : []),
    ...[...candidates.values()].sort((a, b) => a.code.localeCompare(b.code)),
  ];
  const shipped = new Set<Id<"priceLists">>();
  const priceLines: Awaited<ReturnType<typeof listLines>> = [];
  for (const list of ordered) {
    const lines = await listLines(ctx, list, products, at, cache);
    if (priceLines.length + lines.length > VAN_MAX_PRICE_LINES) continue;
    priceLines.push(...lines);
    shipped.add(list._id);
  }
  const onTruck = new Set<string>(products.map((p) => p.productId));
  const promotions = new Map<Id<"promotions">, Doc<"promotions">>();
  let overflow = false;
  for (const listId of shipped) {
    const read = await promotionsAt(ctx, listId, at);
    if (read.overflow) overflow = true;
    for (const promotion of read.promotions) {
      const rule = promotion.rule;
      const units =
        rule.kind === "buy_x_get_y"
          ? [rule.buy, rule.free]
          : rule.kind === "percent_off"
            ? [rule.item]
            : rule.components;
      if (units.every((u) => onTruck.has(u.productId)))
        promotions.set(promotion._id, promotion);
    }
  }
  const promotionList =
    overflow || promotions.size > VAN_MAX_PROMOTIONS
      ? []
      : [...promotions.values()]
          .sort((a, b) => a.code.localeCompare(b.code))
          .map(wirePromotion);
  const customerPriceListIds: Record<string, Id<"priceLists"> | null> = {};
  for (const [outletId, list] of wanted)
    customerPriceListIds[outletId] =
      list && shipped.has(list._id) ? list._id : null;
  return { priceLines, promotions: promotionList, customerPriceListIds };
}

/** The van list's lines and promotions alone (no customers). */
export async function vanPricing(ctx: Ctx, products: VanProduct[], at: number) {
  const { priceLines, promotions } = await vanCustomerPricing(
    ctx,
    products,
    [],
    at,
  );
  return { priceLines, promotions };
}
