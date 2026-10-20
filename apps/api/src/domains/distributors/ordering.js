import { applyPromotions } from "../orders/pricing.js";
import {
  date,
  digest,
  fail,
  integer,
  list,
  master,
  product,
  text,
  today,
  uuid,
} from "./model.js";
import { sapCreditCheck, enqueueSapPosting } from "./seams.js";

/** F-403/F-410: eligible existing promotion rules, one governed quotation. TPM replaces
 * only the evaluator seam at integration, never a second distributor scheme engine.
 * @param {any} c @param {any} d @param {any} b */
export async function quote(c, d, b) {
  const m = await master(c, d.id),
    entries = list(b.lines, 100);
  if (!entries.length) fail("Add at least one order line");
  const seen = new Set();
  const lines = [];
  for (const input of entries) {
    const p = await product(c, d.id, uuid(input.productId));
    if (seen.has(p.productId)) fail("Combine duplicate products in one line");
    seen.add(p.productId);
    const quantity = integer(input.quantity, 1, 1000000),
      quantityBase = integer(quantity * integer(p.unitsPerUom, 1));
    const [reserved] =
      await c.db`select coalesce(sum(l.quantity_base),0)::text as n from order_lines l join orders o on o.id=l.order_id where o.purchasing_distributor_id=${d.id} and o.status not in ('rejected','voided','fulfilled','posted') and l.product_id=${p.productId}`;
    const available = Math.max(
      0,
      integer(p.availableBase) - Number(reserved.n),
    );
    const unitPrice = integer(p.priceCentavos),
      total = integer(quantity * unitPrice);
    lines.push({
      productId: p.productId,
      productCode: p.code,
      description: p.name,
      uom: p.uom,
      quantity,
      quantityBase,
      unitPriceCentavos: unitPrice,
      lineTotalCentavos: total,
      availableBase: available,
      inStock: quantityBase <= available,
      priceListId: p.priceListId ?? null,
      source: m.source,
    });
  }
  const schemeIds = list(m.payload.schemes ?? [], 100)
    .filter(
      (s) =>
        (!s.distributorIds?.length || s.distributorIds.includes(d.id)) &&
        (!s.channelKeys?.length || s.channelKeys.includes("distributor")) &&
        (!s.startsOn || date(s.startsOn) <= today(c.now)) &&
        (!s.endsOn || date(s.endsOn) >= today(c.now)),
    )
    .map((s) => uuid(s.promotionId));
  const promotions = schemeIds.length
    ? await c.db`select * from promotions where id in ${c.db(schemeIds)} and organization_id='sunpride' and status='active' and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by code`
    : [];
  const benefit = applyPromotions(lines, promotions);
  // The shared evaluator returns gross line values plus a basket discount; allocate
  // discount in integer centavos so canonical lines reconcile exactly to total.
  let left =
    Number(benefit.knownSubtotalCentavos) - Number(benefit.totalCentavos);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const discount =
      i === lines.length - 1
        ? left
        : Math.min(
            left,
            Number(
              (BigInt(line.lineTotalCentavos) *
                BigInt(
                  Number(benefit.knownSubtotalCentavos) -
                    Number(benefit.totalCentavos),
                )) /
                BigInt(benefit.knownSubtotalCentavos || 1),
            ),
          );
    line.lineTotalCentavos -= discount;
    left -= discount;
  }
  const freeGoods = [];
  for (const promotion of benefit.promotionsApplied)
    for (const free of promotion.freeGoods ?? []) {
      const p = await product(c, d.id, free.productId),
        quantityBase = integer(free.quantity * integer(p.unitsPerUom, 1));
      if (free.uom !== p.uom)
        fail("Scheme free-unit master mismatch", "needs_setup");
      const paidLine = lines.find((l) => l.productId === p.productId);
      const paid = paidLine?.quantityBase ?? 0;
      const [reserved] =
        await c.db`select coalesce(sum(l.quantity_base),0)::text as n from order_lines l join orders o on o.id=l.order_id where o.purchasing_distributor_id=${d.id} and o.status not in ('rejected','voided','fulfilled','posted') and l.product_id=${p.productId}`;
      const availableBase = Math.max(
        0,
        integer(p.availableBase) - Number(reserved.n),
      );
      freeGoods.push({
        productId: p.productId,
        productCode: p.code,
        description: p.name,
        uom: free.uom,
        quantity: free.quantity,
        quantityBase,
        unitPriceCentavos: 0,
        lineTotalCentavos: 0,
        priceListId: p.priceListId ?? null,
        inStock: paid + quantityBase <= availableBase,
        availableBase,
      });
    }
  const credit = await sapCreditCheck(c, d, Number(benefit.totalCentavos));
  return {
    lines,
    freeGoods,
    totalCentavos: benefit.totalCentavos,
    subtotalCentavos: benefit.subtotalCentavos,
    schemes: promotions.map((/** @type {any} */ p) => ({
      id: p.id,
      name: p.name,
      eligible: true,
      reason: "Assigned partner, channel, dates and catalog",
      applied: benefit.promotionsApplied.some((x) => x.id === p.id),
    })),
    benefits: benefit.promotionsApplied,
    credit,
    canConfirm:
      d.status === "accredited" &&
      lines.every((l) => l.inStock) &&
      freeGoods.every((l) => l.inStock) &&
      credit.status === "within",
    provenance: {
      source: m.source,
      sourceKey: m.source_key,
      version: Number(m.version),
      receivedAt: m.received_at,
    },
    terms: m.payload.terms,
  };
}
/** F-403: SAME orders/order_lines object with partner PO, frozen pricing and SAP acknowledgement.
 * SEAM(ORDERS): commercial writer adapter. Consolidate with createOrder's authorization
 * strategy at integration; no separate order workflow or posting ledger is introduced.
 * @param {any} c @param {any} d @param {any} b */
export async function placeOrder(c, d, b) {
  if (d.status !== "accredited" || !d.sap_customer_code)
    fail("Accreditation and SAP customer code required");
  const po = text(b.poNumber, "Purchase order reference");
  const [old] =
    await c.db`select id from orders where purchasing_distributor_id=${d.id} and customer_po_number=${po}`;
  if (old) fail("Purchase order reference already submitted", "conflict", 409);
  const q = await quote(c, d, b);
  if (!q.canConfirm)
    fail(
      q.credit.status !== "within"
        ? "SAP credit check blocks this order; ask Sunpride credit control"
        : "Requested stock is not available",
      "order_blocked",
    );
  const id = crypto.randomUUID(),
    number = `DP-${id.slice(0, 8).toUpperCase()}`;
  const req = await enqueueSapPosting(c, d, "primary_order", id, {
    orderId: id,
    poNumber: po,
    totalCentavos: q.totalCentavos,
    lines: q.lines,
    freeGoods: q.freeGoods,
  });
  const ack = req.acknowledgement;
  const [row] =
    await c.db`insert into orders(id,organization_id,client_request_id,order_number,order_type,customer_code,salesperson_subject,created_by_subject,purchasing_distributor_id,customer_po_number,channel_key,service_date,status,subtotal,total,subtotal_centavos,total_centavos,amount_known,credit_status,credit_limit_centavos,credit_exposure_centavos,pricing_snapshot,request_payload_hash,acknowledged_at,promised_delivery_date,sap_acknowledgement) values(${id},'sunpride',${`distributor:${id}`},${number},'distributor_primary',${d.sap_customer_code},${c.actor.subject},${c.actor.subject},${d.id},${po},'distributor',${today(c.now)},'submitted',${(q.subtotalCentavos ?? 0) / 100},${(q.totalCentavos ?? 0) / 100},${q.subtotalCentavos},${q.totalCentavos},true,'within',${q.credit.limitCentavos},${q.credit.exposureCentavos},${q},${digest(b)},${ack ? new Date(c.now) : null},${ack?.deliveryDate ?? null},${ack}) returning id,order_number,status,acknowledged_at,promised_delivery_date`;
  for (const [i, l] of [...q.lines, ...q.freeGoods].entries())
    await c.db`insert into order_lines(order_id,ordinal,product_id,product_code,description,uom,quantity,quantity_base,unit_price,line_total,unit_price_centavos,line_total_centavos) values(${id},${i},${l.productId},${l.productCode},${l.description},${l.uom},${l.quantity},${l.quantityBase},${l.unitPriceCentavos / 100},${l.lineTotalCentavos / 100},${l.unitPriceCentavos},${l.lineTotalCentavos})`;
  await c.db`insert into order_history(order_id,actor_subject,action,to_status) values(${id},${c.actor.subject},'F-403.distributor_created','submitted')`;
  return {
    ...row,
    totalCentavos: q.totalCentavos,
    acknowledgement: ack,
    sapRequestId: req.id,
  };
}
