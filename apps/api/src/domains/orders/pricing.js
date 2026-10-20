import { resolveAccountPrice } from "../mt/sap.js";
import {
  channel,
  divide,
  fail,
  integer,
  quantityMilli,
  safe,
} from "./validation.js";

/**
 * Single effective channel list, else a default list. Ambiguity never falls back.
 * @param {any} db
 * @param {{organizationId:string, productId:string, uom:string, channelKey:string|null, customerCode:string|null, at:number}} q
 * @returns {Promise<{unitPriceCentavos:number|null,priceListId:string|null,source:string|null}>}
 */
export async function resolvePrice(db, q) {
  const accountPrice = await resolveAccountPrice(db, q);
  if (accountPrice) return accountPrice;
  const at = new Date(q.at);
  let key = channel(q.channelKey);
  if (!key && q.customerCode) {
    const [customer] =
      await db`select channel from customers where code = ${q.customerCode} and deleted_at is null`;
    key = channel(customer?.channel);
  }
  const lists =
    await db`select * from price_lists where organization_id = ${q.organizationId}
    and status = 'active' and deleted_at is null and currency = 'PHP'
    and effective_from <= ${at} and (effective_to is null or effective_to > ${at})
    and (channel_key is null or channel_key = ${key})`;
  const specific = key
    ? lists.filter((/** @type {any} */ l) => l.channel_key === key)
    : [];
  const candidates = specific.length
    ? specific
    : lists.filter((/** @type {any} */ l) => l.channel_key === null);
  if (candidates.length !== 1)
    return {
      unitPriceCentavos: null,
      priceListId: null,
      source: candidates.length ? "ambiguous" : "missing",
    };
  const list = candidates[0];
  const prices =
    await db`select unit_price_minor from price_list_lines where price_list_id = ${list.id}
    and organization_id = ${q.organizationId} and product_id = ${q.productId} and uom = ${q.uom}
    and deleted_at is null and effective_from <= ${at} and (effective_to is null or effective_to > ${at})`;
  const price = prices.length === 1 ? Number(prices[0].unit_price_minor) : null;
  return {
    unitPriceCentavos:
      price !== null && Number.isSafeInteger(price) && price >= 0
        ? price
        : null,
    priceListId: list.id,
    source: list.source,
  };
}

/**
 * Exposure is open captured orders, not a claim about SAP AR. Includes all salespeople.
 * Unknown inputs outrank no-limit/within. Field captures linked to orders are not counted twice.
 * @param {any} db @param {{customerCode:string,addCentavos:number|null}} q
 * @returns {Promise<{status:'within'|'over'|'no_limit'|'unknown',limit:number|null,exposure:number|null}>}
 */
export async function creditCheck(db, q) {
  const [customer] =
    await db`select id, (credit_limit * 100)::bigint as limit_centavos from customers where code = ${q.customerCode} and deleted_at is null`;
  const rawLimit = customer ? Number(customer.limit_centavos) : null;
  const limit =
    rawLimit !== null && rawLimit > 0 && Number.isSafeInteger(rawLimit)
      ? rawLimit
      : null;
  // numeric(14,2) always returns two decimals; use SQL for the minor-unit conversion.
  const [amounts] = await db`select
    coalesce(sum(coalesce(total_centavos, (total * 100)::bigint)), 0)::bigint as amount,
    count(*) filter(where not amount_known)::integer as unknown
    from orders where customer_code = ${q.customerCode} and deleted_at is null and (organization_id is null or organization_id = 'sunpride')
      and status in ('submitted','pending_approval','approved','review_required')`;
  const [pending] =
    await db`select coalesce(sum(f.total_minor),0)::bigint as amount,
    count(*) filter(where f.unpriced_lines > 0)::integer as unknown
    from field_order_pricings f where f.customer_id = ${customer?.id ?? null} and f.organization_id = 'sunpride'
      and f.server_time >= now() - interval '30 days' and f.deleted_at is null
      and not exists(select 1 from orders o where o.source_activity_id = f.activity_id and o.deleted_at is null)`;
  const known = Number(amounts.amount) + Number(pending.amount);
  const unknown =
    q.addCentavos === null ||
    !customer ||
    Number(amounts.unknown) > 0 ||
    Number(pending.unknown) > 0;
  const exposure = unknown ? null : known + integer(q.addCentavos);
  if (unknown || exposure === null || !Number.isSafeInteger(exposure))
    return { status: "unknown", limit, exposure: null };
  return {
    status:
      limit === null || limit <= 0
        ? "no_limit"
        : exposure > limit
          ? "over"
          : "within",
    limit: limit && limit > 0 ? limit : null,
    exposure,
  };
}

/** @typedef {{productId:string,uom:string,quantity:number,unitPriceCentavos:number|null,lineTotalCentavos:number|null,priceListId?:string|null,source?:string|null}} PricedLine */
/** Validate the native promotion-rule shape. @param {any} rule */
export function validateRule(rule) {
  if (!rule || typeof rule !== "object") fail("Promotion rule is required");
  const units =
    rule.kind === "buy_x_get_y"
      ? [rule.buy, rule.free]
      : rule.kind === "percent_off"
        ? [rule.item]
        : rule.kind === "bundle"
          ? rule.components
          : null;
  if (!Array.isArray(units) || !units.length || units.length > 100)
    fail("Promotion kind or components are invalid");
  const seen = new Set();
  for (const u of units) {
    if (
      !u ||
      typeof u.productId !== "string" ||
      typeof u.uom !== "string" ||
      !u.uom.trim() ||
      !Number.isSafeInteger(u.quantity) ||
      u.quantity <= 0 ||
      u.quantity > 1_000_000
    )
      fail("Promotion units need product, unit and a positive whole quantity");
    const key = `${u.productId}|${u.uom}`;
    if (rule.kind === "bundle" && seen.has(key))
      fail("Bundle components must be unique");
    seen.add(key);
  }
  if (rule.kind === "percent_off")
    integer(rule.percentOffBasisPoints, "Discount basis points", 10000);
  if (rule.kind === "bundle") integer(rule.bundlePriceMinor, "Bundle price");
  return rule;
}

/**
 * One best governed promotion; never stack. Buy-X adds free goods, never silently removes paid units.
 * @param {PricedLine[]} lines @param {any[]} promotions
 */
export function applyPromotions(lines, promotions) {
  const known = lines.every((l) => l.lineTotalCentavos !== null);
  const subtotal = safe(
    lines.reduce((n, l) => n + BigInt(l.lineTotalCentavos ?? 0), 0n),
  );
  /** @type {any[]} */
  const candidates = [];
  for (const p of promotions) {
    const r = validateRule(p.rule);
    const units =
      r.kind === "bundle"
        ? r.components
        : r.kind === "percent_off"
          ? [r.item]
          : [r.buy];
    const matching = units.map((/** @type {any} */ u) =>
      lines.find(
        (l) =>
          l.productId === u.productId &&
          l.uom === u.uom &&
          (p.price_list_id == null || l.priceListId === p.price_list_id),
      ),
    );
    if (
      matching.some(
        (/** @type {any} */ l) => !l || l.unitPriceCentavos === null,
      )
    )
      continue;
    const multiples = Math.min(
      ...units.map((/** @type {any} */ u, /** @type {number} */ i) =>
        Number(
          quantityMilli(matching[i].quantity) / (BigInt(u.quantity) * 1000n),
        ),
      ),
    );
    if (multiples < 1) continue;
    let discount = 0;
    /** @type {any[]} */
    let freeGoods = [];
    if (r.kind === "percent_off")
      discount = safe(
        divide(
          BigInt(matching[0].lineTotalCentavos) *
            BigInt(r.percentOffBasisPoints),
          10000n,
        ),
      );
    if (r.kind === "bundle") {
      const normal = units.reduce(
        (
          /** @type {bigint} */ n,
          /** @type {any} */ u,
          /** @type {number} */ i,
        ) => n + BigInt(matching[i].unitPriceCentavos) * BigInt(u.quantity),
        0n,
      );
      discount = Math.max(
        0,
        safe((normal - BigInt(r.bundlePriceMinor)) * BigInt(multiples)),
      );
    }
    if (r.kind === "buy_x_get_y")
      freeGoods = [
        {
          ...r.free,
          quantity: safe(BigInt(r.free.quantity) * BigInt(multiples)),
        },
      ];
    if (discount > 0 || freeGoods.length)
      candidates.push({
        id: p.id,
        code: p.code,
        name: p.name,
        kind: r.kind,
        discountCentavos: discount,
        freeGoods,
        lineIndexes: matching.map((/** @type {any} */ l) => lines.indexOf(l)),
      });
  }
  candidates.sort(
    (a, b) =>
      b.discountCentavos - a.discountCentavos || a.code.localeCompare(b.code),
  );
  const applied = candidates.slice(0, 1);
  const discount = Math.min(subtotal, applied[0]?.discountCentavos ?? 0);
  return {
    subtotalCentavos: known ? subtotal : null,
    knownSubtotalCentavos: subtotal,
    totalCentavos: known ? subtotal - discount : null,
    promotionsApplied: applied,
  };
}

/** @param {any} db @param {string} organizationId @param {number} at */
export async function activePromotions(db, organizationId, at) {
  return await db`select * from promotions where organization_id = ${organizationId} and deleted_at is null and status = 'active'
    and effective_from <= ${new Date(at)} and (effective_to is null or effective_to > ${new Date(at)}) order by code`;
}

/** Selling UOM -> integer scaled base units. @param {any} db @param {any} product @param {string} uom @param {number} quantity @param {number} at */
export async function baseQuantity(db, product, uom, quantity, at) {
  const milli = quantityMilli(quantity);
  const scale = BigInt(product.quantity_scale ?? 1);
  if (scale <= 0n) fail("Product quantity scale needs setup");
  if (product.uom === uom && !product.base_uom_id) {
    if ((milli * scale) % 1000n) fail("Quantity is not an exact base unit");
    return safe((milli * scale) / 1000n);
  }
  const [unit] =
    await db`select * from units_of_measure where organization_id = ${product.organization_id ?? "sunpride"} and code = ${uom} and active and deleted_at is null`;
  if (!unit) fail("This selling unit is not available");
  if (product.base_uom_id === unit.id) {
    if ((milli * scale) % 1000n) fail("Quantity is not an exact base unit");
    return safe((milli * scale) / 1000n);
  }
  const [allowed] =
    await db`select 1 from product_selling_uoms where product_id = ${product.id} and uom_id = ${unit.id} and deleted_at is null`;
  if (!allowed && product.uom !== uom)
    fail("This unit is not sold for this product");
  const conversions =
    await db`select * from uom_conversions where organization_id = ${product.organization_id ?? "sunpride"}
    and (product_id = ${product.id} or product_id is null) and from_uom_id = ${unit.id} and to_uom_id = ${product.base_uom_id}
    and active and deleted_at is null and effective_from <= ${new Date(at)} and (effective_to is null or effective_to > ${new Date(at)})`;
  const specific = conversions.filter(
    (/** @type {any} */ c) => c.product_id === product.id,
  );
  const candidates = specific.length ? specific : conversions;
  if (candidates.length !== 1) fail("An exact unit conversion needs setup");
  const c = candidates[0];
  const n = milli * scale * BigInt(c.numerator),
    d = 1000n * BigInt(c.denominator);
  if (d <= 0n || n <= 0n || n % d !== 0n)
    fail("Quantity is not an exact base unit");
  return safe(n / d);
}
