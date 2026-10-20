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
/** A missing/expired path is not permission to replace SAP authority with a generic list.
 * @param {any} db @param {string} code */
async function knownAccount(db, code) {
  const [row] =
    await db`select 1 from mt_account_bindings b join customers c on c.id=b.customer_id where c.code=${code} limit 1`;
  return Boolean(row);
}
/** SEAM(SAP): MT credit is unknown until SAP's credit-call adapter is wired.
 * Never turn locally captured open orders into a credit certificate.
 * @param {any} db @param {{customerCode:string}} q */
export async function resolveAccountCredit(db, q) {
  return (await knownAccount(db, q.customerCode))
    ? { status: /** @type {const} */ ("unknown"), limit: null, exposure: null }
    : null;
}
/** F-307: branch > banner > account, effective approved conditions only; ambiguity fails closed.
 * null means the customer was never bound to MT (normal channel pricing remains unchanged).
 * @param {any} db @param {any} q @returns {Promise<any>} */
export async function resolveAccountPrice(db, q) {
  if (!q.customerCode || q.organizationId !== "sunpride") return null;
  const accountPaths = (await bindings(db, q.at)).filter(
    (/** @type {any} */ b) => b.customer_code === q.customerCode,
  );
  if (!accountPaths.length)
    return (await knownAccount(db, q.customerCode))
      ? {
          unitPriceCentavos: null,
          priceListId: null,
          source: "missing_account_binding",
        }
      : null;
  const paths = q.outletId
    ? accountPaths.filter((/** @type {any} */ b) => b.outlet_id === q.outletId)
    : accountPaths;
  if (!paths.length)
    return {
      unitPriceCentavos: null,
      priceListId: null,
      source: "missing_account_binding",
    };
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
