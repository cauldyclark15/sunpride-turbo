import { requireNationalScope } from "../../core/capabilities.js";
import { scopeFilterForActor } from "../org/scope.js";
import { forbidden } from "../../core/errors.js";
import {
  accessOutlet,
  bounded,
  changed,
  choice,
  integer,
  invalid,
  scoped,
  text,
  uuid,
} from "./common.js";
/** F-614: descendant lots are potentially affected; do not label FEFO inference as physical receipt confirmation.
 * @param {any} c @param {string} lotId */
export async function traceBatch(c, lotId) {
  const [lot] =
    await c.db`select l.*,p.name as product_name,p.code as product_code from inventory_lots l join products p on p.id=l.product_id where l.id=${uuid(lotId)} and l.organization_id='sunpride'`;
  if (!lot) throw invalid("Choose a batch");
  const lots = bounded(
    await c.db`with recursive impacted(id) as (
    select ${lot.id}::uuid
    union select g.output_lot_id from impacted i join lot_genealogy_links g on g.component_lot_id=i.id where g.organization_id='sunpride'
  ) select id from impacted limit 501`,
  );
  const ids = lots.map((/** @type {any} */ l) => l.id);
  const confirmed = bounded(
    await c.db`select r.*,o.name as outlet_name,l.lot_number from retail_batch_receipts r join outlets o on o.id=r.outlet_id join inventory_lots l on l.id=r.lot_id where r.lot_id in ${c.db(ids)} order by r.received_at,r.id limit 5001`,
    5000,
  );
  const inferred = bounded(
    await c.db`select a.id,a.lot_id,s.outlet_id,o.name as outlet_name,l.lot_number,a.quantity_base,m.source_document_id as source_key,m.effective_at as received_at,exists(select 1 from van_sale_voids v where v.sale_id=s.id) as voided from inventory_allocations a join inventory_movements m on m.id=a.movement_id join van_sales s on s.id::text=m.source_document_id join van_trips t on t.id=s.trip_id join outlets o on o.id=s.outlet_id join inventory_lots l on l.id=a.lot_id where a.lot_id in ${c.db(ids)} and a.organization_id='sunpride' and m.source_type='van_sale' and a.from_location_id=t.truck_location_id order by m.effective_at,a.id limit 5001`,
    5000,
  );
  const rows = await scoped(
    c,
    [
      ...confirmed.map((/** @type {any} */ r) => ({
        ...r,
        certainty:
          r.source_kind === "sample"
            ? "sample_confirmation"
            : "confirmed_receipt",
      })),
      ...inferred.map((/** @type {any} */ r) => ({
        ...r,
        certainty: "allocation_inference",
      })),
    ],
    (r) => r.outlet_id,
  );
  const genealogy = bounded(
    await c.db`select g.output_lot_id,g.component_lot_id,l.lot_number as component_batch,p.name as component_product from lot_genealogy_links g join inventory_lots l on l.id=g.component_lot_id join products p on p.id=l.product_id where g.output_lot_id in ${c.db(ids)} and g.organization_id='sunpride' limit 501`,
  );
  // Source-location authorization is independent of current outlet ownership.
  const allowed = [];
  for (const r of rows) {
    if (r.certainty === "allocation_inference") {
      const [source] =
        await c.db`select t.org_unit_id from van_sales s join van_trips t on t.id=s.trip_id where s.id::text=${r.source_key}`;
      if (!source?.org_unit_id) continue;
      const { requireCapability } = await import("./common.js");
      try {
        await requireCapability(c, "inventory.read", source.org_unit_id);
      } catch {
        continue;
      }
    }
    allowed.push(r);
  }
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  if (unitIds !== null && !allowed.length)
    throw forbidden(
      "No received outlet from this batch is in your scope",
      "out_of_scope",
    );
  return {
    lot: {
      id: lot.id,
      batch: lot.lot_number,
      product: lot.product_name,
      productCode: lot.product_code,
    },
    descendantLotIds:
      unitIds === null ? ids : [...new Set(allowed.map((r) => r.lot_id))],
    backwardGenealogy: unitIds === null ? genealogy : [],
    rows: allowed,
    affectedOutlets: new Set(allowed.map((r) => r.outlet_id)).size,
    completeness: "supported_sources_only",
    warning:
      "Confirmed receipts and inferred van allocations are separate. Uncaptured delivery batches are not proven absent.",
  };
}
/** @param {any} c */
export async function confirmReceipt(c) {
  const b = c.body;
  await accessOutlet(c, uuid(b.outletId), "outlet.manage");
  const [lot] =
    await c.db`select id from inventory_lots where id=${uuid(b.lotId)} and organization_id='sunpride'`;
  if (!lot) throw invalid();
  const sourceKey = text(b.sourceKey, 200),
    version = text(b.sourceVersion, 100),
    qty = integer(b.quantityBase, 1_000_000_000, 1);
  if (!Number.isSafeInteger(b.receivedAt) || b.receivedAt > c.now)
    throw invalid("Check the received date");
  await c.db`select pg_advisory_xact_lock(hashtextextended(${`retail-receipt:${sourceKey}`},0))`;
  const [old] =
    await c.db`select * from retail_batch_receipts where source_key=${sourceKey}`;
  if (old) {
    if (
      old.outlet_id !== b.outletId ||
      old.lot_id !== b.lotId ||
      Number(old.quantity_base) !== qty ||
      old.source_version !== version ||
      +new Date(old.received_at) !== b.receivedAt
    )
      throw invalid("Receipt source conflicts");
    return { id: old.id };
  }
  const [r] =
    await c.db`insert into retail_batch_receipts(outlet_id,lot_id,quantity_base,source_key,source_kind,source_version,received_at,actor_subject) values(${b.outletId},${b.lotId},${qty},${sourceKey},'delivery_confirmation',${version},${new Date(b.receivedAt)},${c.actor.subject}) returning id`;
  await changed(c, "batch.confirmed", r.id);
  return { id: r.id };
}
/** @param {any} c */
export async function openRecall(c) {
  await requireNationalScope(c, ["super_admin", "admin", "operations"]);
  const b = c.body,
    trace = await traceBatch(c, uuid(b.lotId));
  const [r] =
    await c.db`insert into retail_recall_cases(lot_id,reason,actor_subject) values(${trace.lot.id},${text(b.reason, 1000)},${c.actor.subject}) returning id`;
  await changed(c, "recall.opened", r.id);
  return { id: r.id, trace };
}
/** @param {any} c @param {string} id */
export async function recallDetail(c, id) {
  const [recall] =
    await c.db`select * from retail_recall_cases where id=${uuid(id)}`;
  if (!recall) throw invalid();
  const trace = await traceBatch(c, recall.lot_id);
  const events = await scoped(
    c,
    bounded(
      await c.db`select * from retail_recall_events where recall_id=${id} order by created_at,id limit 5001`,
      5000,
    ),
    (r) => r.outlet_id,
  );
  return {
    recall,
    trace,
    events,
    outlets: [
      ...new Set(trace.rows.map((/** @type {any} */ r) => r.outlet_id)),
    ].map((outletId) => {
      const rows = trace.rows.filter(
          (/** @type {any} */ r) => r.outlet_id === outletId,
        ),
        e = events.filter((/** @type {any} */ r) => r.outlet_id === outletId);
      const confirmed = rows
        .filter(
          (/** @type {any} */ r) => r.certainty !== "allocation_inference",
        )
        .reduce(
          (/** @type {number} */ n, /** @type {any} */ r) =>
            n + Number(r.quantity_base),
          0,
        );
      const inferred = rows
        .filter(
          (/** @type {any} */ r) => r.certainty === "allocation_inference",
        )
        .reduce(
          (/** @type {number} */ n, /** @type {any} */ r) =>
            n + Number(r.quantity_base),
          0,
        );
      const recovered = e
        .filter((/** @type {any} */ r) => r.kind === "recovery")
        .reduce(
          (/** @type {number} */ n, /** @type {any} */ r) =>
            n + Number(r.quantity_base),
          0,
        );
      return {
        outletId,
        outletName: rows[0].outlet_name,
        confirmedBase: confirmed,
        inferredBase: inferred,
        recoveredBase: recovered,
        remainingConfirmedBase: Math.max(0, confirmed - recovered),
        acknowledged: e.some(
          (/** @type {any} */ r) => r.kind === "acknowledge",
        ),
      };
    }),
  };
}
/** @param {any} c */
export async function recallEvent(c) {
  const b = c.body;
  await accessOutlet(c, uuid(b.outletId), "outlet.manage");
  await c.db`select pg_advisory_xact_lock(hashtextextended(${`recall:${b.recallId}`},0))`;
  const detail = await recallDetail(c, uuid(b.recallId));
  if (detail.recall.status !== "open") throw invalid();
  const outlet = detail.outlets.find(
    (/** @type {any} */ o) => o.outletId === b.outletId,
  );
  if (!outlet) throw invalid("Outlet is not in this batch trace");
  const kind = choice(b.kind, [
      "notice",
      "acknowledge",
      "recovery",
      "disposition",
    ]),
    qty = integer(b.quantityBase ?? 0);
  if (kind === "recovery" && (qty <= 0 || qty > outlet.remainingConfirmedBase))
    throw invalid("Reconcile confirmed receipt quantities before recovery");
  if (kind !== "recovery" && qty !== 0) throw invalid();
  const [r] =
    await c.db`insert into retail_recall_events(recall_id,outlet_id,kind,quantity_base,reference,actor_subject) values(${b.recallId},${b.outletId},${kind},${qty},${text(b.reference, 500)},${c.actor.subject}) returning id`;
  await changed(c, "recall.event", r.id);
  return { id: r.id };
}
