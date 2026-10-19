import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { scopeFilterForActor, outletOwnerUnit } from "../org/scope.js";
import { ORGANIZATION, fail, uuid } from "./validation.js";

/** @param {any} ctx @param {string} capability @param {string|null} unit */
export async function scoped(ctx, capability, unit) {
  const actor = await requireCapability(ctx, capability);
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  if (unitIds !== null && (!unit || !unitIds.includes(unit)))
    throw new ApiError("out_of_scope", 403, "This record is outside your area");
  return actor;
}

/** Current persisted owner controls even historical orders. @param {any} ctx @param {string} id @param {string} [capability] */
export async function outletContext(ctx, id, capability = "report.read") {
  uuid(id, "Store");
  const [outlet] =
    await ctx.db`select * from outlets where id = ${id} and organization_id = ${ORGANIZATION} and deleted_at is null`;
  if (!outlet) fail("Store not found", "not_found");
  const unit = await outletOwnerUnit(ctx.db, id, Date.now());
  await scoped(ctx, capability, unit);
  const [assignment] =
    await ctx.db`select * from outlet_assignments where outlet_id = ${id} and deleted_at is null
    and effective_from <= now() and (effective_to is null or effective_to > now())`;
  return { outlet, unit, assignment };
}

/**
 * Fixed SQL; only values are parameters. Scope is applied BEFORE the row limit/cursor.
 * Never infer source-order access from a shared accounting customer's current links alone.
 */
export const ORDER_FROM = `from orders o
  left join profiles p on p.id = o.salesperson_profile_id or (o.salesperson_profile_id is null and (p.auth_subject = o.salesperson_subject or p.user_id::text = o.salesperson_subject))
  left join customers c on c.code = o.customer_code and c.deleted_at is null
  left join inventory_locations loc on loc.id = o.source_location_id
  left join outlets store on store.id = o.outlet_id and store.deleted_at is null
  left join lateral (select a.territory_id, own.org_unit_id from outlet_assignments a
    left join territory_ownerships own on own.territory_id = a.territory_id and own.deleted_at is null and own.effective_from <= now() and (own.effective_to is null or own.effective_to > now())
    where a.outlet_id = store.id and a.deleted_at is null and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now()) limit 1) owner on true
  left join territories territory on territory.id = coalesce(o.territory_id, owner.territory_id)`;
export const ORDER_ACCESS = `o.deleted_at is null and (o.organization_id is null or o.organization_id = 'sunpride')
  and ($1::jsonb is null or (
    p.deleted_at is null and p.org_unit_id::text in (select jsonb_array_elements_text($1::jsonb -> 'units'))
    and (o.org_unit_id is null or o.org_unit_id::text in (select jsonb_array_elements_text($1::jsonb -> 'units')))
    and (o.source_location_id is null or loc.org_unit_id::text in (select jsonb_array_elements_text($1::jsonb -> 'units')))
    and (o.outlet_id is null or (case when owner.territory_id is null then store.custodian_org_unit_id else owner.org_unit_id end)::text in (select jsonb_array_elements_text($1::jsonb -> 'units')))
    and c.id is not null and (o.outlet_id is not null or exists (
      select 1 from sales_assignments sa join profiles sp on sp.auth_subject = sa.salesperson_subject or sp.user_id::text = sa.salesperson_subject
      where sa.customer_code = c.code and sa.territory = c.territory and sa.active and sp.status = 'active'
      and sp.org_unit_id::text in (select jsonb_array_elements_text($1::jsonb -> 'units'))
      and ($2::text is null or sa.salesperson_subject = $2)))))
  and ($2::text is null or o.salesperson_subject = $2)`;
/** @param {any} ctx */
export async function scopeParams(ctx) {
  const actor = await requireCapability(ctx, "report.read");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  return [
    unitIds === null ? null : { units: unitIds },
    actor.role === "sales" ? actor.subject : null,
  ];
}
/** @param {any} ctx @param {string} id @param {boolean} [lock] */
export async function accessibleOrder(ctx, id, lock = false) {
  uuid(id, "Order");
  const params = await scopeParams(ctx);
  const [row] = await ctx.db.unsafe(
    `select o.*, c.name as customer_name, p.name as salesperson_name, territory.name as territory_name ${ORDER_FROM} where ${ORDER_ACCESS} and o.id = $3::uuid`,
    [...params, id],
  );
  if (!row)
    throw new ApiError("out_of_scope", 403, "Order not found in your area");
  if (lock) {
    const [current] =
      await ctx.db`select * from orders where id = ${id} for update`;
    Object.assign(row, current);
  }
  return row;
}
