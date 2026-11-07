import { productFor } from "../van/facts.js";
import { resolvePrice, activePromotions } from "../orders/pricing.js";
import { eligibilityFacts } from "../tpm/campaigns.js";
import { eligibility } from "../tpm/engine.js";
import { fiscalBundle } from "../fiscal/transactions.js";
import { tenderPolicy } from "../fiscal/tenders.js";
import { STATUSES, STATUS_FIELDS } from "../inventory/common.js";
import { refuse } from "../van/model.js";
import { refundBundle } from "../fiscal/refunds.js";
/** F-R03: cached quotes are replicas of shared SAP conditions, not a retail price list.
 * IP-INT3: `opts.taxFacts` (a handheld that asked with `params.handheld`) adds each product's governed tax treatment and
 * rate, taken from the same price condition a store sale is taxed with, so the phone's discount maths agrees with the
 * server. A product with no price, or a price with no tax set-up, carries none (the phone refuses to guess).
 * IP-REFUND: `opts.refunds` (a phone that asked with `params.refunds`) adds the refund reasons, the supervisor amount, the
 * refunds already made on recent sales and its credit-memo number range. Older phones get none of it.
 * @param {any} db @param {any} actor @param {any} device @param {any} r @param {{taxFacts?:boolean, refunds?:boolean}} [opts] */
export async function sellingBundle(db, actor, device, r, opts = {}) {
  const [outlet] = r.outlet_id
    ? await db`select o.*,c.code as account_code from outlets o join outlet_customer_links k on k.outlet_id=o.id and k.deleted_at is null and k.effective_from<=now() and (k.effective_to is null or k.effective_to>now()) join customers c on c.id=k.customer_id and c.active and c.deleted_at is null where o.id=${r.outlet_id} and o.status='active' and o.deleted_at is null`
    : [];
  const balances =
    await db`select b.*,p.id as product_id,p.name,coalesce(b.available_base,0) as available_base,coalesce(b.version,0) as version from products p left join inventory_balances b on p.id=b.product_id and b.location_id=${r.location_id} and b.deleted_at is null where p.active and p.deleted_at is null order by p.name limit 501`;
  if (balances.length > 500)
    refuse("Store catalogue exceeds 500 products; narrow its assortment");
  const catalogue = [];
  for (const b of balances) {
    const p = await productFor(db, b.product_id);
    const codes =
      await db`select b.barcode,u.code from product_barcodes b join units_of_measure u on u.id=b.uom_id where b.product_id=${p.id} and b.active and b.deleted_at is null limit 501`;
    if (codes.length > 500)
      refuse("Too many barcodes; correct the product master");
    const price = outlet
      ? await resolvePrice(db, {
          organizationId: r.organization_id,
          productId: p.id,
          uom: p.base_code,
          channelKey: outlet.channel,
          customerCode: outlet.account_code,
          outletId: r.outlet_id,
          at: Date.now(),
        })
      : null;
    const lots =
      await db`select lot_id,stock_status,physical_base,version from inventory_lot_balances where location_id=${r.location_id} and product_id=${p.id} order by lot_id,stock_status limit 101`;
    if (lots.length > 100)
      refuse("Too many stock-count lots; narrow the count");
    catalogue.push({
      productId: p.id,
      code: p.code,
      name: p.name,
      uomCode: p.base_code,
      quantityScale: String(p.quantityScale),
      barcodes: codes
        .filter((/** @type {any} */ x) => p.factors.has(x.code))
        .map((/** @type {any} */ x) => x.barcode),
      barcodeUnits: codes
        .filter((/** @type {any} */ x) => p.factors.has(x.code))
        .map((/** @type {any} */ x) => ({
          barcode: x.barcode,
          uomCode: x.code,
          baseQuantity: String(p.factors.get(x.code)),
        })),
      availableBase: String(b.available_base),
      version: String(b.version),
      unitPriceMinor:
        price?.unitPriceCentavos == null
          ? null
          : String(price.unitPriceCentavos),
      sourcePriceListId: price?.priceListId ?? null,
      ...(opts.taxFacts && price?.taxTreatment
        ? {
            taxTreatment: price.taxTreatment,
            taxBasisPoints: price.taxBasisPoints ?? 0,
          }
        : {}),
      units: Object.fromEntries(
        [...p.factors].map(([code, value]) => [code, String(value)]),
      ),
      priceFrom: price?.effectiveFrom ?? Date.now(),
      priceTo: price?.effectiveTo ?? null,
      stockLines: lots.length
        ? lots.map((/** @type {any} */ l) => ({
            lotId: l.lot_id,
            stockStatus: l.stock_status,
            quantityBase: String(l.physical_base),
            version: String(l.version),
          }))
        : Number(b.version) === 0
          ? []
          : STATUSES.filter(
              (/** @type {any} */ status) =>
                status === "available" ||
                Number(b[/** @type {any} */ (STATUS_FIELDS)[status]] ?? 0) !==
                  0,
            ).map((/** @type {any} */ status) => ({
              lotId: null,
              stockStatus: status,
              quantityBase: String(
                b[/** @type {any} */ (STATUS_FIELDS)[status]] ?? 0,
              ),
              version: String(b.version),
            })),
    });
  }
  const facts = outlet
    ? await eligibilityFacts(
        { db, actor },
        { outletId: outlet.id, channelKey: outlet.channel },
      )
    : {};
  const offers = (
    await activePromotions(db, r.organization_id, Date.now())
  ).filter(
    (/** @type {any} */ p) =>
      eligibility(p.eligibility ?? {}, facts).eligible &&
      eligibility(p.campaign_scope ?? {}, facts).eligible,
  );
  const supported = offers.every(
    (/** @type {any} */ p) => (p.engine_version ?? 1) === 1,
  );
  const sales =
    await db`select s.id,s.shift_id,s.receipt,s.receipt_number,o.status from store_sales s join store_shifts h on h.id=s.shift_id join orders o on o.id=s.order_id where h.register_id=${r.id} and s.sold_at>=now()-interval '7 days' order by s.sold_at desc limit 501`;
  if (sales.length > 500)
    refuse("Receipt cache exceeds 500 receipts; reconcile the terminal");
  const reads =
    await db`select id,shift_id,kind,sequence::text,snapshot from store_reads where register_id=${r.id} and captured_at>=now()-interval '7 days' order by captured_at desc limit 501`;
  if (reads.length > 500) refuse("Too many recent register reads");
  const transfers =
    await db`select t.id,t.transfer_number as name from stock_transfers t where t.destination_location_id=${r.location_id} and t.status='shipped' order by t.created_at limit 101`;
  const incoming = [];
  for (const t of transfers) {
    const lines =
      await db`select l.id as "lineId",l.product_id as "productId",p.name,l.shipped_base::text as "quantityBase" from stock_transfer_lines l join products p on p.id=l.product_id where l.transfer_id=${t.id} order by p.name`;
    incoming.push({ ...t, lines });
  }
  return {
    catalogue,
    governedPromotions: offers.map((/** @type {any} */ p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      rule: p.rule,
      engine_version: p.engine_version ?? 1,
      price_list_id: p.price_list_id,
      precedence: p.precedence,
      stacking: p.stacking,
      excludes: p.excludes,
      exclusion_group: p.exclusion_group,
      benefit_timing: p.benefit_timing,
      campaign_version_id: p.campaign_version_id,
      effectiveFrom: +new Date(p.effective_from),
      effectiveTo: p.effective_to ? +new Date(p.effective_to) : null,
    })),
    customer: outlet
      ? {
          outletId: outlet.id,
          code: outlet.code,
          name: outlet.name,
          address: outlet.address,
          source: "unplanned",
          sequence: null,
          priceListId: r.id,
          credit: null,
        }
      : null,
    promotions: [],
    promotionsOfflineSupported: supported,
    paymentMethods: (await tenderPolicy(db, r.org_unit_id)).filter(
      (/** @type {any} */ t) => ["cash", "gcash", "card"].includes(t.code),
    ),
    fiscal: await fiscalBundle(
      db,
      actor,
      { org_unit_id: r.org_unit_id, vehicle_id: null },
      device.id,
      undefined,
      { creditMemo: opts.refunds === true },
    ),
    sales,
    ...(opts.refunds === true
      ? {
          refunds: await refundBundle(db, await recentRefunds(db, r.id)),
        }
      : {}),
    reads,
    transfers: incoming,
  };
}

/** Refunds made on this register's recent sales, so the phone can show "already refunded" without a sync of its own.
 * @param {any} db @param {string} registerId */
export async function recentRefunds(db, registerId) {
  const rows =
    await db`select r.id,r.sale_id,r.credit_number,r.total_centavos::text as total,r.tenders,r.refunded_at,r.reason_code,(select coalesce(jsonb_agg(jsonb_build_object('lineIndex',l.line_index,'quantityBase',l.quantity_base::text,'amountCentavos',l.amount_centavos::text) order by l.line_index),'[]'::jsonb) from sale_refund_lines l where l.refund_id=r.id) as lines from sale_refunds r join store_shifts h on h.id=r.shift_id where h.register_id=${registerId} and r.refunded_at>=now()-interval '8 days' order by r.refunded_at desc limit 501`;
  // Newest first; past 500 the phone gets the most recent 500 and `madeComplete:false` (the office still checks every refund).
  const complete = rows.length <= 500;
  return { made: rows.slice(0, 500).map((/** @type {any} */ x) => ({
    id: x.id,
    saleId: x.sale_id,
    creditNumber: x.credit_number,
    totalMinor: x.total,
    reasonCode: x.reason_code,
    tenders: x.tenders,
    lines: x.lines,
    at: +new Date(x.refunded_at),
  })), madeComplete: complete };
}
