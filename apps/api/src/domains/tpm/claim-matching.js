import { fail } from "../orders/validation.js";
/** F-506 a quantity claim names ONE source SKU/UOM line, with its captured conversion.
 * Photo/checklist/PO bytes cannot certify money. The existing exclusive source link prevents reuse.
 * @param {any[]} sources @param {any} r */
export function provenClaimValue(sources, r) {
  const monetary = sources.filter(
    (s) =>
      ["source_document", "secondary_sale", "attendance"].includes(s.kind) &&
      Number.isSafeInteger(s.amountCentavos) &&
      s.amountCentavos >= 0,
  );
  if (r.quantity_units == null)
    return monetary.length
      ? monetary.reduce((n, s) => n + BigInt(s.amountCentavos), 0n)
      : null;
  const lines = monetary.filter(
    (s) => s.productId === r.product_id && s.uom === r.uom,
  );
  if (lines.length !== 1) return null;
  const source = lines[0];
  if (
    !Number.isSafeInteger(source.unitsPerUom) ||
    source.unitsPerUom <= 0 ||
    !/^\d+$/.test(String(source.quantityBase))
  )
    return null;
  const available = BigInt(source.quantityBase),
    requested = BigInt(r.quantity_units) * BigInt(source.unitsPerUom);
  if (available <= 0n || requested <= 0n || requested > available) return null;
  return (BigInt(source.amountCentavos) * requested) / available;
}
/** Only metadata added by this reader version is omitted when checking an older immutable snapshot.
 * Fingerprint, value, quantity, dates and original authority fields are never relaxed.
 * @param {any} source @param {any} snapshot */
export function comparableEvidence(source, snapshot) {
  if (!source) return source;
  const value = { ...source };
  for (const key of [
    "productId",
    "storageId",
    "evidenceVersion",
    "partyId",
    "partyType",
  ])
    if (!(key in snapshot)) delete value[key];
  return value;
}
/** @param {any} b */
export function claimQuantity(b) {
  if (b.quantityUnits == null) {
    if (b.productId != null || b.uom != null)
      fail("A source SKU and UOM require a claim quantity");
    return { productId: null, uom: null, quantity: null };
  }
  if (!Number.isSafeInteger(b.quantityUnits) || b.quantityUnits <= 0)
    fail("Enter positive whole source selling units");
  return { productId: b.productId, uom: b.uom, quantity: b.quantityUnits };
}
