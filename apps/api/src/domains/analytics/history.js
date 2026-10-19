import { salesSource } from "./read-model.js";
/** Return only revision-verified facts; SQL identifiers are fixed allowlisted names.
 * @param {any} db @param {any} p @param {any} s @param {string|null} [storeId] */
export async function historicalFacts(db, p, s, storeId = null) {
  const source =
    (await salesSource(db, p, s)) === "tiles"
      ? "analytics_sales_cache"
      : "analytics_sales_facts";
  const scope = `agent_unit_id=any($3::uuid[]) and owner_unit_id=any($3::uuid[]) and (source_location_id is null or source_unit_id=any($3::uuid[])) and ($4::uuid is null or profile_id=$4) and ($5::text is null or channel=$5)`;
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
