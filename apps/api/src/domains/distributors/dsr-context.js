import { forbidden } from "../../core/errors.js";
/** F-407 server-only scoped adapter marker. JSON can never mint this permission. */
export const DSR_ACCESS = Symbol("verified-distributor-field-access");
/** @param {any[]} catalog @param {any} activity */
export function validateDsrProducts(catalog, activity) {
  const lines =
    activity.lines ??
    (activity.productId ? [{ productId: activity.productId }] : []);
  for (const line of lines) {
    const product = catalog.find((p) => p.productId === line.productId);
    if (!product || (line.uom !== undefined && line.uom !== product.uom))
      throw forbidden("Use the granted product and selling unit");
  }
}
