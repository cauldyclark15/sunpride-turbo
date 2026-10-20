import { ApiError } from "../../core/errors.js";
import { bindings, within } from "./hierarchy.js";

/** SEAM(SAP): approved conditions are a replica; sample adapter echoes only marked
 * sample conditions. Replace this boundary with the SAP lane's condition lookup.
 * SAP-sourced terms fail closed until the real adapter is configured.
 * @param {any} term @param {any} condition */
export async function sapConditionPrice(term, condition) {
  if (term.source !== "sample")
    return { unitPriceCentavos: null, source: "sap_unavailable" };
  return {
    unitPriceCentavos: Number(condition.amount_centavos),
    source: "sample",
  };
}
/** F-307: branch > banner > account, effective approved conditions only; ambiguity fails closed.
 * null means there is no MT account binding (normal channel pricing remains unchanged).
 * @param {any} db @param {any} q @returns {Promise<any>} */
export async function resolveAccountPrice(db, q) {
  if (!q.customerCode || q.organizationId !== "sunpride") return null;
  const paths = (await bindings(db, q.at)).filter(
    (/** @type {any} */ b) => b.customer_code === q.customerCode,
  );
  if (!paths.length) return null;
  if (paths.length > 1)
    return { unitPriceCentavos: null, priceListId: null, source: "ambiguous" };
  const b = paths[0];
  const terms =
    await db`select * from mt_trade_terms where status='approved' and effective_from<=${new Date(q.at)} and (effective_to is null or effective_to>${new Date(q.at)})`;
  for (const kind of ["branch", "banner", "account"]) {
    const eligible = terms.filter(
      (/** @type {any} */ t) =>
        t.scope_kind === kind && within(b, kind, t.scope_key),
    );
    if (eligible.length > 1)
      throw new ApiError(
        "ambiguous_price",
        422,
        "Overlapping account terms need review",
      );
    if (!eligible.length) continue;
    const term = eligible[0];
    const conditions =
      await db`select * from mt_term_conditions where term_id=${term.id} and kind='price' and product_id=${q.productId} and uom=${q.uom}`;
    if (!conditions.length) continue;
    if (conditions.length !== 1)
      return {
        unitPriceCentavos: null,
        priceListId: null,
        source: "ambiguous",
      };
    const price = await sapConditionPrice(term, conditions[0]);
    const value = price.unitPriceCentavos;
    return {
      unitPriceCentavos:
        value !== null && Number.isSafeInteger(value) && value >= 0
          ? value
          : null,
      priceListId: null,
      source: price.source,
      conditionId: conditions[0].id,
      termId: term.id,
      authority: term.source === "sample" ? "mock_sap" : "sap",
      sapKey: term.sap_key,
      sourceVersion: term.source_version,
      receivedAt: new Date(term.received_at).getTime(),
    };
  }
  // MT prices must never silently fall back to a general channel price.
  return {
    unitPriceCentavos: null,
    priceListId: null,
    source: "missing_account_condition",
  };
}
