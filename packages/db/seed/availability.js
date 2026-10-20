import { tx } from "../src/client.js";
import { rowId, at, plusDays, todayManila } from "./store.js";

const BATCH = "sunpride-availability-v1";
/** Additive, idempotent marked sample content. Never resets or edits a real row.
 * @param {import('../src/client.js').Db} db @param {string} [day] */
export async function seedAvailability(db, day = todayManila()) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4490214)`;
    const products =
      await t`select p.* from products p where p.active and p.deleted_at is null and exists(select 1 from sample_data_rows m where m.table_name='products' and m.row_id=p.id::text) order by p.code limit 3`;
    const outlets =
      await t`select o.* from outlets o where o.status='active' and o.deleted_at is null and exists(select 1 from sample_data_rows m where m.table_name='outlets' and m.row_id=o.id::text) order by o.code limit 1000`;
    if (!products.length || !outlets.length)
      return { skipped: true, reason: "No sample masters" };
    /** @param {string} table @param {string} id */
    const mark = async (table, id) => {
      await t`insert into sample_data_rows(batch,table_name,row_id,key) values (${BATCH},${table},${id},${`${table}:${id}`}) on conflict do nothing`;
    };
    const start = plusDays(day, -90);
    const lines = products.map((/** @type {any} */ p) => ({
      productId: p.id,
      minimumBase: Number(p.quantity_scale ?? 1) * 2,
    }));
    const releaseId = rowId("availability_releases", "sample-msl");
    // F-216: keep a cold-start control and a purchase-history cohort backed by
    // existing canonical SAMPLE receipts, without inventing sales in this lane.
    const buyers =
      await t`select s.outlet_id from van_sales s join van_sale_lines l on l.sale_id=s.id join van_trips trip on trip.id=s.trip_id where s.outlet_id in ${t(outlets.map((/** @type {any} */ o) => o.id))} and l.product_id in ${t(products.map((/** @type {any} */ p) => p.id))} and trip.deleted_at is null and trip.service_date between ${start} and ${day} and not exists(select 1 from van_sale_voids v where v.sale_id=s.id) and exists(select 1 from sample_data_rows m where m.table_name='van_sales' and m.row_id=s.id::text) group by s.outlet_id order by count(distinct s.id) desc,s.outlet_id limit 25`;
    const buyerIds = new Set(buyers.map((/** @type {any} */ r) => r.outlet_id));
    const launchCohort = [
      ...buyerIds,
      ...outlets
        .filter((/** @type {any} */ o) => !buyerIds.has(o.id))
        .map((/** @type {any} */ o) => o.id),
    ].slice(0, 30);
    for (const [kind, key, label, payload] of [
      [
        "msl",
        "SAMPLE-all",
        "SAMPLE · pilot must-stock set",
        {
          priority: 0,
          outletIds: outlets.map((/** @type {any} */ o) => o.id),
          lines,
        },
      ],
      [
        "rules",
        "SAMPLE-default",
        "SAMPLE · availability measurement rules",
        { coverDays: 8, freshnessDays: 14, universeFreshnessDays: 14 },
      ],
      [
        "focus",
        "SAMPLE-focus",
        "SAMPLE · new product focus",
        {
          priority: 0,
          outletIds: outlets.map((/** @type {any} */ o) => o.id),
          lines: [
            {
              productId: products[0].id,
              minimumBase: Number(products[0].quantity_scale ?? 1) * 3,
              objective: "Secure a first order and a visible shelf position",
            },
          ],
        },
      ],
      [
        "launch",
        "SAMPLE-launch",
        "SAMPLE · distribution build",
        {
          productIds: [products[0].id],
          outletIds: outlets.slice(0, 30).map((/** @type {any} */ o) => o.id),
          buildTargets: [
            { date: plusDays(day, -14), outlets: 5 },
            { date: plusDays(day, -7), outlets: 15 },
            { date: day, outlets: 25 },
          ],
        },
      ],
      [
        "launch",
        "SAMPLE-launch-purchase-history",
        "SAMPLE · first and repeat purchase build",
        {
          productIds: products.map((/** @type {any} */ p) => p.id),
          outletIds: launchCohort,
          buildTargets: [
            { date: plusDays(day, -14), outlets: 5 },
            { date: plusDays(day, -7), outlets: 15 },
            { date: day, outlets: 25 },
          ],
        },
      ],
    ]) {
      const id =
        kind === "msl"
          ? releaseId
          : rowId("availability_releases", String(key));
      await t`insert into availability_releases(id,kind,policy_key,version,label,status,effective_from,payload,source_ref,sample,actor_subject,published_at) values (${id},${kind},${key},1,${label},'published',${new Date(at(start))},${payload},'SAMPLE invented pilot content; awaiting Trade Marketing',true,'system:sample',${new Date(at(start))}) on conflict do nothing`;
      await mark("availability_releases", id);
    }
    let checks = 0;
    // Sample visits already carry physical outlet/assignee attribution. Do not
    // invent an audit for a store without a recorded sample call.
    const visits =
      await t`select v.* from visit_executions v where v.service_date between ${plusDays(day, -28)} and ${day} and v.state='completed' and v.checked_in_at is not null and v.outlet_id in ${t(outlets.map((/** @type {any} */ o) => o.id))} and exists(select 1 from sample_data_rows m where m.table_name='visit_executions' and m.row_id=v.id::text) order by v.service_date,v.id`;
    for (const [i, v] of visits.entries()) {
      const snapshotId = rowId("availability_call_snapshots", v.id),
        id = rowId("availability_checks", v.id),
        date = new Date(v.service_date).toISOString().slice(0, 10);
      const body = {
        version: "availability/2026-10-v1",
        outletId: v.outlet_id,
        serviceDate: date,
        msl: {
          id: releaseId,
          version: 1,
          label: "SAMPLE · pilot must-stock set",
          sample: true,
        },
        policy: { coverDays: 8, freshnessDays: 14, universeFreshnessDays: 14 },
        focus: [],
        lines: products.map((/** @type {any} */ p) => ({
          productId: p.id,
          code: p.code,
          name: p.name,
          uom: p.uom,
          quantityScale: Number(p.quantity_scale ?? 1),
          required: true,
          minimumBase: Number(p.quantity_scale ?? 1) * 2,
          quantityBase: Number(p.quantity_scale ?? 1) * 2,
          reasons: ["SAMPLE · pilot must-stock line"],
          barcodes: [],
        })),
        sample: true,
        setupNeeded: false,
      };
      await t`insert into availability_call_snapshots(id,outlet_id,profile_id,app,service_date,content_hash,body) values (${snapshotId},${v.outlet_id},${v.assignee_profile_id},'field-android',${date},${id},${body}) on conflict do nothing`;
      await mark("availability_call_snapshots", snapshotId);
      const observations = products.map(
        (/** @type {any} */ p, /** @type {number} */ j) => ({
          productId: p.id,
          state: (i + j) % 5 === 0 ? "absent" : "present",
          method: "tap",
          shelfBase: (i + j) % 5 === 0 ? 0 : Number(p.quantity_scale ?? 1) * 4,
          backroomBase: Number(p.quantity_scale ?? 1) * 2,
          deliveredBase: 0,
          returnsBase: 0,
          offtake: null,
        }),
      );
      await t`insert into availability_checks(id,snapshot_id,outlet_id,profile_id,org_unit_id,visit_id,call_key,service_date,device_time,complete,required_count,checked_count,present_count,lines,proposals,payload_hash,actor_subject) values (${id},${snapshotId},${v.outlet_id},${v.assignee_profile_id},${v.org_unit_id},${v.id},${rowId("availability-call", v.id)},${date},${v.checked_in_at},true,${products.length},${products.length},${observations.filter((/** @type {any} */ o) => o.state === "present").length},${observations},${[]},${id},'system:sample') on conflict do nothing`;
      await mark("availability_checks", id);
      checks++;
    }
    for (const date of [plusDays(day, -14), day]) {
      const id = rowId("availability_universes", date);
      const members = outlets.map(
        (/** @type {any} */ o, /** @type {number} */ i) => ({
          outletId: o.id,
          turnoverWeight: ((i % 4) + 1) * 10000,
          validationRef:
            "SAMPLE validated pilot census; invented turnover weight",
        }),
      );
      await t`insert into availability_universes(id,label,service_date,members,source_ref,sample,actor_subject) values (${id},'SAMPLE · validated pilot universe',${date},${members},'SAMPLE census and turnover weights — not a real census',true,'system:sample') on conflict do nothing`;
      await mark("availability_universes", id);
    }
    const [{ n }] =
      await t`select count(*)::int as n from availability_checks c join sample_data_rows m on m.table_name='availability_checks' and m.row_id=c.id::text and m.batch=${BATCH}`;
    return {
      sample: true,
      outlets: outlets.length,
      products: products.length,
      checks,
      storedChecks: n,
    };
  });
}
