import { resolvePrice } from "../orders/pricing.js";
import { activePromotions } from "../tpm/active.js";
import { evaluateSchemes as applyPromotions } from "../tpm/engine.js";
import { eligibilityFacts } from "../tpm/campaigns.js";
import { nativePromotions, schemeAccountKey } from "../tpm/native-context.js";
import { productFor } from "./facts.js";
import { integer, safeNumber, refuse, extend, rows, uuid } from "./model.js";
import {
  authorityRule,
  currentFiscalActor,
  enforceAuthority,
} from "../fiscal/authority.js";

/** F-511 use the same effective role/channel/value band as every campaign quote.
 * Only out-of-band amounts need an exact, independently authorized override.
 * @param {any} db @param {any} actor @param {any} facts @param {any} [env] */
export async function enforceVanSchemeAuthority(db, actor, facts, env) {
  actor = await currentFiscalActor(db, actor, facts);
  const rule = await authorityRule(db, actor, facts);
  if (integer(facts.amountCentavos) <= BigInt(rule.self_limit_centavos))
    return { ruleId: rule.id };
  return enforceAuthority(db, actor, facts, env);
}

/** F-502/F-511: reconstruct the handset's paid basket and evaluate the SAME engine.
 * A device promotion label, free quantity or line discount is never financial proof.
 * Call within the already reauthorized van business transaction, before any writes.
 * @param {any} db @param {any} trip @param {any} actor @param {any} env @param {any} p @param {any} customer */
export async function quoteVanSchemes(db, trip, actor, env, p, customer) {
  if (p.schemeEngineVersion === undefined) return null; // Frozen v1 compatibility path, not new scheme admission.
  if (p.schemeEngineVersion !== 1)
    refuse("Refresh the promotion engine", "invalid_request");
  const at = Number(p.deviceTime),
    c = { db, actor, env, now: at };
  const ids = await db`select distinct product_id from (
    select l.product_id from van_trip_load_lines l join van_trip_loads h on h.id=l.load_id
    where h.trip_id=${trip.id} and h.status<>'cancelled' and h.deleted_at is null and l.deleted_at is null
    union select product_id from inventory_balances where location_id=${trip.truck_location_id} and deleted_at is null
  ) products limit 501`;
  if (ids.length > 500) refuse("Narrow the trip catalog", "invalid_request");
  const products = new Map();
  for (const id of ids)
    products.set(id.product_id, await productFor(db, id.product_id, at));
  const facts = await eligibilityFacts(c, { outletId: customer.id, at });
  const offers = nativePromotions(
    await activePromotions(db, trip.organization_id, at),
    facts,
    [...products.values()].map((product) => ({
      productId: product.id,
      uom: product.base_code,
    })),
  );
  const paidLines = [],
    captured = new Map();
  for (const l of rows(p.lines)) {
    const product = products.get(uuid(l.productId));
    if (!product || captured.has(product.id))
      refuse("Sale products do not match the trip catalog", "invalid_request");
    const qty = integer(l.quantityBase, true),
      paid = l.paidBase === undefined ? qty : integer(l.paidBase),
      free = integer(l.freeBase ?? "0");
    if (paid + free !== qty)
      refuse("Paid and free units do not reconcile", "invalid_request");
    const price = await resolvePrice(db, {
      organizationId: trip.organization_id,
      productId: product.id,
      uom: product.base_code,
      channelKey: customer.channel,
      customerCode: customer.customerCode,
      outletId: customer.id,
      at,
    });
    if (price.unitPriceCentavos === null)
      refuse(
        "A scheme product needs a governed reference price",
        "invalid_request",
      );
    const gross = safeNumber(
      extend(BigInt(price.unitPriceCentavos), paid, product.quantityScale),
    );
    captured.set(product.id, {
      product,
      paid,
      free,
      price,
      gross,
      discount: 0,
    });
    if (paid > 0n) {
      if ((paid * 1000n) % product.quantityScale !== 0n)
        refuse(
          "Selling quantity needs an exact supported conversion",
          "invalid_request",
        );
      paidLines.push({
        productId: product.id,
        uom: product.base_code,
        quantity: safeNumber((paid * 1000n) / product.quantityScale) / 1000,
        unitPriceCentavos: price.unitPriceCentavos,
        lineTotalCentavos: gross,
        priceListId: price.priceListId,
      });
    }
  }
  if (!paidLines.length)
    refuse("A scheme sale needs paid products", "invalid_request");
  const quote = applyPromotions(paidLines, offers, facts);
  if (
    quote.promotionsApplied.some((p) => p.earnedCentavos > 0) &&
    (!customer.customerCode ||
      customer.customerCode !== (await schemeAccountKey(db, customer.id, at)))
  )
    refuse(
      "Link this store to its SAP account before earning rebates",
      "invalid_request",
    );
  paidLines.forEach((line, index) => {
    captured.get(line.productId).discount = quote.lineDiscounts[index];
  });
  const gifts = new Map();
  for (const promotion of quote.promotionsApplied) {
    for (const gift of promotion.freeGoods) {
      const line = captured.get(gift.productId),
        product = products.get(gift.productId);
      if (!line || !product || gift.uom !== product.base_code)
        refuse("Capture the exact governed free goods", "invalid_request");
      const base = BigInt(gift.quantity) * product.quantityScale;
      gifts.set(product.id, (gifts.get(product.id) ?? 0n) + base);
      gift.referenceValueCentavos = safeNumber(
        extend(
          BigInt(line.price.unitPriceCentavos),
          base,
          product.quantityScale,
        ),
      );
      promotion.freeGoodsValueCentavos =
        (promotion.freeGoodsValueCentavos ?? 0) + gift.referenceValueCentavos;
    }
  }
  for (const [id, line] of captured) {
    if (line.free !== (gifts.get(id) ?? 0n))
      refuse("Free units do not match the governed scheme", "invalid_request");
  }
  const benefitCentavos = quote.promotionsApplied.reduce(
    (n, promotion) =>
      n +
      BigInt(promotion.discountCentavos) +
      BigInt(promotion.earnedCentavos) +
      BigInt(promotion.freeGoodsValueCentavos ?? 0),
    0n,
  );
  safeNumber(benefitCentavos);
  return { quote: { ...quote, pricedAt: at }, captured, benefitCentavos };
}
