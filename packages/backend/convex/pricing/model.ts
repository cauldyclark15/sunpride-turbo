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
 * fulfilled; there is no receivables feed) plus this order. Over the limit never blocks the
 * order: it is recorded as `over` for the office to approve.
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
/** Units one product may be ordered in on the phone. */
export const MAX_ORDER_UNITS = 6;
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

async function listFor(ctx: Ctx, key: string | null, at: number) {
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
) {
  const key = channelKey(outlet?.channel) ?? channelKey(customer?.channel);
  if (key !== null) {
    const byChannel = await listFor(ctx, key, at);
    if (byChannel.found) return byChannel.list;
  }
  return (await listFor(ctx, null, at)).list;
}

/** Unit code → price (centavos) for one product, only where exactly one line is effective. */
export async function productPrices(
  ctx: Ctx,
  listId: Id<"priceLists">,
  productId: Id<"products">,
  at: number,
) {
  const rows = await ctx.db
    .query("priceListLines")
    .withIndex("by_priceListId_and_productId", (q) =>
      q.eq("priceListId", listId).eq("productId", productId),
    )
    .take(MAX_LINES_PER_PRODUCT + 1);
  const prices = new Map<string, number>();
  if (rows.length > MAX_LINES_PER_PRODUCT) return prices;
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
export async function orderUnits(ctx: Ctx, product: Doc<"products">) {
  const units = [product.uom];
  for (const id of product.sellingUomIds ?? []) {
    const row = await ctx.db.get(id);
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

export async function creditCheck(
  ctx: Ctx,
  customer: Doc<"customers"> | null,
  orderMinor: number,
  alsoPendingMinor: number,
): Promise<CreditCheck> {
  const limitMinor = creditLimitMinor(customer);
  if (!customer || limitMinor === null)
    return { status: "no_limit", limitMinor, openOrdersMinor: null };
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_customer", (q) => q.eq("customerCode", customer.code))
    .order("desc")
    .take(MAX_CREDIT_ORDERS + 1);
  if (orders.length > MAX_CREDIT_ORDERS)
    return { status: "unknown", limitMinor, openOrdersMinor: null };
  let open = alsoPendingMinor;
  for (const order of orders)
    if (
      (order.organizationId === undefined ||
        order.organizationId === SUNPRIDE_ORGANIZATION_ID) &&
      OPEN_STATUSES.has(order.status)
    )
      open += toMinor(order.total);
  return {
    status: open + orderMinor <= limitMinor ? "within" : "over",
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
  outletId: Id<"outlets">,
  customerId: Id<"customers"> | null,
  productIds: Id<"products">[],
  at: number,
): Promise<{ terms: OrderTerms; stamp: string }> {
  const outlet = await ctx.db.get(outletId);
  const customer = customerId ? await ctx.db.get(customerId) : null;
  const list = await priceListFor(ctx, outlet, customer, at);
  const lines: OrderTerms["lines"] = [];
  for (const productId of productIds) {
    const product = await ctx.db.get(productId);
    if (!product) continue;
    const prices = list
      ? await productPrices(ctx, list._id, product._id, at)
      : new Map<string, number>();
    for (const uom of await orderUnits(ctx, product))
      lines.push({ productId, uom, unitPriceMinor: prices.get(uom) ?? null });
  }
  const terms: OrderTerms = {
    outletId,
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
 * Server pricing of a submitted field order at `at` (the order's capture time). Lines with no
 * single effective price stay unpriced (the office prices them) and are excluded from the total.
 */
export async function priceFieldOrder(
  ctx: MutationCtx,
  visit: Pick<Doc<"visitExecutions">, "_id" | "outletId">,
  lines: { productId: Id<"products">; uom: string; quantity: number }[],
  at: number,
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
  // Earlier orders on the same call count against the limit too (they are not `orders` rows).
  const earlier = await ctx.db
    .query("fieldOrderPricings")
    .withIndex("by_visitId", (q) => q.eq("visitId", visit._id))
    .take(101);
  const pending = earlier.reduce((sum, row) => sum + row.totalMinor, 0);
  return {
    customerId: customer?._id ?? null,
    priceListId: list?._id ?? null,
    priceListSource: list?.source ?? null,
    currency: list?.currency ?? PRICE_CURRENCY,
    lines: priced,
    totalMinor,
    unpricedLines,
    credit: await creditCheck(ctx, customer, totalMinor, pending),
  };
}
