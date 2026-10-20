import { ApiError } from "../../core/errors.js";
import { outletContext } from "../orders/access.js";
import { uuid } from "../orders/validation.js";

/** SEAM(MASTERS): replace adapter bindings with F-305's effective chain/banner/branch path.
 * Keys are opaque upstream account keys, not employee org units.
 * @param {any} db @param {number} [at] */
export async function bindings(db, at = Date.now()) {
  const rows =
    await db`select b.*,c.code as customer_code,c.name as customer_name,o.name as outlet_name
    from mt_account_bindings b join customers c on c.id=b.customer_id join outlets o on o.id=b.outlet_id
    where b.effective_from<=${new Date(at)} and (b.effective_to is null or b.effective_to>${new Date(at)})
    and c.active and c.deleted_at is null and o.status='active' and o.deleted_at is null order by b.label limit 2001`;
  if (rows.length > 2000)
    throw new ApiError(
      "capacity",
      422,
      "Account hierarchy exceeds supported size",
    );
  return rows;
}
/** @param {any} c @param {string} id @param {string} [cap] */
export async function bindingAccess(c, id, cap = "report.read") {
  const rows = await bindings(c.db, c.now);
  if (rows.length > 2000)
    throw new ApiError(
      "capacity",
      422,
      "Narrow the account hierarchy before continuing",
    );
  const row = rows.find((/** @type {any} */ b) => b.id === uuid(id));
  if (!row)
    throw new ApiError("out_of_scope", 403, "Account branch is not available");
  await outletContext(c, row.outlet_id, cap);
  return row;
}
/** @param {any} row @param {string} kind @param {string} key */
export function within(row, kind, key) {
  return (
    (kind === "account"
      ? row.account_key
      : kind === "banner"
        ? row.banner_key
        : kind === "branch"
          ? row.branch_key
          : null) === key
  );
}
/** @param {any} c @param {string} kind @param {string} key @param {string} cap */
export async function scopeAccess(c, kind, key, cap) {
  const rows = (await bindings(c.db, c.now)).filter((/** @type {any} */ b) =>
    within(b, kind, key),
  );
  if (!rows.length || rows.length > 2000)
    throw new ApiError("out_of_scope", 403, "Account scope is not available");
  // A chain-wide condition affects EVERY branch. Partial employee scope cannot edit it.
  for (const row of rows) await bindingAccess(c, row.id, cap);
  return rows;
}
