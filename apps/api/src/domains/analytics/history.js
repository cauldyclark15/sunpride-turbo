import { salesSource } from "./read-model.js";
import { VAN_SALES_SQL } from "./van-facts.js";
/** Return only revision-verified facts; SQL identifiers are fixed allowlisted names.
 * F-601/F-604: native receipts use the same exact outlet and current scope as headlines.
 * @param {any} db @param {any} p @param {any} s @param {string|null} [storeId] */
export async function historicalFacts(db, p, s, storeId = null) {
  const office =
    (await salesSource(db, p, s)) === "tiles"
      ? "analytics_sales_cache"
      : "analytics_sales_facts";
  const columns =
    "store_id,service_date,created_at,product_id,product_name,quantity,order_id,status,sales_centavos,agent_unit_id,owner_unit_id,source_location_id,source_unit_id,profile_id,channel";
  const source = `(select ${columns},null::uuid van_unit_id from ${office}
    union all select v.store_id,v.service_date,sale.created_at,v.product_id,v.product_name,v.quantity,v.order_id,'captured' status,v.sales_centavos,v.agent_unit_id,v.owner_unit_id,v.source_location_id,v.source_unit_id,v.profile_id,v.channel,v.van_unit_id
    from ${VAN_SALES_SQL} v join van_sales sale on sale.id=v.order_id) history_facts`;
  const scope = `agent_unit_id=any($3::uuid[]) and owner_unit_id=any($3::uuid[]) and (source_location_id is null or source_unit_id=any($3::uuid[])) and (van_unit_id is null or van_unit_id=any($3::uuid[])) and ($4::uuid is null or profile_id=$4) and ($5::text is null or channel=$5)`;
  const params = [
    p.from,
    p.to,
    `{${s.ids.join(",")}}`,
    s.ownProfileId,
    p.channel ?? null,
  ];
  if (storeId)
    return db.unsafe(
      `select * from ${source} where service_date between $1::date and $2::date and ${scope} and store_id=$6::uuid order by service_date desc,order_id`,
      [...params, storeId],
    );
  return db.unsafe(
    `select store_id,max(created_at) as last_order,count(distinct product_id) filter(where service_date>=$6::date) as skus,min(service_date) as first_date from ${source} where service_date between $1::date and $2::date and ${scope} group by store_id`,
    [...params, p.selectedFrom ?? p.from],
  );
}
