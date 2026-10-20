import { BATCH, todayManila } from "./store.js";
import {
  dormancyPolicyHash,
  detectDormancy,
} from "../../../apps/api/src/domains/coverage/dormancy.js";
/** F-210: invented, editable dormancy thresholds only for sample-marked field units, then one
 * idempotent detection pass. Existing client or future policies are never replaced.
 * @param {any} db @param {string} [day] */
export async function seedDormancySpec(db, day = todayManila()) {
  const policies = await db.begin(async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(hashtextextended('sample:dormancy-policy',0))`;
    const people =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.status='active' and p.deleted_at is null`;
    const author = people.find((/** @type {any} */ p) =>
      ["super_admin", "admin"].includes(p.role),
    );
    if (!author) return 0;
    const units = [
      ...new Set(
        people
          .filter((/** @type {any} */ p) =>
            ["sales", "manager"].includes(p.role),
          )
          .map((/** @type {any} */ p) => p.org_unit_id)
          .filter(Boolean),
      ),
    ];
    let n = 0;
    for (const unit of units) {
      const exists =
        await t`select 1 from dormancy_policies where org_unit_id=${unit} limit 1`;
      if (exists.length) continue;
      const row = {
        org_unit_id: unit,
        version: 1,
        label: "SAMPLE dormancy rule — not client-agreed",
        source_ref:
          "SAMPLE: dormant after 3 missed purchase cycles; 28-day fallback cycle when no class or outlet cadence; office may refine",
        missed_cycles: 3,
        fallback_cycle_days: 28,
        effective_from: new Date(day + "T00:00:00+08:00"),
      };
      const [p] =
        await t`insert into dormancy_policies(org_unit_id,version,label,source_ref,missed_cycles,fallback_cycle_days,content_hash,effective_from,created_by)
        values(${unit},1,${row.label},${row.source_ref},3,28,${dormancyPolicyHash(row)},${row.effective_from},${author.id}) returning id`;
      await t`insert into sample_data_rows(batch,table_name,row_id,key)values(${BATCH},'dormancy_policies',${p.id},${"dormancy-policy:" + unit})`;
      n++;
    }
    return n;
  });
  const demoStores = await seedDormantDemo(db, day);
  // Detection only writes derived cases; it never changes an outlet, order or client master.
  const detection = await detectDormancy(db, Date.now());
  return { policies, demoStores, detection };
}

/** Three ADDITIONAL sample-marked stores whose sample purchases stopped 45-90 days ago, so the
 * owner screen shows real depth. Existing stores and their order history are never altered.
 * @param {any} db @param {string} day */
async function seedDormantDemo(db, day) {
  return db.begin(async (/** @type {any} */ t) => {
    await t`select pg_advisory_xact_lock(hashtextextended('sample:dormancy-demo',0))`;
    const [done] =
      await t`select 1 from sample_data_rows where batch=${BATCH} and key='dormancy-demo:outlet:1'`;
    if (done) return 0;
    const [base] =
      await t`select s.id,s.territory_id,s.owner_unit_id,s.custodian_org_unit_id,s.channel,p.code as product_code,p.name as product_name,p.unit_price,coalesce(pr.auth_subject,pr.user_id::text) as subject
      from analytics_store_scope s
      join sample_data_rows m on m.table_name='outlets' and m.row_id=s.id::text and m.batch=${BATCH}
      join territory_salespeople ts on ts.territory_id=s.territory_id and ts.deleted_at is null and ts.effective_from<=now() and (ts.effective_to is null or ts.effective_to>now())
      join profiles pr on pr.id=ts.profile_id and pr.role='sales' and pr.status='active'
      join sample_data_rows pm on pm.table_name='profiles' and pm.row_id=pr.id::text and pm.batch=${BATCH}
      cross join lateral (select p.* from products p join sample_data_rows q on q.table_name='products' and q.row_id=p.id::text and q.batch=${BATCH} where p.active and p.deleted_at is null and p.unit_price>0 order by p.code limit 1) p
      where s.status='active' and s.territory_id is not null order by s.code limit 1`;
    if (!base) return 0;
    const mark = (
      /** @type {string} */ table,
      /** @type {string} */ id,
      /** @type {string} */ key,
    ) =>
      t`insert into sample_data_rows(batch,table_name,row_id,key)values(${BATCH},${table},${id},${key})`;
    for (const [i, quietDays] of [
      [1, 45],
      [2, 63],
      [3, 90],
    ]) {
      const code = `SMP-DRM-${i}`,
        name = `SAMPLE Dormant Store ${i}`;
      const [o] =
        await t`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,visit_frequency_days,created_by)
        values('sunpride',${code},${name},'active',${base.custodian_org_unit_id ?? base.owner_unit_id},${base.channel},7,'sample-seed') returning id`;
      await mark("outlets", o.id, `dormancy-demo:outlet:${i}`);
      const [a] =
        await t`insert into outlet_assignments(outlet_id,territory_id,cycle_days,effective_from,actor_subject,reason)
        values(${o.id},${base.territory_id},7,${new Date(Date.parse(day + "T00:00:00+08:00") - 200 * 86400000)},'sample-seed','SAMPLE dormancy demo') returning id`;
      await mark("outlet_assignments", a.id, `dormancy-demo:assignment:${i}`);
      const [c] =
        await t`insert into customers(code,name,channel,territory,credit_limit,active) values(${code},${name},${base.channel},'SAMPLE',0,true) returning id`;
      await mark("customers", c.id, `dormancy-demo:customer:${i}`);
      const [l] =
        await t`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason)
        values(${o.id},${c.id},'sample-seed',${new Date(Date.parse(day + "T00:00:00+08:00") - 200 * 86400000)},'sample-seed','SAMPLE dormancy demo') returning id`;
      await mark("outlet_customer_links", l.id, `dormancy-demo:link:${i}`);
      // Two older sample purchases, then nothing: the last one is `quietDays` before the seed day.
      for (const back of [quietDays + 14, quietDays]) {
        const at = new Date(
            Date.parse(day + "T10:00:00+08:00") - back * 86400000,
          ),
          number = `${code}-${back}`;
        const [ord] =
          await t`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,created_at)
          values('sunpride',${number},${number},${code},${base.subject},'approved',${base.unit_price * 6},${base.unit_price * 6},${at}) returning id`;
        await t`insert into order_lines(order_id,product_code,description,quantity,unit_price,line_total) values(${ord.id},${base.product_code},${base.product_name},6,${base.unit_price},${base.unit_price * 6})`;
        await mark("orders", ord.id, `dormancy-demo:order:${number}`);
      }
    }
    return 3;
  });
}
