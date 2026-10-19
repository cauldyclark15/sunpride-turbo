import { resolvePrice } from "../orders/pricing.js";
import { invalid, number, ORGANIZATION, productPolicy } from "./common.js";

/** Pure presentation: base integers NEVER acquire a case label without a conversion.
 * @param {number} base @param {{basePerCase:number|null,basePerPiece:number|null,baseCode:string}} units @param {number|null} pricePerBase
 */
export function quantity(base, units, pricePerBase) {
  const { basePerCase, basePerPiece, baseCode } = units;
  const absolute = Math.abs(base),
    sign = base < 0 ? -1 : 1;
  const cases = basePerCase ? Math.floor(absolute / basePerCase) * sign : null;
  const rest = basePerCase ? absolute % basePerCase : absolute;
  const pieces = basePerPiece ? (rest / basePerPiece) * sign : null;
  const display =
    basePerCase && basePerPiece
      ? `${base < 0 ? "−" : ""}${cases ? `${Math.abs(cases)} cs${pieces ? " " : ""}` : ""}${pieces ? `${Math.abs(pieces)} pc` : !cases ? "0 pc" : ""}`
      : basePerPiece
        ? `${base / basePerPiece} pc`
        : `${base} base (${baseCode}; unit setup needed)`;
  const valueCentavos =
    base === 0
      ? 0
      : pricePerBase == null
        ? null
        : Math.round(base * pricePerBase);
  if (valueCentavos != null && !Number.isSafeInteger(valueCentavos))
    invalid("Stock value exceeds the supported range", "value_overflow");
  return { base, cases, pieces, display, valueCentavos };
}

/** Product-specific effective conversion edges override global edges; a contradictory
 * conversion graph fails closed, instead of silently inflating cases.
 * @param {any} db @param {any} product @param {number} at
 */
export async function unitInfo(db, product, at) {
  const org = product.organization_id ?? ORGANIZATION;
  const uoms =
    await db`select id,code from units_of_measure where organization_id=${org} and active and deleted_at is null`;
  const conversions =
    await db`select * from uom_conversions where organization_id=${org} and (product_id=${product.id} or product_id is null) and active and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  const scale = Number(product.quantity_scale ?? 1),
    base = uoms.find((/** @type {any} */ u) => u.id === product.base_uom_id);
  /** @type {Map<string,any>} */ const pairs = new Map();
  for (const r of conversions) {
    const k = `${r.from_uom_id}:${r.to_uom_id}`;
    const old = pairs.get(k);
    if (old?.product_id && !r.product_id) continue;
    if (old && Boolean(old.product_id) === Boolean(r.product_id))
      invalid("Overlapping unit conversions need correction", "ambiguous_uom");
    pairs.set(k, r);
  }
  /** @type {Map<string,Array<{to:string,ratio:number}>>} */ const graph =
    new Map();
  for (const r of pairs.values()) {
    const ratio = Number(r.numerator) / Number(r.denominator);
    if (!(ratio > 0) || !Number.isFinite(ratio))
      invalid("Invalid catalog conversion", "invalid_uom");
    graph.set(r.from_uom_id, [
      ...(graph.get(r.from_uom_id) ?? []),
      { to: r.to_uom_id, ratio },
    ]);
    graph.set(r.to_uom_id, [
      ...(graph.get(r.to_uom_id) ?? []),
      { to: r.from_uom_id, ratio: 1 / ratio },
    ]);
  }
  /** @param {string|undefined} start */
  function toBase(start) {
    if (!start || !base) return null;
    const found = new Map([[start, 1]]),
      queue = [start];
    while (queue.length) {
      const key = /** @type {string} */ (queue.shift());
      for (const edge of graph.get(key) ?? []) {
        const ratio = /** @type {number} */ (found.get(key)) * edge.ratio;
        if (found.has(edge.to)) {
          if (
            Math.abs(/** @type {number} */ (found.get(edge.to)) - ratio) >
            0.0000001
          )
            invalid("Conflicting catalog conversions", "ambiguous_uom");
        } else {
          found.set(edge.to, ratio);
          queue.push(edge.to);
        }
      }
    }
    const ratio = found.get(base.id);
    return ratio == null ? null : ratio * scale;
  }
  const caseUoms = uoms.filter((/** @type {any} */ u) =>
    ["CS", "CASE", "CASES", "CTN"].includes(u.code.toUpperCase()),
  );
  const pieceUoms = uoms.filter((/** @type {any} */ u) =>
    ["PC", "PCS", "PIECE", "PIECES", "EA"].includes(u.code.toUpperCase()),
  );
  const caseSizes = [
    ...new Set(
      caseUoms
        .map((/** @type {any} */ u) => toBase(u.id))
        .filter((/** @type {any} */ r) => r != null),
    ),
  ];
  const pieceSizes = [
    ...new Set(
      pieceUoms
        .map((/** @type {any} */ u) => toBase(u.id))
        .filter((/** @type {any} */ r) => r != null),
    ),
  ];
  if (caseSizes.length > 1 || pieceSizes.length > 1)
    invalid("Case or piece definitions disagree", "ambiguous_uom");
  return {
    basePerCase: caseSizes[0] ?? null,
    basePerPiece: pieceSizes[0] ?? null,
    baseCode: base?.code ?? product.uom,
    scale,
  };
}

/** Selling value, not accounting cost: the default governed price for the base UOM.
 * No product.unit_price fallback (the legacy field is frequently a misleading zero).
 * @param {any} db @param {string} productId @param {number} [at]
 */
export async function presenter(db, productId, at = Date.now()) {
  const { product, policy, tracking } = await productPolicy(db, productId);
  const units = await unitInfo(db, product, at);
  const result = await resolvePrice(db, {
    organizationId: ORGANIZATION,
    productId,
    uom: units.baseCode,
    channelKey: null,
    customerCode: null,
    at,
  });
  const unitPrice = result.unitPriceCentavos;
  if (unitPrice != null && (!Number.isSafeInteger(unitPrice) || unitPrice < 0))
    invalid("The default price needs correction", "invalid_price");
  const pricePerBase =
    unitPrice == null
      ? null
      : unitPrice / Number(policy?.quantity_scale ?? units.scale);
  return {
    product,
    tracking,
    units,
    priceSource: result.source,
    priceListId: result.priceListId,
    quantity: (/** @type {any} */ raw) => {
      const base = number(raw),
        q = quantity(base, units, null);
      if (unitPrice != null) {
        const scale = BigInt(policy?.quantity_scale ?? units.scale),
          absolute = BigInt(Math.abs(base)) * BigInt(unitPrice);
        const cents =
          ((absolute * 2n + scale) / (scale * 2n)) * (base < 0 ? -1n : 1n);
        q.valueCentavos = number(cents);
      }
      return q;
    },
    pricePerBase,
  };
}
