import { tx } from "@sunpride/db/client";
import { enqueue } from "../../core/jobs.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import { requireNationalScope } from "../../core/capabilities.js";
import { manilaDate, ORGANIZATION, snapshot, stockLock } from "./common.js";
import { postMovement } from "./posting.js";

/** Bounded, resumable expiry batches. Reserved stock is released first through the
 * same writer, so a hard reservation cannot keep expired goods sellable.
 * @param {any} db @param {number} [now]
 */
export async function expireLots(db, now = Date.now()) {
  const result = await tx(db, async (t) => {
    const rows =
      await t`select b.*,l.organization_id,l.product_id from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where l.expires_at<=${new Date(now)} and b.stock_status in ('available','quality_hold','quarantine') and b.physical_base>0 order by l.expires_at,b.id limit 20`;
    let processed = 0;
    const units = new Set();
    for (const candidate of rows) {
      await stockLock(t, candidate.organization_id);
      const [b] =
        await t`select b.*,l.expires_at from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.id=${candidate.id} for update of b,l`;
      if (
        !b ||
        Number(b.physical_base) <= 0 ||
        new Date(b.expires_at).getTime() > now
      )
        continue;
      const [loc] =
        await t`select * from inventory_locations where id=${b.location_id}`;
      const base = {
        organizationId: b.organization_id,
        occurredAt: now,
        actor: { profileId: null, userId: null },
        sourceType: "expiry_job",
        sourceId: b.lot_id,
      };
      if (Number(b.reserved_base) > 0) {
        await postMovement(t, {
          ...base,
          kind: "reservation_release",
          idempotencyKey: `expire-release:${b.id}:${b.version}`,
          lines: [
            {
              productId: b.product_id,
              quantityBase: Number(b.reserved_base),
              uom: "base",
              fromLocationId: b.location_id,
              toLocationId: null,
              lotId: b.lot_id,
            },
          ],
        });
        await t`update inventory_reservation_lines set released_base=reserved_base-consumed_base where organization_id=${b.organization_id} and lot_id=${b.lot_id} and location_id=${b.location_id} and reserved_base>consumed_base+released_base`;
        await t`update inventory_reservations r set status='expired' where r.organization_id=${b.organization_id} and r.status in ('active','partially_consumed') and exists (select 1 from inventory_reservation_lines l where l.reservation_id=r.id and l.lot_id=${b.lot_id}) and not exists (select 1 from inventory_reservation_lines l where l.reservation_id=r.id and l.reserved_base>l.consumed_base+l.released_base)`;
      }
      await postMovement(t, {
        ...base,
        kind: "status_change",
        idempotencyKey: `expire:${b.id}:${b.version}`,
        lines: [
          {
            productId: b.product_id,
            quantityBase: Number(b.physical_base),
            uom: "base",
            fromLocationId: b.location_id,
            toLocationId: b.location_id,
            lotId: b.lot_id,
            fromStockStatus: b.stock_status,
            toStockStatus: "expired",
          },
        ],
      });
      await t`update inventory_lots set quality_status='expired' where id=${b.lot_id}`;
      units.add(loc?.org_unit_id ?? null);
      processed++;
    }
    const [more] =
      await t`select 1 from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where l.expires_at<=${new Date(now)} and b.stock_status in ('available','quality_hold','quarantine') and b.physical_base>0 limit 1`;
    if (more)
      await enqueue(t, {
        kind: "inventory.expire-lots",
        key: "continue",
        payload: {},
      });
    return { processed, more: Boolean(more), units: [...units] };
  });
  return result;
}

// ------------------------------------------------------------------ nightly integrity (IP-VALUE)
const ORG = ORGANIZATION;
const STATUS_VALUES = `('available',b.available_stock_base),('quality_hold',b.quality_hold_base),('quarantine',b.quarantine_base),('damaged',b.damaged_base),('expired',b.expired_base),('rejected',b.rejected_base),('wip',b.wip_base),('in_transit',b.in_transit_base)`;
/** Every check is one set-based query returning the rows that DISAGREE. Columns: ref, ledger, other, detail.
 * @type {Array<{kind:string, severity:'warning'|'critical', title:string, classification:string, sql:(db:any)=>Promise<any[]>}>} */
export const INTEGRITY_CHECKS = [
  {
    kind: "ledger_vs_balance",
    severity: "critical",
    title: "Stock on hand does not match the movement ledger",
    classification: "unresolved",
    sql: (db) => db.unsafe(`select b.product_id,b.location_id,s.stock_status as ref,coalesce(l.q,0)::bigint as ledger,s.q::bigint as other
      from inventory_balances b cross join lateral (values ${STATUS_VALUES}) as s(stock_status,q)
      left join (select product_id,location_id,stock_status,sum(quantity_delta_base) as q from inventory_ledger_entries where organization_id=$1 group by 1,2,3) l
        on l.product_id=b.product_id and l.location_id=b.location_id and l.stock_status=s.stock_status
      where b.organization_id=$1 and b.product_id is not null and coalesce(l.q,0)<>coalesce(s.q,0)
      union all
      select l.product_id,l.location_id,l.stock_status,l.q::bigint,0::bigint from (select product_id,location_id,stock_status,sum(quantity_delta_base) as q from inventory_ledger_entries where organization_id=$1 group by 1,2,3) l
      where l.q<>0 and not exists (select 1 from inventory_balances b where b.organization_id=$1 and b.product_id=l.product_id and b.location_id=l.location_id)`, [ORG]),
  },
  {
    kind: "physical_vs_statuses",
    severity: "critical",
    title: "A balance's total is not the sum of its statuses",
    classification: "unresolved",
    sql: (db) => db.unsafe(`select b.product_id,b.location_id,'physical' as ref,(b.available_stock_base+b.quality_hold_base+b.quarantine_base+b.damaged_base+b.expired_base+b.rejected_base+b.wip_base+b.in_transit_base)::bigint as ledger,b.physical_base::bigint as other
      from inventory_balances b where b.organization_id=$1 and b.product_id is not null
        and (b.available_stock_base+b.quality_hold_base+b.quarantine_base+b.damaged_base+b.expired_base+b.rejected_base+b.wip_base+b.in_transit_base)<>b.physical_base`, [ORG]),
  },
  {
    kind: "reserved_vs_ledger",
    severity: "warning",
    title: "Reserved stock does not match the reservation ledger",
    classification: "unresolved",
    sql: (db) => db.unsafe(`select coalesce(b.product_id,l.product_id) as product_id,coalesce(b.location_id,l.location_id) as location_id,'reserved' as ref,coalesce(l.q,0)::bigint as ledger,coalesce(b.reserved_base,0)::bigint as other
      from inventory_balances b full join (select product_id,location_id,sum(reserved_delta_base) as q from inventory_ledger_entries where organization_id=$1 group by 1,2) l
        on l.product_id=b.product_id and l.location_id=b.location_id
      where coalesce(l.q,0)<>coalesce(b.reserved_base,0) and (b.organization_id=$1 or b.organization_id is null)`, [ORG]),
  },
  {
    kind: "value_vs_ledger",
    severity: "critical",
    title: "Stock value does not match the value in the ledger",
    classification: "unresolved",
    sql: (db) => db.unsafe(`select coalesce(b.product_id,l.product_id) as product_id,coalesce(b.location_id,l.location_id) as location_id,'value' as ref,coalesce(l.q,0)::bigint as ledger,coalesce(b.inventory_value_minor,0)::bigint as other
      from inventory_balances b full join (select product_id,location_id,sum(value_delta_minor) as q from inventory_ledger_entries where organization_id=$1 group by 1,2) l
        on l.product_id=b.product_id and l.location_id=b.location_id
      where coalesce(l.q,0)<>coalesce(b.inventory_value_minor,0) and (b.organization_id=$1 or b.organization_id is null)`, [ORG]),
  },
  {
    kind: "lot_vs_ledger",
    severity: "critical",
    title: "Batch stock does not match the movement ledger",
    classification: "unresolved",
    sql: (db) => db.unsafe(`select coalesce(b.product_id,l.product_id) as product_id,coalesce(b.location_id,l.location_id) as location_id,coalesce(b.lot_id,l.lot_id)::text||':'||coalesce(b.stock_status,l.stock_status) as ref,coalesce(l.q,0)::bigint as ledger,coalesce(b.physical_base,0)::bigint as other
      from inventory_lot_balances b full join (select product_id,location_id,lot_id,stock_status,sum(quantity_delta_base) as q from inventory_ledger_entries where organization_id=$1 and lot_id is not null group by 1,2,3,4) l
        on l.lot_id=b.lot_id and l.location_id=b.location_id and l.stock_status=b.stock_status
      where coalesce(l.q,0)<>coalesce(b.physical_base,0) and (b.organization_id=$1 or b.organization_id is null)`, [ORG]),
  },
  {
    kind: "lot_vs_balance",
    severity: "critical",
    title: "Batch stock does not add up to the product's stock",
    classification: "unresolved",
    sql: (db) => db.unsafe(`select b.product_id,b.location_id,s.stock_status as ref,coalesce(l.q,0)::bigint as ledger,s.q::bigint as other
      from inventory_balances b cross join lateral (values ${STATUS_VALUES}) as s(stock_status,q)
      join product_inventory_policies pol on pol.organization_id=b.organization_id and pol.product_id=b.product_id and pol.active and pol.tracking_mode='lot'
      left join (select product_id,location_id,stock_status,sum(physical_base) as q from inventory_lot_balances where organization_id=$1 group by 1,2,3) l
        on l.product_id=b.product_id and l.location_id=b.location_id and l.stock_status=s.stock_status
      where b.organization_id=$1 and coalesce(l.q,0)<>s.q`, [ORG]),
  },
  {
    kind: "sale_without_stock",
    severity: "critical",
    title: "A paid sale has no stock movement",
    classification: "missing_outbound",
    // IP-INT3FIX: the showcase seed's van sales (receipt numbers 'SMP-%') have their stock under source_type 'sample', keyed by
    // the order id, so they can never match a van_sale movement. They are immutable seed history, not drift, and would otherwise
    // keep one critical alert permanently open and hide a real missing movement inside it.
    sql: (db) => db.unsafe(`select null::uuid as product_id,null::uuid as location_id,'store_sale:'||s.receipt_number as ref,0::bigint as ledger,1::bigint as other
      from store_sales s left join inventory_movements m on m.id=s.movement_id
      where m.id is null or m.movement_type<>'pos_sale' or m.source_document_id is distinct from s.id::text or not exists (select 1 from inventory_ledger_entries e where e.movement_id=m.id)
      union all
      select null,null,'van_sale:'||v.receipt_number,0,1 from van_sales v
      where coalesce(v.receipt_number,'') not like 'SMP-%' and not exists (select 1 from inventory_movements m where m.source_type='van_sale' and m.movement_type='pos_sale' and m.source_document_id=v.id::text and exists (select 1 from inventory_ledger_entries e where e.movement_id=m.id))`, []),
  },
  {
    kind: "stock_without_sale",
    severity: "warning",
    title: "A sale movement has no sale document",
    classification: "missing_inbound",
    sql: (db) => db.unsafe(`select null::uuid as product_id,null::uuid as location_id,m.source_type||':'||m.movement_number as ref,1::bigint as ledger,0::bigint as other
      from inventory_movements m where m.movement_type='pos_sale' and m.status='posted' and (
        (m.source_type='store_sale' and not exists (select 1 from store_sales s where s.id::text=m.source_document_id))
        or (m.source_type='van_sale' and not exists (select 1 from van_sales v where v.id::text=m.source_document_id)))`, []),
  },
  {
    kind: "sale_quantity",
    severity: "critical",
    title: "A sale and its stock movement disagree on quantity",
    classification: "unresolved",
    sql: (db) => db.unsafe(`select null::uuid as product_id,null::uuid as location_id,'store_sale:'||s.receipt_number as ref,
        (select coalesce(sum(quantity_base),0) from inventory_movement_lines where movement_id=s.movement_id)::bigint as ledger,
        (select coalesce(sum((x->>'quantityBase')::bigint),0) from jsonb_array_elements(s.receipt->'lines') x)::bigint as other
      from store_sales s where exists (select 1 from inventory_movements where id=s.movement_id) and jsonb_typeof(s.receipt->'lines')='array' and jsonb_array_length(s.receipt->'lines')>0
        and (select bool_and(x ? 'quantityBase') from jsonb_array_elements(s.receipt->'lines') x)
        and (select coalesce(sum(quantity_base),0) from inventory_movement_lines where movement_id=s.movement_id)
          <> (select coalesce(sum((x->>'quantityBase')::bigint),0) from jsonb_array_elements(s.receipt->'lines') x)
      union all
      select null,null,'van_sale:'||v.receipt_number,
        (select coalesce(sum(ml.quantity_base),0) from inventory_movements m join inventory_movement_lines ml on ml.movement_id=m.id where m.source_type='van_sale' and m.movement_type='pos_sale' and m.source_document_id=v.id::text)::bigint,
        (select coalesce(sum(quantity_base),0) from van_sale_lines where sale_id=v.id)::bigint
      from van_sales v where exists (select 1 from inventory_movements m where m.source_type='van_sale' and m.movement_type='pos_sale' and m.source_document_id=v.id::text)
        and (select coalesce(sum(ml.quantity_base),0) from inventory_movements m join inventory_movement_lines ml on ml.movement_id=m.id where m.source_type='van_sale' and m.movement_type='pos_sale' and m.source_document_id=v.id::text)
          <> (select coalesce(sum(quantity_base),0) from van_sale_lines where sale_id=v.id)`, []),
  },
  {
    kind: "void_without_reversal",
    severity: "critical",
    title: "A voided or refunded sale did not put its stock back",
    classification: "missing_inbound",
    sql: (db) => db.unsafe(`select null::uuid as product_id,null::uuid as location_id,'store_'||r.kind||':'||r.id::text as ref,1::bigint as ledger,0::bigint as other
      from store_reversals r where r.status='approved' and not exists (select 1 from inventory_movements m where m.id=r.movement_id and m.movement_type in ('pos_void','pos_return'))
      union all
      select null,null,'van_void:'||v.id::text,1,0 from van_sale_voids v
      where not exists (select 1 from inventory_movements m where m.source_type='van_sale_void' and m.source_document_id=v.id::text)`, []),
  },
];

/**
 * Nightly check (SPEC 4.7 / 9 item 7, R2 G8): ledger = balances = batch balances, and every paid sale
 * has its stock movement. Runs on a repeatable-read snapshot so a posting in flight cannot look like
 * drift. Writes a run (inventory_reconciliation_runs), its differences, and one OPEN alert per kind
 * that disagrees; an alert whose check is clean again is resolved.
 * @param {any} db @param {{now?:number, startedBy?:string, scope?:string}} [opts]
 */
export async function runIntegrityCheck(db, opts = {}) {
  const now = opts.now ?? Date.now();
  const startedBy = opts.startedBy ?? "system:integrity";
  const found = await snapshot(db, async (t) => {
    /** @type {Array<{check:(typeof INTEGRITY_CHECKS)[number], rows:any[]}>} */ const out = [];
    for (const check of INTEGRITY_CHECKS) out.push({ check, rows: await check.sql(t) });
    const [{ n: balances }] =
      await t`select count(*)::int as n from inventory_balances where organization_id=${ORG}`;
    const [{ n: sales }] =
      await t`select ((select count(*) from store_sales)+(select count(*) from van_sales))::int as n`;
    return { out, compared: Number(balances) + Number(sales) };
  });
  return tx(db, async (t) => {
    const total = found.out.reduce((s, f) => s + f.rows.length, 0);
    const [run] =
      await t`insert into inventory_reconciliation_runs (organization_id,scope,status,operational_cutoff,sap_cutoff,compared_count,difference_count,started_by,started_at,completed_at)
        values (${ORG},${opts.scope ?? "integrity"},'completed',${new Date(now)},${new Date(now)},${found.compared},${total},${startedBy},${new Date(now)},now()) returning id`;
    const alerts = [];
    for (const { check, rows } of found.out) {
      const open =
        await t`select id from inventory_integrity_alerts where organization_id=${ORG} and kind=${check.kind} and status in ('open','acknowledged') limit 1`;
      if (!rows.length) {
        if (open.length)
          await t`update inventory_integrity_alerts set status='resolved',resolved_at=now(),resolved_by='system:integrity' where id=${open[0].id}`;
        continue;
      }
      for (const r of rows.slice(0, 200)) {
        const [codes] = r.product_id
          ? await t`select p.code as product_code,l.code as warehouse_code from products p,inventory_locations l where p.id=${r.product_id} and l.id=${r.location_id}`
          : [{ product_code: String(r.ref).split(":")[0], warehouse_code: "-" }];
        await t`insert into inventory_reconciliation_differences (organization_id,run_id,product_id,location_id,product_code,warehouse_code,operational_base,sap_base,difference_base,classification,resolution_status,check_kind,entity_ref,detail)
          values (${ORG},${run.id},${r.product_id},${r.location_id},${codes?.product_code ?? "-"},${codes?.warehouse_code ?? "-"},${String(r.ledger)},${String(r.other)},${String(BigInt(r.ledger) - BigInt(r.other))},${check.classification},'open',${check.kind},${r.ref},${{ ledger: String(r.ledger), other: String(r.other) }})`;
      }
      const sample = rows.slice(0, 5).map((r) => ({
        ref: r.ref,
        productId: r.product_id,
        locationId: r.location_id,
        ledger: String(r.ledger),
        other: String(r.other),
      }));
      const message = `${check.title}: ${rows.length} ${rows.length === 1 ? "place" : "places"}.`;
      if (open.length)
        await t`update inventory_integrity_alerts set run_id=${run.id},message=${message},detail=${{ count: rows.length, sample }},severity=${check.severity},updated_at=now() where id=${open[0].id}`;
      else
        await t`insert into inventory_integrity_alerts (organization_id,run_id,kind,severity,message,detail) values (${ORG},${run.id},${check.kind},${check.severity},${message},${{ count: rows.length, sample }})`;
      alerts.push({ kind: check.kind, count: rows.length, severity: check.severity });
    }
    return { runId: run.id, compared: found.compared, differences: total, alerts };
  });
}

/** @param {any} ctx */
async function integrityStatus(ctx) {
  const [run] =
    await ctx.db`select * from inventory_reconciliation_runs where organization_id=${ORG} and scope='integrity' order by started_at desc limit 1`;
  const alerts =
    await ctx.db`select id,kind,severity,message,detail,status,created_at,updated_at from inventory_integrity_alerts where organization_id=${ORG} and status in ('open','acknowledged') order by severity,created_at`;
  return {
    lastRun: run
      ? {
          id: run.id,
          at: new Date(run.started_at).getTime(),
          compared: Number(run.compared_count),
          differences: Number(run.difference_count),
          status: run.status,
        }
      : null,
    alerts: alerts.map((/** @type {any} */ a) => ({
      id: a.id,
      kind: a.kind,
      severity: a.severity,
      message: a.message,
      detail: a.detail,
      status: a.status,
      since: new Date(a.created_at).getTime(),
    })),
  };
}

/** @param {any} core */
export function installJobs(core) {
  /** @param {{db:any}} ctx */
  const run = async ({ db }) => {
    const result = await expireLots(db);
    if (result.processed) {
      await core.publish("inventory");
      for (const unitId of result.units)
        await enqueueRefresh(
          { db, publish: core.publish },
          { kind: "stock", date: manilaDate(), unitId },
        );
    }
  };
  core.registerJob("inventory.expire-lots", run);
  core.scheduler.daily("00:15", "Asia/Manila", "inventory.expire-lots", run);
  /** @param {{db:any}} ctx */
  const integrity = async ({ db }) => {
    const result = await runIntegrityCheck(db);
    if (result.differences) await core.publish("inventory");
  };
  core.registerJob("inventory.integrity-check", integrity);
  core.scheduler.daily("02:30", "Asia/Manila", "inventory.integrity-check", integrity);
}

/** Read the latest run + open alerts; an admin can run the check now.
 * @param {import('../../core/router.js').Router} router @param {any} core */
export function installIntegrityRoutes(router, core) {
  router.get("/api/v1/inventory/integrity", async (/** @type {any} */ ctx) => {
    await requireNationalScope(ctx, ["admin"]);
    return integrityStatus(ctx);
  });
  router.post("/api/v1/inventory/integrity/run", async (/** @type {any} */ ctx) => {
    await requireNationalScope(ctx, ["admin"]);
    const result = await runIntegrityCheck(ctx.db, { startedBy: ctx.actor?.userId ?? "system:integrity", now: ctx.now });
    await core.publish("inventory");
    return { ...result, ...(await integrityStatus(ctx)) };
  });
}
