/** Never reinterpret retained orders using today's product quantity scale.
 * @param {any} order @param {any} line */
export function frozenQuantityScale(order, line) {
  const source = (order.pricing_snapshot?.lines ?? []).find(
    (/** @type {any} */ p) =>
      p.productId === line.product_id &&
      p.uom === line.uom &&
      p.quantityBase === Number(line.quantity_base) &&
      p.quantity === Number(line.quantity),
  );
  return Number.isSafeInteger(source?.quantityScale) && source.quantityScale > 0
    ? source.quantityScale
    : null;
}
