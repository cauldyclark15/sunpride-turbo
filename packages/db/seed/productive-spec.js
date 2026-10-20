import { BATCH, todayManila } from "./store.js";
/** F-208: additive, explicitly invented sample agreements; no client policy overwritten.
 * @param {any} db @param {string} [date] */
export async function seedProductiveSpec(db, date = todayManila()) {
  return db.begin(async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(hashtextextended('sample:productive-policy',0))`;
    const owned =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.status='active' and p.deleted_at is null`;
    const author = owned.find((/** @type {any} */ p) =>
      ["admin", "super_admin"].includes(p.role),
    );
    const approver = owned.find(
      (/** @type {any} */ p) => p.role === "manager" && p.id !== author?.id,
    );
    let policies = 0;
    if (author && approver) {
      const rows =
        await t`select distinct a.org_unit_id,a.position_id,null::text as channel_key,coalesce(s.productive_call_rule,'any_listed_activity') as rule
    from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH}
    join employee_assignments a on a.profile_id=p.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
    left join lateral(select productive_call_rule from position_standards where position_id=a.position_id and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by effective_from desc limit 1) s on true
    where p.role in ('sales','manager') and p.status='active' and p.deleted_at is null and a.position_id is not null`;
      for (const r of rows) {
        if (!["any_listed_activity", "truck_seller"].includes(r.rule)) continue;
        const exists =
          await t`select 1 from productive_call_policies where org_unit_id=${r.org_unit_id} and status='published' and (position_id is null or position_id=${r.position_id}) and (channel_key is null or ${r.channel_key}::text is null or channel_key=${r.channel_key}) and (effective_to is null or effective_to>${date}::date) limit 1`;
        if (exists.length) continue;
        const definitionKey = crypto.randomUUID(),
          label = "SAMPLE activity definition — not client-agreed",
          sourceRef =
            "SAMPLE fixture; awaiting Sales and Trade Marketing agreement",
          from = Date.parse(date + "T00:00:00+08:00");
        const definition = {
          rule: ["any_listed_activity", "truck_seller"].includes(r.rule)
            ? r.rule
            : "any_listed_activity",
          matchMode: "any",
          requiresPlanned: true,
          allowedCodes: [
            "bad_order_pickup",
            "collection",
            "inventory_retrieval",
            "meeting",
            "merchandising",
            "negotiation",
            "purchase_order",
            "suggested_order",
          ],
          label,
          sourceRef,
          definitionKey,
          version: 1,
          orgUnitId: r.org_unit_id,
          positionId: r.position_id,
          channelKey: r.channel_key,
          effectiveFrom: from,
          effectiveTo: null,
        };
        const hash = new Bun.CryptoHasher("sha256")
          .update(
            JSON.stringify(
              Object.fromEntries(
                Object.entries(definition).sort(([a], [b]) =>
                  a < b ? -1 : a > b ? 1 : 0,
                ),
              ),
            ),
          )
          .digest("hex");
        const [p] =
          await t`insert into productive_call_policies(definition_key,version,org_unit_id,position_id,channel_key,label,definition,content_hash,status,effective_from,source_ref,prepared_by,approved_by,approved_at) values (${definitionKey},1,${r.org_unit_id},${r.position_id},${r.channel_key},${label},${definition},${hash},'published',${new Date(from)},${sourceRef},${author.id},${approver.id},now()) returning id`;
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values (${BATCH},'productive_call_policies',${p.id},${"productive-policy:" + r.org_unit_id + ":" + r.position_id + ":" + (r.channel_key ?? "all")})`;
        const [event] =
          await t`insert into productive_policy_events(policy_id,actor_id,kind,detail) values (${p.id},${author.id},'sample.seeded',${{ source: "sample", notClientAgreed: true }}) returning id`;
        await t`insert into sample_data_rows(batch,table_name,row_id,key) values (${BATCH},'productive_policy_events',${event.id},${"productive-policy-event:" + p.id})`;
        policies++;
      }
    }
    // Link only our pre-existing sample orders to their exact sample order activity.
    // This supplies real source provenance for strike rate, never a same-customer guess.
    const linked = await t`with candidates as materialized(
    select o.id,a.id as activity_id,count(*) over(partition by o.id) as matches
    from orders o join visit_activities a on o.client_request_id=a.activity->>'clientOrderId' and o.organization_id=a.organization_id
    join profiles p on p.id=a.assignee_profile_id
    join sample_data_rows mo on mo.batch=${BATCH} and mo.table_name='orders' and mo.row_id=o.id::text
    join sample_data_rows ma on ma.batch=${BATCH} and ma.table_name='visit_activities' and ma.row_id=a.id::text
    where o.source_activity_id is null and o.deleted_at is null and a.deleted_at is null and a.activity_kind='order_intent' and o.outlet_id=a.outlet_id and o.salesperson_profile_id=a.assignee_profile_id and o.created_by_subject in (p.user_id::text,p.auth_subject))
    update orders o set source_activity_id=c.activity_id from candidates c where o.id=c.id and c.matches=1 returning o.id`;
    return { policies, orderLinks: linked.length };
  });
}
