import { outletOwnerUnit } from "../org/scope.js";

/** SP-0241: narrowly authorize the person who captured a still-waiting customer.
 * Never approves the customer, changes territory ownership, or grants access to another person's draft.
 * @param {any} ctx @param {string} outletId */
export async function ownDraftCustomer(ctx, outletId) {
  if (ctx.app !== "field-android" || !ctx.actor?.profileId) return false;
  const [row] =
    await ctx.db`select o.id from outlets o join outlet_enrolments e on e.outlet_id=o.id
    where o.id=${outletId} and o.organization_id='sunpride' and o.deleted_at is null and o.status in ('active','prospect')
    and o.enrolment_status='provisional' and e.status='pending' and e.deleted_at is null
    and e.proposed_by_profile_id=${ctx.actor.profileId} and e.org_unit_id=${ctx.actor.orgUnitId} limit 1`;
  return (
    !!row &&
    (await outletOwnerUnit(ctx.db, outletId, ctx.now)) === ctx.actor.orgUnitId
  );
}

/** Unpriced initial selling catalog for new customers. No other account's prices, terms or balances.
 * @param {any} db */
export async function initialCustomerProducts(db) {
  const rows =
    await db`select id,code,name,uom,change_seq from products where organization_id='sunpride' and active and deleted_at is null order by code,id limit 5001`;
  if (rows.length > 5000)
    throw new Error("New-customer catalog exceeds the supported 5000 products");
  return rows.map((/** @type {any} */ r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    uom: r.uom,
    revision: Number(r.change_seq),
  }));
}
