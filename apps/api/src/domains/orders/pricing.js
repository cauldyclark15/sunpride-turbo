import { resolveSapPrice } from "../integration/replicas.js";
import { sapCreditCheck } from "../integration/credit.js";
import { resolveAccountPrice, resolveAccountCredit } from "../mt/sap.js";
import {
  channel,
  divide,
  fail,
  integer,
  quantityMilli,
  safe,
} from "./validation.js";

/** F-016 SAP condition replica is authoritative. Signature is the shared ORDERS seam.
 * @param {any} db
 * @param {{organizationId:string,productId:string,uom:string,channelKey:string|null,customerCode:string|null,outletId?:string|null,at:number}} q
 * @returns {Promise<{unitPriceCentavos:number|null,priceListId:string|null,source:string,taxCode?:string,taxBasisPoints?:number,taxTreatment?:string|null,taxInclusive?:boolean,sourceTaxInclusive?:boolean,sourceUnitPriceCentavos?:number,sapKey?:string,sapVersion?:number,effectiveFrom?:number,effectiveTo?:number|null}>}
 */
export async function resolvePrice(db, q) {
  if (q.outletId) {
    const [outlet] =
      await db`select channel from outlets where id=${q.outletId} and organization_id=${q.organizationId} and deleted_at is null`;
    if (!outlet)
      return {
        unitPriceCentavos: null,
        priceListId: null,
        source: "missing_outlet",
      };
    // Store channel is a persisted eligibility fact, not the accounting account's
    // channel or a caller-selected way to obtain another channel's condition.
    q = { ...q, channelKey: outlet.channel };
  }
  const accountPrice = await resolveAccountPrice(db, q);
  if (accountPrice) return accountPrice;
  let key = channel(q.channelKey);
  if (!key && q.customerCode) {
    const [c] =
      await db`select channel from customers where code=${q.customerCode} and deleted_at is null`;
    key = channel(c?.channel);
  }
  return resolveSapPrice(db, { ...q, channelKey: key });
}
/** F-112 credit is a SAP call, never local order/AR arithmetic. Signature stays stable.
 * @param {any} db @param {{customerCode:string,addCentavos:number|null}} q
 */
export async function creditCheck(db, q) {
  const accountCredit = await resolveAccountCredit(db, q);
  return accountCredit ?? sapCreditCheck(db, q.customerCode, q.addCentavos);
}

/** @typedef {{productId:string,uom:string,quantity:number,unitPriceCentavos:number|null,lineTotalCentavos:number|null,priceListId?:string|null,source?:string|null}} PricedLine */
/** F-502 compatibility exports: one versioned engine serves every server caller. */
export {
  validateScheme as validateRule,
  evaluateSchemes as applyPromotions,
} from "../tpm/engine.js";

export { activePromotions } from "../tpm/active.js";

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
