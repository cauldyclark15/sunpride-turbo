import { requireCapability } from "../../core/capabilities.js";
import { scopeFilterForActor } from "../org/scope.js";
import { bounded, ms, safeInt, ZERO_UUID, ORGANIZATION } from "./model.js";

// Ported from visits/policy.ts. Provisional until Sunpride confirms the list.
export const PHOTO_TYPES = Object.freeze([
  { code: "storefront", label: "Store front" },
  { code: "shelf_display", label: "Shelf and display" },
  { code: "price_tag", label: "Price tags" },
  { code: "promotion", label: "Promotion material" },
  { code: "other", label: "Other" },
]);

/** Current selling-location inventory ONLY for the person's signed catalog. @param {any} ctx @param {string[]|null} [ids] */
export async function inventoryRows(ctx, ids = null) {
  await requireCapability(ctx, "inventory.read");
  const db = ctx.db;
  const { unitIds } = await scopeFilterForActor(db, ctx.actor);
  const units = unitIds?.length ? unitIds : [ZERO_UUID];
  const rows = bounded(
    await db`
    with signed_outlets as (
      select distinct pv.outlet_id from planned_visits pv join coverage_plans cp on cp.id=pv.plan_id
      where pv.assignee_profile_id=${ctx.actor.profileId} and pv.service_date>=${ctx.params.dayFrom}::date and pv.service_date<${ctx.params.dayFrom}::date+3
        and pv.status='planned' and pv.deleted_at is null and cp.deleted_at is null and cp.status in ('approved','active') and cp.approval_signature is not null
        and exists (select 1 from outlets o
          left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
          left join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=${new Date(ctx.now)} and (own.effective_to is null or own.effective_to>${new Date(ctx.now)})
          where o.id=pv.outlet_id and o.deleted_at is null and (${unitIds === null} or coalesce(own.org_unit_id,o.custodian_org_unit_id) in ${db(units)}))
    ), catalog as (
      select l.product_id from call_sheet_account_lines l join call_sheet_accounts a on a.id=l.call_sheet_account_id
        join signed_outlets s on s.outlet_id=a.outlet_id where l.deleted_at is null and a.deleted_at is null
      union
      select l.product_id from outlet_assortment_products l join outlet_assortments a on a.id=l.outlet_assortment_id
        join signed_outlets s on s.outlet_id=a.outlet_id where l.deleted_at is null and a.deleted_at is null
          and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
    )
    select b.*,l.code as location_code,l.name as location_name from inventory_balances b
      join inventory_locations l on l.id=b.location_id join products p on p.id=b.product_id
    where b.product_id in (select product_id from catalog) and b.organization_id=${ORGANIZATION} and l.organization_id=${ORGANIZATION} and b.deleted_at is null and l.deleted_at is null and l.active and l.allows_sale
      and p.active and p.deleted_at is null and b.available_base is not null and b.physical_base is not null and b.reserved_base is not null
      and (${unitIds === null} or l.org_unit_id in ${db(units)})
      and (${ids === null} or b.id in ${db(ids?.length ? ids : [ZERO_UUID])})
    order by b.id limit 2001`,
    2000,
  );
  return rows.map((/** @type {any} */ b) => ({
    id: b.id,
    productId: b.product_id,
    locationId: b.location_id,
    locationCode: b.location_code,
    locationName: b.location_name,
    availableBase: safeInt(b.available_base),
    physicalBase: safeInt(b.physical_base),
    reservedBase: safeInt(b.reserved_base),
    revision: safeInt(b.change_seq),
    asOf: ms(b.as_of),
  }));
}
