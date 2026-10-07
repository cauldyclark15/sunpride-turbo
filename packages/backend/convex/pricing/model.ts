/**
 * PRICING-001 (SP-0088, ADR-008): the governed price baseline for field orders.
 *
 * Which list prices an outlet: the single effective list for the outlet's channel (else its
 * linked customer's channel); with no channel list, the single effective default list
 * (`channelKey: null`). Two effective lists for the same key are ambiguous and price nothing:
 * the order is then "Priced by the office", never a guess.
 *
 * Which line prices a product in a unit: the single effective line of that list for the
 * product and unit code. Prices are whole centavos per one unit. The server prices every
 * submitted field order itself (`priceFieldOrder`); the phone's figures are a preview.
 *
 * Credit check: the customer's credit limit against its open orders (submitted but not yet
 * fulfilled; there is no receivables feed), every field order sent for the customer in the
 * pending window (any call, any salesperson), plus this order. Over the limit never blocks the
 * order: it is recorded as `over` for the office to approve. A line without a price has no
 * known amount, so an incomplete total can prove `over` but never `within` (it is `unknown`).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { activeAt } from "../org/validation";
import { toMinor } from "../dsr/model";
import { OPEN_STATUSES } from "../mobile/account_summary";

type Ctx = QueryCtx | MutationCtx;

/** Lists read per channel key; more fail closed (ambiguous, unpriced). */
export const MAX_LISTS_PER_CHANNEL = 20;
/** Line history read per list and product. */
export const MAX_LINES_PER_PRODUCT = 50;
/** Newest orders read for a credit check; a busier account reports `unknown`. */
export const MAX_CREDIT_ORDERS = 200;
/** Field orders sent for one customer that a credit check reads; more report `unknown`. */
export const MAX_PENDING_FIELD_ORDERS = 200;
/**
 * Days a sent field order counts as pending exposure. Field orders do not become `orders`
 * rows yet (the office keys them), so this sample default stands in for "not yet invoiced".
 */
export const FIELD_ORDER_PENDING_DAYS = 30;
const DAY_MS = 86_400_000;
/** Units one product may be ordered in on the phone. */
export const MAX_ORDER_UNITS = 6;
/** Lines one list is read in a single range; a bigger list is read per product instead. */
export const MAX_LIST_LINES = 4000;

/**
 * Reads shared by every outlet of one bootstrap: a snapshot touches each list, unit and
 * list/product pair once, inside the Convex per-transaction range budget.
 */
export type PricingCache = {
  lists: Map<string, { list: Doc<"priceLists"> | null; found: boolean }>;
  listLines: Map<Id<"priceLists">, Doc<"priceListLines">[] | null>;
  prices: Map<string, Map<string, number>>;
  units: Map<Id<"unitsOfMeasure">, Doc<"unitsOfMeasure"> | null>;
};
export function pricingCache(): PricingCache {
  return {
    lists: new Map(),
    listLines: new Map(),
    prices: new Map(),
    units: new Map(),
  };
}
export const PRICE_CURRENCY = "PHP";

export function channelKey(text: string | null | undefined) {
  const key = text?.trim().toLowerCase() ?? "";
  return key.length > 0 ? key : null;
}

function effective(
  row: { effectiveFrom: number; effectiveTo?: number },
  at: number,
) {
  return activeAt(row.effectiveFrom, row.effectiveTo, at);
}

async function listFor(
  ctx: Ctx,
  key: string | null,
  at: number,
  cache?: PricingCache,
) {
  const cacheKey = key ?? "\u0000default";
  const cached = cache?.lists.get(cacheKey);
  if (cached) return cached;
  const result = await readList(ctx, key, at);
  cache?.lists.set(cacheKey, result);
  return result;
}

async function readList(ctx: Ctx, key: string | null, at: number) {
  const rows = await ctx.db
    .query("priceLists")
    .withIndex("by_organizationId_and_channelKey", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("channelKey", key),
    )
    .take(MAX_LISTS_PER_CHANNEL + 1);
  if (rows.length > MAX_LISTS_PER_CHANNEL) return { list: null, found: true };
  const live = rows.filter(
    (row) => row.status === "active" && effective(row, at),
  );
  if (live.length === 0) return { list: null, found: false };
  return { list: live.length === 1 ? live[0]! : null, found: true };
}

/** The outlet's price list at `at`, or null (none, or ambiguous). */
export async function priceListFor(
  ctx: Ctx,
  outlet: Pick<Doc<"outlets">, "channel"> | null,
  customer: Pick<Doc<"customers">, "channel"> | null,
  at: number,
  cache?: PricingCache,
) {
  const key = channelKey(outlet?.channel) ?? channelKey(customer?.channel);
  if (key !== null) {
    const byChannel = await listFor(ctx, key, at, cache);
    if (byChannel.found) return byChannel.list;
  }
  return (await listFor(ctx, null, at, cache)).list;
}

/** Unit code → price (centavos) for one product, only where exactly one line is effective. */
export async function productPrices(
  ctx: Ctx,
  listId: Id<"priceLists">,
  productId: Id<"products">,
  at: number,
  cache?: PricingCache,
) {
  const key = `${listId}|${productId}`;
  const cached = cache?.prices.get(key);
  if (cached) return cached;
  const prices = pricesOf(await linesOf(ctx, listId, productId, cache), at);
  cache?.prices.set(key, prices);
  return prices;
}

/** One list-wide read per snapshot when the list is small enough, else one per product. */
async function linesOf(
  ctx: Ctx,
  listId: Id<"priceLists">,
  productId: Id<"products">,
  cache?: PricingCache,
) {
  if (cache) {
    let all = cache.listLines.get(listId);
    if (all === undefined) {
      const rows = await ctx.db
        .query("priceListLines")
        .withIndex("by_priceListId_and_productId", (q) =>
          q.eq("priceListId", listId),
        )
        .take(MAX_LIST_LINES + 1);
      all = rows.length > MAX_LIST_LINES ? null : rows;
      cache.listLines.set(listId, all);
    }
    if (all) {
      const rows = all.filter((row) => row.productId === productId);
      return rows.length > MAX_LINES_PER_PRODUCT ? null : rows;
    }
  }
  const rows = await ctx.db
    .query("priceListLines")
    .withIndex("by_priceListId_and_productId", (q) =>
      q.eq("priceListId", listId).eq("productId", productId),
    )
    .take(MAX_LINES_PER_PRODUCT + 1);
  return rows.length > MAX_LINES_PER_PRODUCT ? null : rows;
}

function pricesOf(rows: Doc<"priceListLines">[] | null, at: number) {
  const prices = new Map<string, number>();
  if (!rows) return prices;
  const byUnit = new Map<string, number[]>();
  for (const row of rows) {
    if (
      row.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
      !effective(row, at) ||
      !Number.isSafeInteger(row.unitPriceMinor) ||
      row.unitPriceMinor < 0
    )
      continue;
    byUnit.set(row.uom, [...(byUnit.get(row.uom) ?? []), row.unitPriceMinor]);
  }
  for (const [unit, values] of byUnit)
    if (new Set(values).size === 1) prices.set(unit, values[0]!);
  return prices;
}

/**
 * Units a product may be ordered in: its own unit first, then its active selling units
 * (product master `sellingUomIds`), at most MAX_ORDER_UNITS.
 */
export async function orderUnits(
  ctx: Ctx,
  product: Doc<"products">,
  cache?: PricingCache,
) {
  const units = [product.uom];
  for (const id of product.sellingUomIds ?? []) {
    let row = cache?.units.get(id);
    if (row === undefined) {
      row = await ctx.db.get(id);
      cache?.units.set(id, row);
    }
    if (
      !row?.active ||
      row.organizationId !== SUNPRIDE_ORGANIZATION_ID ||
      units.includes(row.code)
    )
      continue;
    units.push(row.code);
    if (units.length >= MAX_ORDER_UNITS) break;
  }
  return units;
}

/** The customer an outlet was linked to at `at` (single active link), else null. */
export async function customerAt(
  ctx: Ctx,
  outletId: Id<"outlets">,
  at: number,
) {
  const rows = await ctx.db
    .query("outletCustomerLinks")
    .withIndex("by_outletId_and_effectiveFrom", (q) =>
      q.eq("outletId", outletId).lte("effectiveFrom", at),
    )
    .order("desc")
    .take(50);
  const live = rows.filter((row) =>
    activeAt(row.effectiveFrom, row.effectiveTo, at),
  );
  if (live.length !== 1) return null;
  return await ctx.db.get(live[0]!.customerId);
}

export type CreditCheck = Doc<"fieldOrderPricings">["credit"];

/** Credit limit in centavos, or null when none is set. */
export function creditLimitMinor(
  customer: Pick<Doc<"customers">, "creditLimit"> | null,
) {
  return customer &&
    Number.isFinite(customer.creditLimit) &&
    customer.creditLimit > 0
    ? toMinor(customer.creditLimit)
    : null;
}

/**
 * `orderMinor` and `pending.minor` are the KNOWN amounts; `incomplete` says some of the order
 * or the pending exposure has no price. Known amounts over the limit are `over`; otherwise an
 * incomplete figure is `unknown`, never `within`.
 */
export async function creditCheck(
  ctx: Ctx,
  customer: Doc<"customers"> | null,
  orderMinor: number,
  pending: { minor: number; incomplete: boolean; overflow?: boolean },
): Promise<CreditCheck> {
  const limitMinor = creditLimitMinor(customer);
  if (!customer || limitMinor === null)
    return { status: "no_limit", limitMinor, openOrdersMinor: null };
  if (pending.overflow)
    return { status: "unknown", limitMinor, openOrdersMinor: null };
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_customer", (q) => q.eq("customerCode", customer.code))
    .order("desc")
    .take(MAX_CREDIT_ORDERS + 1);
  if (orders.length > MAX_CREDIT_ORDERS)
    return { status: "unknown", limitMinor, openOrdersMinor: null };
  let open = pending.minor;
  for (const order of orders)
    if (
      (order.organizationId === undefined ||
        order.organizationId === SUNPRIDE_ORGANIZATION_ID) &&
      OPEN_STATUSES.has(order.status)
    )
      open += toMinor(order.total);
  return {
    status:
      open + orderMinor > limitMinor
        ? "over"
        : pending.incomplete
          ? "unknown"
          : "within",
    limitMinor,
    openOrdersMinor: open,
  };
}

export type OrderTerms = {
  outletId: string;
  priceList: {
    id: string;
    code: string;
    name: string;
    currency: string;
    sample: boolean;
  } | null;
  lines: { productId: string; uom: string; unitPriceMinor: number | null }[];
};

/**
 * The phone's order terms for one outlet: every orderable unit of each account-setup product,
 * with its price when the outlet's list has exactly one for it. `stamp` changes with any
 * figure, so a price edit forces a fresh snapshot.
 */
export async function orderTermsFor(
  ctx: Ctx,
  outlet: Doc<"outlets">,
  customer: Doc<"customers"> | null,
  products: Doc<"products">[],
  at: number,
  cache: PricingCache,
): Promise<{ terms: OrderTerms; stamp: string }> {
  const list = await priceListFor(ctx, outlet, customer, at, cache);
  const lines: OrderTerms["lines"] = [];
  for (const product of products) {
    const prices = list
      ? await productPrices(ctx, list._id, product._id, at, cache)
      : new Map<string, number>();
    for (const uom of await orderUnits(ctx, product, cache))
      lines.push({
        productId: product._id,
        uom,
        unitPriceMinor: prices.get(uom) ?? null,
      });
  }
  const terms: OrderTerms = {
    outletId: outlet._id,
    priceList: list
      ? {
          id: list._id,
          code: list.code,
          name: list.name,
          currency: list.currency,
          sample: list.source === "sample",
        }
      : null,
    lines,
  };
  return { terms, stamp: JSON.stringify(terms) };
}

/**
 * Server pricing of a submitted field order at `at` (the order's capture time, never before the
 * call's check-in). Lines with no single effective price stay unpriced (the office prices them)
 * and are excluded from the known total; the credit check then cannot say `within`.
 */
export async function priceFieldOrder(
  ctx: MutationCtx,
  visit: Pick<Doc<"visitExecutions">, "_id" | "outletId">,
  lines: { productId: Id<"products">; uom: string; quantity: number }[],
  at: number,
  now: number,
) {
  const outlet = await ctx.db.get(visit.outletId);
  const customer = await customerAt(ctx, visit.outletId, at);
  const list = await priceListFor(ctx, outlet, customer, at);
  const priced = [];
  let totalMinor = 0;
  let unpricedLines = 0;
  for (const line of lines) {
    const unitPriceMinor = list
      ? ((await productPrices(ctx, list._id, line.productId, at)).get(
          line.uom,
        ) ?? null)
      : null;
    const lineTotalMinor =
      unitPriceMinor === null ? null : unitPriceMinor * line.quantity;
    if (lineTotalMinor === null) unpricedLines++;
    else totalMinor += lineTotalMinor;
    priced.push({ ...line, unitPriceMinor, lineTotalMinor });
  }
  // Field orders already sent for this customer (this call, earlier calls, other salespeople)
  // are not `orders` rows yet, so they count against the limit here.
  const pending = customer
    ? await pendingFieldOrders(ctx, customer._id, now)
    : { minor: 0, incomplete: false };
  return {
    customerId: customer?._id ?? null,
    priceListId: list?._id ?? null,
    priceListSource: list?.source ?? null,
    currency: list?.currency ?? PRICE_CURRENCY,
    lines: priced,
    totalMinor,
    unpricedLines,
    credit: await creditCheck(ctx, customer, totalMinor, {
      ...pending,
      incomplete: pending.incomplete || unpricedLines > 0,
    }),
  };
}

/** Known amount of the customer's field orders sent in the pending window. */
export async function pendingFieldOrders(
  ctx: Ctx,
  customerId: Id<"customers">,
  now: number,
) {
  const rows = await ctx.db
    .query("fieldOrderPricings")
    .withIndex("by_customerId_and_serverTime", (q) =>
      q
        .eq("customerId", customerId)
        .gte("serverTime", now - FIELD_ORDER_PENDING_DAYS * DAY_MS),
    )
    .take(MAX_PENDING_FIELD_ORDERS + 1);
  if (rows.length > MAX_PENDING_FIELD_ORDERS)
    return { minor: 0, incomplete: true, overflow: true };
  let minor = 0;
  let incomplete = false;
  for (const row of rows) {
    if (row.organizationId !== SUNPRIDE_ORGANIZATION_ID) continue;
    minor += row.totalMinor;
    if (row.unpricedLines > 0) incomplete = true;
  }
  return { minor, incomplete };
}
