import { channel, fail, integer, quantityMilli, safe } from "./validation.js";

/**
 * Single effective channel list, else a default list. Ambiguity never falls back.
 * @param {any} db
 * @param {{organizationId:string, productId:string, uom:string, channelKey:string|null, customerCode:string|null, at:number}} q
 * @returns {Promise<{unitPriceCentavos:number|null,priceListId:string|null,source:string|null}>}
 */
export async function resolvePrice(db, q) {
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
/** F-502 compatibility exports: one versioned engine serves every server caller. */
export {
  validateScheme as validateRule,
  evaluateSchemes as applyPromotions,
} from "../tpm/engine.js";

/** @param {any} db @param {string} organizationId @param {number} at */
export async function activePromotions(db, organizationId, at) {
  const rows = await db`select p.*,v.scope as campaign_scope from promotions p
    left join campaign_versions v on v.id=p.campaign_version_id
    where p.organization_id=${organizationId} and p.deleted_at is null and p.status='active'
    and p.effective_from<=${new Date(at)} and (p.effective_to is null or p.effective_to>${new Date(at)})
    and (v.id is null or (v.status='active' and v.effective_from<=${new Date(at)} and v.effective_to>${new Date(at)}))
    order by p.precedence,p.code limit 501`;
  if (rows.length > 500)
    fail("More than 500 active schemes; narrow the catalog");
  return rows;
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
