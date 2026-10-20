import { tx } from "../src/client.js";
import { BATCH, rowId, at, todayManila, plusDays, weekday } from "./store.js";

/** F-201/F-202: additive sample policies/templates; never reset or overwrite client masters.
 * @param {import('../src/client.js').Db} db @param {string} [today] */
export async function seedCoverageSpec(db, today = todayManila()) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(hashtextextended('sample:coverage-spec',0))`;
    const [admin] =
      await t`select p.id from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.role in ('admin','super_admin') and p.status='active' and p.deleted_at is null order by p.id limit 1`;
    if (!admin) return { policies: 0, templates: 0 };
    const people =
      await t`select p.* from profiles p join sample_data_rows m on m.table_name='profiles' and m.row_id=p.id::text and m.batch=${BATCH} where p.role='sales' and p.status='active' and p.deleted_at is null order by p.id`;
    let policies = 0,
      templates = 0;
    for (const p of people) {
      const stops =
        await t`select distinct o.* from outlets o join sample_data_rows m on m.table_name='outlets' and m.row_id=o.id::text and m.batch=${BATCH} join outlet_assignments a on a.outlet_id=o.id join route_salespeople rs on rs.route_id=a.route_id where o.status='active' and o.enrolment_status='approved' and o.deleted_at is null and a.deleted_at is null and rs.deleted_at is null and rs.profile_id=${p.id} and a.effective_from<=${new Date(at(today, 720))} and (a.effective_to is null or a.effective_to>${new Date(at(today, 720))}) and rs.effective_from<=${new Date(at(today, 720))} and (rs.effective_to is null or rs.effective_to>${new Date(at(today, 720))}) order by o.code limit 501`;
      if (stops.length > 500)
        throw new Error("Sample coverage exceeds supported outlet bound");
      if (!stops.length) continue;
      // Existing demo rows predate classes. Only marked SAMPLE rows with a missing
      // class gain this clearly named sample key; no real/existing class is changed.
      for (const o of stops)
        if (!o.classification) {
          await t`update outlets set classification='SAMPLE-A' where id=${o.id} and classification is null`;
          o.classification = "SAMPLE-A";
        }
      for (const classKey of new Set(
        stops.map((/** @type {any} */ o) => o.classification),
      )) {
        const id = rowId(
          "outlet_class_visit_policies",
          `${p.org_unit_id}:${classKey}`,
        );
        const [old] =
          await t`select id from outlet_class_visit_policies where org_unit_id=${p.org_unit_id} and class_key=${classKey} limit 1`;
        if (!old) {
          await t`insert into outlet_class_visit_policies(id,org_unit_id,class_key,label,interval_weeks,service_minutes,objectives,effective_from,source_ref,created_by) values (${id},${p.org_unit_id},${classKey},${"Sample " + classKey + " weekly frequency"},1,30,ARRAY['Review last visit outcome','Check must-stock gaps','Agree the next order'],${new Date(at(today))},'SAMPLE F-201: invented policy, awaiting Sunpride approval',${admin.id})`;
          await t`insert into sample_data_rows(id,batch,table_name,row_id,key) values (${rowId("sample_data_rows", "coverage-policy:" + id)},${BATCH},'outlet_class_visit_policies',${id},${"coverage-policy:" + id}) on conflict do nothing`;
          policies++;
        }
      }
      const id = rowId("pjp_templates", p.id),
        anchor = plusDays(today, -((weekday(today) + 6) % 7));
      const [old] =
        await t`select id from pjp_templates where assignee_profile_id=${p.id} limit 1`;
      if (!old) {
        await t`insert into pjp_templates(id,org_unit_id,assignee_profile_id,name,version,anchor_date,effective_from,effective_to,capacity_minutes,travel_minutes,selling_weekdays,stops,created_by) values (${id},${p.org_unit_id},${p.id},${"Sample permanent journey — " + p.name},1,${anchor},${new Date(at(today))},${new Date(at(plusDays(today, 180)))},480,15,ARRAY[1,2,3,4,5,6]::smallint[],${stops.map((/** @type {any} */ o) => ({ outletId: o.id }))},${admin.id})`;
        await t`insert into sample_data_rows(id,batch,table_name,row_id,key) values (${rowId("sample_data_rows", "coverage-template:" + id)},${BATCH},'pjp_templates',${id},${"coverage-template:" + id}) on conflict do nothing`;
        templates++;
      }
    }
    return { policies, templates };
  });
}
