import { canonicalJson } from "../../core/util.js";
import { tripFor, outletFor, notSelf } from "./access.js";
import { uuid, text, rows, integer, refuse } from "./model.js";
import { productFor, frozenProduct, audit } from "./facts.js";
import { validateReturnEvidence } from "./return-evidence.js";
import { enqueueVanCreditMemo } from "../integration/posting.js";
/** F-113: a pickup is custody evidence, not an invented stock asset, refund or financial credit.
 * @param {any} db @param {any} trip @param {any} actor @param {any} p */
export async function capturePickup(db, trip, actor, p) {
  // VAN-061: a pre-F-113 (operations version 0) trip has no signed return evidence. The handheld still saves a return
  // that needs office approval ("Thrown away at the store") as "Waiting for office approval" and moves no truck stock
  // for it, so it is held here as custody for the same office pickup review instead of being refused on sync.
  const legacy = trip.operations_version !== 1 && p.settlementVersion !== 1;
  if (
    p.refund ||
    (p.custodyOnly !== true && !(legacy && p.approval?.required === true))
  )
    refuse(
      "Update the handheld to record this pickup without inventing stock or a refund",
    );
  const customer = await outletFor(db, actor, uuid(p.customer?.outletId));
  const id = uuid(p.returnId),
    input = rows(p.lines),
    seen = new Set();
  const [prior] = await db`select * from van_returns where id=${id}`;
  if (prior) {
    if (
      prior.trip_id !== trip.id ||
      canonicalJson(prior.captured_request) !== canonicalJson(p)
    )
      refuse("Return identifier was reused", "idempotency_conflict");
    return { entityId: id };
  }
  if (!legacy) await validateReturnEvidence(db, trip, p);
  const frozen = [];
  for (const l of input) {
    const product = await productFor(db, uuid(l.productId), p.deviceTime);
    const quantity = integer(l.quantityBase, true);
    if (
      seen.has(l.productId) ||
      l.stockEffect !== "none" ||
      !product.factors.has(l.uomCode)
    )
      refuse(
        "Pickup needs distinct governed products and no sellable stock effect",
      );
    seen.add(l.productId);
    text(l.lotNumber, 80, !legacy);
    if (legacy) text(l.reason, 80, true);
    if (
      String(l.product?.quantityScale) !== String(product.scale) ||
      l.product?.uomCode !== product.base_code
    )
      refuse(
        "Pickup unit changed; ask the office to reconcile the captured pack",
      );
    if (
      !["resellable", "bad_stock", "disposed_at_outlet"].includes(l.disposition)
    )
      refuse("Choose a pickup disposition");
    frozen.push({
      ...l,
      quantityBase: String(quantity),
      product: frozenProduct(product),
    });
  }
  await db`insert into van_returns(id,trip_id,sale_id,return_number,captured_request,custody_only,outlet_id,recorded_by) values(${id},${trip.id},null,${text(p.returnNumber, 100, true)},${p},true,${customer.id},${actor.profileId})`;
  for (const [i, l] of frozen.entries())
    await db`insert into van_return_lines(return_id,ordinal,product_id,quantity_base,stock_status,facts) values(${id},${i + 1},${l.productId},${l.quantityBase},'none',${l})`;
  return { entityId: id };
}
/** @param {any} db @param {string} tripId */
export async function pickupManifest(db, tripId) {
  const rows =
    await db`select id from van_returns where trip_id=${tripId} and custody_only and exists(select 1 from jsonb_array_elements(captured_request->'lines') l where l->>'disposition'<>'disposed_at_outlet') order by id limit 501`;
  if (rows.length > 500) refuse("Too many pickup bags for one trip");
  return rows.map((/** @type {any} */ r) => r.id);
}
/** @param {any} db @param {any} actor @param {string} tripId */
export async function pickupQueue(db, actor, tripId) {
  await tripFor(db, actor, uuid(tripId));
  const items =
    await db`select r.id,r.return_number as "returnNumber",o.name as "customerName",r.captured_request as capture,(select coalesce(jsonb_agg(jsonb_build_object('kind',d.kind,'reason',d.reason,'by',p.name) order by d.created_at),'[]') from van_return_reviews d join profiles p on p.id=d.actor_profile_id where d.return_id=r.id) as decisions from van_returns r join outlets o on o.id=r.outlet_id where r.trip_id=${tripId} and r.custody_only order by r.created_at,r.id limit 501`;
  if (items.length > 500) refuse("Pickup list exceeds supported trip size");
  return { items };
}
/** r6van3: the office's latest pickup decision per held return of this trip, for the van phone's bundle
 * (`policy.pickupDecisions`, opt-in). A return the office has not decided yet is simply absent.
 * @param {any} db @param {string} tripId */
export async function pickupDecisions(db, tripId) {
  const rows =
    await db`select distinct on (d.return_id) d.return_id as "returnId",d.kind as decision,d.reason,(extract(epoch from d.created_at)*1000)::bigint::text as "decidedAt" from van_return_reviews d join van_returns r on r.id=d.return_id where r.trip_id=${tripId} and r.custody_only order by d.return_id,d.created_at desc,d.id limit 501`;
  if (rows.length > 500) refuse("Pickup list exceeds supported trip size");
  return rows.map((/** @type {any} */ r) => ({
    returnId: r.returnId,
    decision: r.decision,
    reason: r.reason,
    decidedAt: Number(r.decidedAt),
  }));
}
/** F-113 independent physical disposition and a separate SAP credit request; captured evidence never changes.
 * @param {any} db @param {any} actor @param {any} p */
export async function reviewPickup(db, actor, p) {
  const [r] =
    await db`select * from van_returns where id=${uuid(p.returnId)} and custody_only for update`;
  if (!r) refuse("Pickup not found");
  const trip = await tripFor(db, actor, r.trip_id, "van.stock.approve", true);
  notSelf(actor, trip);
  if (r.recorded_by === actor.profileId)
    refuse("Another person must review this pickup");
  const kind = p.decision,
    reason = text(p.reason, 300, true);
  if (
    ![
      "warehouse_received",
      "returned_to_outlet",
      "disposal_verified",
      "credit_requested",
    ].includes(kind)
  )
    refuse("Choose a pickup decision");
  const decisions =
    await db`select kind from van_return_reviews where return_id=${r.id}`;
  if (decisions.some((/** @type {any} */ d) => d.kind === kind))
    refuse("That pickup action is already recorded");
  if (decisions.some((/** @type {any} */ d) => d.kind === "credit_requested"))
    refuse(
      "Credit was already requested; use the integration exception workflow instead of changing custody",
    );
  if (
    decisions.some((/** @type {any} */ d) =>
      ["returned_to_outlet", "disposal_verified"].includes(d.kind),
    )
  )
    refuse("Pickup disposition is already final");
  let facts = {};
  if (kind === "credit_requested") {
    if (
      !decisions.some((/** @type {any} */ d) => d.kind === "warehouse_received")
    )
      refuse("Confirm physical warehouse custody before requesting credit");
    const matches =
      await db`select * from van_sales where receipt_number=${text(p.invoiceNumber, 100, true)} and outlet_id=${r.outlet_id} limit 2`;
    if (matches.length !== 1)
      refuse("Choose one original invoice for this customer");
    const sale = matches[0];
    await tripFor(db, actor, sale.trip_id);
    if (
      (await db`select 1 from van_sale_voids where sale_id=${sale.id}`).length
    )
      refuse("A void invoice cannot receive return credit");
    const lines =
      await db`select * from van_return_lines where return_id=${r.id} order by ordinal`;
    for (const l of lines) {
      const original = sale.receipt.lines.find(
        (/** @type {any} */ x) => x.productId === l.product_id,
      );
      if (
        !original ||
        String(original.quantityScale) !== String(l.facts.product.quantityScale)
      )
        refuse("The pickup does not match the original invoice product/unit");
      const [prior] =
        await db`select coalesce(sum(l.quantity_base),0)::text as quantity from van_return_lines l join van_returns r on r.id=l.return_id where r.sale_id=${sale.id} and r.id<>${r.id} and l.product_id=${l.product_id}`;
      if (
        BigInt(prior.quantity) + BigInt(l.quantity_base) >
        BigInt(original.quantityBase)
      )
        refuse("Pickup credit exceeds the original invoice quantity");
    }
    await db`update van_returns set sale_id=${sale.id} where id=${r.id}`;
    facts = { invoiceNumber: sale.receipt_number, saleId: sale.id };
    await enqueueVanCreditMemo(db, trip, r.id);
  }
  await db`insert into van_return_reviews(return_id,kind,reason,actor_profile_id,facts) values(${r.id},${kind},${reason},${actor.profileId},${facts})`;
  await audit(db, trip, actor, `van.pickup.${kind}`, r.id, { reason });
  return { tripId: trip.id, returnId: r.id, decision: kind };
}
