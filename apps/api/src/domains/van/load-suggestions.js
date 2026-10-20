import { tripFor, outletFor, locationFor } from "./access.js";
import { audit, productFor } from "./facts.js";
import { planLoad } from "./commands.js";
import { rows, uuid, text, integer, dayString, refuse } from "./model.js";
import { scopeParams, ORDER_FROM, ORDER_ACCESS } from "../orders/access.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";

/** F-102 forecast each class from the three explicit route cycles, then use max(forecast, committed demand).
 * @param {{classMix:Record<string,number>,cycles:Array<{id:string,rows:Array<{productId:string,classification:string,outletId:string,quantityBase:string}>}>,orders:Array<{id:string,productId:string,quantityBase:string}>,stockedProductIds?:string[]}} inputs
 */
export function suggestQuantities(inputs) {
  const products = new Set([
    ...inputs.cycles.flatMap((c) => c.rows.map((r) => r.productId)),
    ...inputs.orders.map((o) => o.productId),
    ...(inputs.stockedProductIds ?? []),
  ]);
  return [...products].sort().map((productId) => {
    let forecast = 0n;
    const cycleFacts = inputs.cycles.map((c) => {
      let weighted = 0n;
      const classes = [];
      for (const [classification, currentStores] of Object.entries(
        inputs.classMix,
      )) {
        const source = c.rows.filter(
            (r) => r.classification === classification,
          ),
          stores = new Set(source.map((r) => r.outletId)).size;
        const quantity = source
          .filter((r) => r.productId === productId)
          .reduce((q, r) => q + integer(r.quantityBase), 0n);
        const adjusted = stores
          ? (quantity * BigInt(currentStores) + BigInt(stores) - 1n) /
            BigInt(stores)
          : 0n;
        weighted += adjusted;
        classes.push({
          classification,
          currentStores,
          sourceStores: stores,
          quantityBase: String(quantity),
          adjustedBase: String(adjusted),
        });
      }
      forecast += weighted;
      return { tripId: c.id, classes, weightedBase: String(weighted) };
    });
    const average = inputs.cycles.length
      ? (forecast + BigInt(inputs.cycles.length) - 1n) /
        BigInt(inputs.cycles.length)
      : 0n;
    const orders = inputs.orders.filter((o) => o.productId === productId),
      presell = orders.reduce((q, o) => q + integer(o.quantityBase), 0n);
    return {
      productId,
      forecastBase: String(average),
      presellBase: String(presell),
      suggestedBase: String(average > presell ? average : presell),
      cycles: cycleFacts,
      orderIds: [...new Set(orders.map((o) => o.id))],
    };
  });
}

/** @param {any} db @param {any} actor @param {any} p */
export async function suggestLoad(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "van.manage", true);
  if (trip.status !== "planned" || !trip.route_id)
    refuse("Plan a route before suggesting its load");
  await locationFor(db, actor, trip.source_location_id, "van.manage");
  const day = new Date(`${dayString(trip.service_date)}T12:00:00+08:00`);
  const roster =
    await db`select o.id,o.classification from outlet_assignments a join outlets o on o.id=a.outlet_id where a.route_id=${trip.route_id} and a.effective_from<=${day} and (a.effective_to is null or a.effective_to>${day}) and a.deleted_at is null and o.deleted_at is null and o.status='active' order by a.sequence,o.id limit 601`;
  if (roster.length > 600)
    refuse("The route exceeds the supported load planning bound");
  /** @type {Record<string,number>} */ const classMix = {};
  const outlets = [];
  for (const o of roster) {
    await outletFor(db, actor, o.id);
    const classification = o.classification ?? "Unclassified";
    classMix[classification] = (classMix[classification] ?? 0) + 1;
    outlets.push(o.id);
  }
  const prior =
    await db`select id,service_date from van_trips where route_id=${trip.route_id} and org_unit_id=${trip.org_unit_id} and status='closed' and service_date<${dayString(trip.service_date)} and deleted_at is null order by service_date desc,created_at desc limit 3`;
  const cycles = [];
  for (const cycle of prior) {
    const sales =
      await db`select s.outlet_id as "outletId",l.product_id as "productId",l.quantity_base::text as "quantityBase",coalesce(s.receipt->'customer'->>'classification',o.classification,'Unclassified') as classification from van_sales s join van_sale_lines l on l.sale_id=s.id join outlets o on o.id=s.outlet_id where s.trip_id=${cycle.id} and not exists(select 1 from van_sale_voids v where v.sale_id=s.id) order by s.id,l.ordinal limit 2001`;
    if (sales.length > 2000)
      refuse("A source route cycle exceeds the supported load planning bound");
    for (const s of sales) await outletFor(db, actor, s.outletId);
    cycles.push({
      id: cycle.id,
      date: dayString(cycle.service_date),
      rows: sales,
    });
  }
  const params = await scopeParams({ db, actor });
  const orders = outlets.length
    ? await db.unsafe(
        `select o.id,l.product_id as "productId",l.quantity_base::text as "quantityBase" ${ORDER_FROM} join order_lines l on l.order_id=o.id where ${ORDER_ACCESS} and o.outlet_id in (select jsonb_array_elements_text($3::text::jsonb)::uuid) and o.status in ('submitted','pending_approval','approved','sent_to_sap') and coalesce(o.service_date,(o.created_at at time zone 'Asia/Manila')::date)<=$4::date and l.quantity_base is not null order by o.id,l.ordinal limit 2001`,
        [...params, JSON.stringify(outlets), dayString(trip.service_date)],
      )
    : [];
  if (orders.length > 2000)
    refuse("Open pre-sell demand exceeds the load planning bound");
  // An initial route has no sales history. Expose only its authorized depot's
  // stocked products, with ZERO forecasts, so the reviewer can enter a first load.
  // These are catalog candidates, never fabricated offtake or pre-sell orders.
  const stocked =
    await db`select b.product_id from inventory_balances b join products p on p.id=b.product_id where b.location_id=${trip.source_location_id} and b.available_base>0 and b.deleted_at is null and p.active and p.deleted_at is null order by b.product_id limit 601`;
  const draft = suggestQuantities({
    classMix,
    cycles,
    orders,
    stockedProductIds: stocked.map((/** @type {any} */ p) => p.product_id),
  });
  if (stocked.length > 600 || draft.length > 600)
    refuse("The depot catalog exceeds the supported load planning bound");
  const recommendations = [];
  for (const r of draft) {
    const product = await productFor(db, r.productId),
      wanted = integer(r.suggestedBase);
    const [balance] =
      await db`select available_base from inventory_balances where location_id=${trip.source_location_id} and product_id=${product.id} and deleted_at is null`;
    const available = BigInt(balance?.available_base ?? 0),
      rounded =
        product.caseBase > 0n
          ? ((wanted + product.caseBase - 1n) / product.caseBase) *
            product.caseBase
          : wanted;
    const quantity = rounded < available ? rounded : available;
    recommendations.push({
      ...r,
      code: product.code,
      name: product.name,
      uomCode: product.base_code,
      quantityScale: String(product.quantityScale),
      caseBase: String(product.caseBase),
      depotAvailableBase: String(available),
      recommendedBase: String(quantity > 0n ? quantity : 0n),
    });
  }
  const facts = {
    classMix,
    routeId: trip.route_id,
    routeOutletCount: outlets.length,
    cycles: cycles.map((c) => ({ tripId: c.id, date: c.date })),
    sourceOrderCount: new Set(orders.map((/** @type {any} */ o) => o.id)).size,
    manualInitialLoad: !cycles.some((c) => c.rows.length) && !orders.length,
    recommendations,
    algorithm:
      "Class-adjusted average of up to three completed cycles, rounded to cases; max with open pre-sell demand avoids double counting. Depot availability caps the recommendation. Prior sales without a class snapshot use the current class, explicitly provisional. Depot-only products have zero forecast; a first load requires the reviewer's entered quantities.",
    capacity:
      "Review truck capacity before applying; weight/volume capacity is not provided.",
  };
  const hash = sha256Hex(canonicalJson(facts));
  const [s] =
    await db`insert into van_load_suggestions(trip_id,content_hash,facts,created_by) values(${trip.id},${hash},${facts},${actor.profileId}) returning id`;
  await audit(db, trip, actor, "van.load.suggested", s.id);
  return { tripId: trip.id, suggestionId: s.id, contentHash: hash, ...facts };
}

/** F-102 applies only an independently reviewed snapshot through the EXISTING load writer. @param {any} db @param {any} actor @param {any} p */
export async function applySuggestion(db, actor, p) {
  const trip = await tripFor(db, actor, uuid(p.tripId), "van.manage", true);
  const [s] =
    await db`select * from van_load_suggestions where id=${uuid(p.suggestionId)} and trip_id=${trip.id}`;
  if (!s || s.content_hash !== p.contentHash || p.capacityReviewed !== true)
    refuse("Review this load suggestion and truck capacity before applying");
  const chosen = rows(p.lines),
    seen = new Set(),
    loadLines = [];
  for (const line of chosen) {
    const productId = uuid(line.productId),
      qty = integer(line.quantityBase);
    if (
      seen.has(productId) ||
      !s.facts.recommendations.some(
        (/** @type {any} */ r) => r.productId === productId,
      )
    )
      refuse("Choose each suggested product once");
    seen.add(productId);
    if (!qty) continue;
    const product = await productFor(db, productId);
    const [policy] =
      await db`select tracking_mode from product_inventory_policies where product_id=${productId} and active and deleted_at is null`;
    if (!policy || policy.tracking_mode === "none") {
      loadLines.push({ productId, expectedBase: String(qty) });
      continue;
    }
    const lots =
      await db`select b.lot_id,b.available_base from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.location_id=${trip.source_location_id} and b.product_id=${productId} and b.stock_status='available' and b.available_base>0 and l.quality_status='released' and (l.expires_at is null or l.expires_at>${new Date(`${dayString(trip.service_date)}T23:59:59+08:00`)}) order by b.expiry_sort_key,b.receipt_sequence,b.id for update of b,l`;
    let left = qty;
    for (const lot of lots) {
      if (left <= 0n) break;
      const n = BigInt(lot.available_base),
        take = n < left ? n : left;
      loadLines.push({
        productId,
        lotId: lot.lot_id,
        expectedBase: String(take),
      });
      left -= take;
    }
    if (left > 0n)
      refuse(
        `Not enough eligible depot batches for ${product.name}`,
        "stock_conflict",
      );
  }
  const result = await planLoad(db, actor, {
    tripId: trip.id,
    lines: loadLines,
  });
  await db`insert into van_load_suggestion_reviews(suggestion_id,load_id,facts,reviewed_by) values(${s.id},${result.loadId},${{ chosen, note: text(p.note, 300, true), capacityReviewed: true }},${actor.profileId})`;
  return result;
}
