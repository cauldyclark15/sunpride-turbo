/**
 * BETA SAMPLE DATA (SP-0088, see docs/runbooks/FIELD_ORDER_PRICING.md). Made-up price lists and
 * store credit limits so field orders show real-looking prices and a credit check before
 * Sunpride's governed lists exist. Every row is marked: price lists carry `source: "sample"`
 * and a `SAMPLE-` code; changed credit limits are recorded in `sampleDataChanges`. `reset`
 * removes exactly those rows and restores the previous limits. Real lists use
 * `source: "office"` and win automatically once the sample lists are reset.
 *
 * Batched (one page of products/customers per call) to stay inside transaction limits; call
 * again with the returned cursor until `isDone`.
 */
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { toBase, type Caches } from "../mobile/reference";
import { orderUnits, PRICE_CURRENCY } from "./model";

export const SAMPLE_PRICE_LISTS = [
  {
    code: "SAMPLE-KA",
    name: "Key Accounts (sample)",
    channelKey: "key accounts",
    factor: 0.96,
  },
  {
    code: "SAMPLE-RS",
    name: "Route Sales / PMOT (sample)",
    channelKey: "route sales",
    factor: 1,
  },
  {
    code: "SAMPLE-PM",
    name: "Public Market (sample)",
    channelKey: "public market",
    factor: 1.04,
  },
  {
    code: "SAMPLE-STD",
    name: "Standard (sample)",
    channelKey: null,
    factor: 1,
  },
] as const;

const MAX_BATCH = 100;

/** Stable small hash of a code, so the same product always gets the same sample price. */
function codeHash(code: string) {
  let h = 2166136261;
  for (const ch of code) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** A piece price between ₱15.00 and ₱160.00 in 25-centavo steps. */
export function samplePiecePriceMinor(code: string) {
  return 1500 + (codeHash(code) % 581) * 25;
}

/** A store credit limit between ₱50,000 and ₱300,000 in ₱5,000 steps (pesos). */
export function sampleCreditLimit(code: string) {
  return 50_000 + (codeHash(code) % 51) * 5_000;
}

/** Units of `uom` per one unit of the product's own unit, from in-force conversions. */
async function unitsPer(
  ctx: MutationCtx,
  caches: Caches,
  product: Doc<"products">,
  uom: string,
  now: number,
) {
  if (uom === product.uom) return 1;
  const ids = product.sellingUomIds ?? [];
  const toBaseOf = async (code: string) => {
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (row?.code !== code) continue;
      if (id === product.baseUomId) return 1;
      const { conversion } = await toBase(ctx, caches, product, id, now);
      return conversion
        ? Number(conversion.numerator) / Number(conversion.denominator)
        : null;
    }
    return null;
  };
  const target = await toBaseOf(uom);
  const own = await toBaseOf(product.uom);
  if (target === null) return null;
  // The product's own unit is the base unit when it is not a listed selling unit.
  return target / (own ?? 1);
}

async function sampleList(
  ctx: MutationCtx,
  spec: (typeof SAMPLE_PRICE_LISTS)[number],
  now: number,
): Promise<Id<"priceLists">> {
  const existing = await ctx.db
    .query("priceLists")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", spec.code),
    )
    .unique();
  if (existing) return existing._id;
  return await ctx.db.insert("priceLists", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    code: spec.code,
    name: spec.name,
    channelKey: spec.channelKey,
    currency: PRICE_CURRENCY,
    status: "active",
    source: "sample",
    effectiveFrom: 0,
    updatedAt: now,
  });
}

/** Sample prices for one page of active products in every sample list (idempotent). */
export const seed = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    batch: v.optional(v.number()),
  },
  returns: v.object({
    linesCreated: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { cursor, batch }) => {
    const now = Date.now();
    const lists = [];
    for (const spec of SAMPLE_PRICE_LISTS)
      lists.push({ spec, id: await sampleList(ctx, spec, now) });
    const page = await ctx.db
      .query("products")
      .paginate({ cursor, numItems: Math.min(batch ?? 50, MAX_BATCH) });
    const caches: Caches = { uoms: new Map(), global: new Map() };
    let linesCreated = 0;
    for (const product of page.page) {
      if (
        !product.active ||
        (product.organizationId &&
          product.organizationId !== SUNPRIDE_ORGANIZATION_ID)
      )
        continue;
      const piece = samplePiecePriceMinor(product.code);
      for (const uom of await orderUnits(ctx, product)) {
        const per = await unitsPer(ctx, caches, product, uom, now);
        if (per === null || !Number.isFinite(per) || per <= 0) continue;
        for (const { spec, id } of lists) {
          const existing = await ctx.db
            .query("priceListLines")
            .withIndex("by_priceListId_and_productId", (q) =>
              q.eq("priceListId", id).eq("productId", product._id),
            )
            .take(50);
          if (existing.some((line) => line.uom === uom)) continue;
          // Bigger packs are a little cheaper per piece.
          const bulk = per >= 12 ? 0.97 : 1;
          const unitPriceMinor =
            Math.round((piece * per * spec.factor * bulk) / 25) * 25;
          await ctx.db.insert("priceListLines", {
            organizationId: SUNPRIDE_ORGANIZATION_ID,
            priceListId: id,
            productId: product._id,
            uom,
            unitPriceMinor,
            effectiveFrom: 0,
            updatedAt: now,
          });
          linesCreated++;
        }
      }
    }
    return {
      linesCreated,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Sample credit limits for one page of customers that have none (idempotent, recorded). */
export const seedCreditLimits = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    batch: v.optional(v.number()),
  },
  returns: v.object({
    customersChanged: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { cursor, batch }) => {
    const now = Date.now();
    const page = await ctx.db
      .query("customers")
      .paginate({ cursor, numItems: Math.min(batch ?? 50, MAX_BATCH) });
    let customersChanged = 0;
    for (const customer of page.page) {
      if (
        !customer.active ||
        (Number.isFinite(customer.creditLimit) && customer.creditLimit > 0)
      )
        continue;
      const sampleValue = sampleCreditLimit(customer.code);
      await ctx.db.insert("sampleDataChanges", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        kind: "customer_credit_limit",
        customerId: customer._id,
        previousValue: customer.creditLimit,
        sampleValue,
        createdAt: now,
      });
      await ctx.db.patch(customer._id, {
        creditLimit: sampleValue,
        updatedAt: now,
      });
      customersChanged++;
    }
    return {
      customersChanged,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Removes up to `batch` sample rows per call: sample price-list lines, then the sample lists,
 * then restores sample credit limits (only where the office has not changed them since).
 */
export const reset = internalMutation({
  args: { batch: v.optional(v.number()) },
  returns: v.object({ removed: v.number(), isDone: v.boolean() }),
  handler: async (ctx, { batch }) => {
    const limit = Math.min(batch ?? 200, 500);
    let removed = 0;
    for (const spec of SAMPLE_PRICE_LISTS) {
      const list = await ctx.db
        .query("priceLists")
        .withIndex("by_organizationId_and_code", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("code", spec.code),
        )
        .unique();
      if (!list || list.source !== "sample") continue;
      const lines = await ctx.db
        .query("priceListLines")
        .withIndex("by_priceListId_and_productId", (q) =>
          q.eq("priceListId", list._id),
        )
        .take(limit - removed);
      for (const line of lines) await ctx.db.delete(line._id);
      removed += lines.length;
      if (removed >= limit) return { removed, isDone: false };
      await ctx.db.delete(list._id);
      removed++;
      if (removed >= limit) return { removed, isDone: false };
    }
    const changes = await ctx.db
      .query("sampleDataChanges")
      .withIndex("by_organizationId_and_customerId", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .take(limit - removed);
    for (const change of changes) {
      const customer = await ctx.db.get(change.customerId);
      if (customer && customer.creditLimit === change.sampleValue)
        await ctx.db.patch(customer._id, {
          creditLimit: change.previousValue,
          updatedAt: Date.now(),
        });
      await ctx.db.delete(change._id);
      removed++;
    }
    return { removed, isDone: removed < limit };
  },
});
