import { quote } from "../orders/service.js";
import { decimalMoney } from "../orders/validation.js";
import { evaluateSchemes } from "../tpm/engine.js";
import { postMovement } from "../inventory/posting.js";
import { issueDocument } from "../fiscal/series.js";
import { enqueueSapPosting } from "../fiscal/transactions.js";
import {
  prepareLegalSale,
  buildTaxSnapshot,
  resolveBuyer,
  recordClaim,
  privilegeLabel,
} from "../fiscal/legal-sale.js";
import { configuredTender } from "../fiscal/tenders.js";
import { canonicalJson } from "../../core/util.js";
import { integer, uuid, refuse, today, text } from "../van/model.js";
import { verifyDiscountProof } from "./security.js";

/** F-R03 SEAM(ORDERS): one canonical order/line fact, shared quote/TPM, stock writer and fiscal series.
 * Store context replaces a trip; never insert synthetic vehicle/trip rows. @param {any} c */
export async function recordSale(c) {
  const { db, actor, device, register: r, shift, policy, payload: p } = c;
  const id = uuid(p.saleId);
  const [old] = await db`select * from store_sales where id=${id}`;
  if (old) {
    if (
      old.shift_id !== shift.id ||
      canonicalJson(old.captured_request) !== canonicalJson(p)
    )
      refuse("Sale identifier has different content", "idempotency_conflict");
    return { entityId: id, movementId: old.movement_id };
  }
  if (!r.outlet_id)
    refuse("Link this register to its commercial store in POS setup");
  const [outlet] =
    await db`select o.*,c.code as account_code from outlets o join outlet_customer_links k on k.outlet_id=o.id and k.deleted_at is null and k.effective_from<=now() and (k.effective_to is null or k.effective_to>now()) join customers c on c.id=k.customer_id and c.active and c.deleted_at is null where o.id=${r.outlet_id} and o.deleted_at is null and o.status='active'`;
  if (!outlet) refuse("Store accounting link needs office setup");
  let priced = await quote(
    { ...c, now: p.deviceTime },
    {
      lines: p.lines,
      at: p.deviceTime,
      customerCode: outlet.account_code,
      outletId: r.outlet_id,
      channelKey: outlet.channel,
    },
  );
  if (priced.totalCentavos === null)
    refuse("All items need a governed SAP price");
  const [customer] = p.customerPhone
    ? await db`select * from store_customers where phone=${phone(p.customerPhone)} for update`
    : [];
  const points = integer(p.redeemPoints ?? "0");
  let extra = 0;
  if (p.employeeDiscount === true) {
    verifyDiscountProof(policy, p);
    extra = Number(
      (BigInt(priced.totalCentavos) * BigInt(policy.employee_discount_bps)) /
        10000n,
    );
  }
  if (points > 0n) {
    if (!policy.loyalty_enabled || !customer)
      refuse("Loyalty is not enabled for this customer");
    const [balance] =
      await db`select coalesce(sum(delta),0)::text as n from store_points where customer_id=${customer.id}`;
    if (points > BigInt(balance.n))
      refuse("Not enough points; reconnect to refresh the balance");
    extra += Number(points * BigInt(policy.point_value_centavos));
  }
  if (extra > priced.totalCentavos)
    refuse("Discount and points exceed the basket");
  if (extra) {
    const benefit = evaluateSchemes(priced.lines, [
      {
        id: policy.id,
        code: "store-controlled-benefit",
        rule: { kind: "basket", minSubtotalCentavos: 0, valueCentavos: extra },
        stacking: "exclusive",
        benefit_timing: "on_invoice",
      },
    ]);
    priced = {
      ...priced,
      totalCentavos: benefit.totalCentavos,
      lines: priced.lines.map((/** @type {any} */ l, /** @type {any} */ i) => ({
        ...l,
        lineTotalCentavos: l.lineTotalCentavos - benefit.lineDiscounts[i],
        discountCentavos: l.discountCentavos + benefit.lineDiscounts[i],
      })),
    };
  }
  if (priced.totalCentavos === null)
    refuse("Shared promotion could not price this basket");
  // IP-BIR: statutory discount claim (SC / PWD / ...). The server recomputes per line and refuses a mismatch.
  const legalLines = priced.lines.map((/** @type {any} */ l) => ({
    productId: l.productId,
    description: l.description,
    grossCentavos: l.lineTotalCentavos + l.discountCentavos,
    promoDiscountCentavos: l.discountCentavos,
    taxTreatment: l.taxTreatment ?? null,
    taxBasisPoints: l.taxBasisPoints ?? null,
  }));
  const legal = await prepareLegalSale(db, {
    surface: "store",
    orgUnitId: r.org_unit_id,
    payload: p,
    at: p.deviceTime,
    lines: legalLines,
  });
  if (legal.claim) {
    legal.assertMatches({
      totalCentavos: p.totalCentavos,
      privilegeDiscountCentavos: p.discountClaim?.privilegeDiscountCentavos,
      vatRemovedCentavos: p.discountClaim?.vatRemovedCentavos,
    });
    priced = {
      ...priced,
      totalCentavos: legal.totals.total,
      lines: priced.lines.map(
        (/** @type {any} */ l, /** @type {number} */ i) => ({
          ...l,
          lineTotalCentavos: legal.results[i].netCentavos,
          discountCentavos:
            legalLines[i].grossCentavos - legal.results[i].netCentavos,
          privilegeType: legal.results[i].privilegeType,
          privilegeDiscountCentavos: legal.results[i].privilegeDiscountCentavos,
          vatRemovedCentavos: legal.results[i].vatRemovedCentavos,
        }),
      ),
    };
  }
  const total = BigInt(/** @type {number} */ (priced.totalCentavos));
  if (integer(p.totalCentavos) !== total)
    refuse(
      "Basket changed; review the shared price or promotion",
      "stock_conflict",
    );
  if (
    !Array.isArray(p.tenders) ||
    (total > 0n && !p.tenders.length) ||
    p.tenders.length > 3
  )
    refuse("Choose cash, e-wallet, card or a split of them");
  let paid = 0n;
  const methods = new Set();
  const tenders = [];
  for (const t of p.tenders) {
    const rule = await configuredTender(db, r.org_unit_id, t, p.deviceTime);
    if (!["cash", "gcash", "card"].includes(t.method) || methods.has(t.method))
      refuse("Choose each store tender once");
    methods.add(t.method);
    const amount = integer(t.amountCentavos, true);
    paid += amount;
    if (
      t.method === "cash" &&
      integer(t.tenderedCentavos ?? t.amountCentavos) < amount
    )
      refuse("Cash received is short");
    tenders.push({
      method: t.method,
      label: rule.label,
      amountCentavos: String(amount),
      reference: rule.referenceRequired ? text(t.reference, 100, true) : null,
      tenderedCentavos:
        t.method === "cash"
          ? String(integer(t.tenderedCentavos ?? t.amountCentavos))
          : null,
      changeCentavos:
        t.method === "cash"
          ? String(integer(t.tenderedCentavos ?? t.amountCentavos) - amount)
          : "0",
      status: rule.referenceRequired ? "awaiting_confirmation" : "recorded",
    });
  }
  if (paid !== total) refuse("Split tenders must equal the basket total");
  const movement = await postMovement(db, {
    kind: "pos_sale",
    sourceType: "store_sale",
    sourceId: id,
    idempotencyKey: `store-sale:${id}`,
    occurredAt: p.deviceTime,
    actor: { userId: actor.userId, profileId: actor.profileId },
    organizationId: r.organization_id,
    authorizedLocations: [r.location_id],
    lines: priced.lines.map((/** @type {any} */ l) => ({
      productId: l.productId,
      fromLocationId: r.location_id,
      toLocationId: null,
      quantityBase: l.quantityBase,
      uom: l.uom,
    })),
  });
  const buyer = await resolveBuyer(db, {
    outletId: r.outlet_id,
    override: legal.buyerOverride,
    fallbackName: outlet.name,
    fallbackAddress: outlet.address,
  });
  const receipt = {
    saleId: id,
    store: r.store_name,
    register: r.name,
    terminal: r.terminal_code,
    cashier: actor.name,
    customer: customer?.name ?? "Walk-in",
    soldAt: p.deviceTime,
    lines: priced.lines,
    tenders,
    totalMinor: String(total),
    currency: "PHP",
    employeeDiscount: p.employeeDiscount === true,
    pointsRedeemed: String(points),
    buyer,
    ...(legal.claim
      ? {
          discountClaim: {
            type: legal.claim.type,
            label: privilegeLabel(legal.claim.type),
            idNumber: legal.claim.idNumber,
            holderName: legal.claim.holderName,
            applied: legal.totals.applied,
          },
        }
      : {}),
  };
  const tax = storeTax(priced.lines, legalLines, legal, String(total));
  const [registration] =
    await db`select a.registration_snapshot as snapshot,r.org_unit_id from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id where a.id=${uuid(p.fiscal?.allocationId)}`;
  if (registration?.org_unit_id !== r.org_unit_id)
    refuse("Invoice range belongs to another branch");
  const document = await issueDocument(db, {
    actor,
    deviceId: device.id,
    vehicleId: null,
    allocationId: p.fiscal.allocationId,
    serial: p.fiscal.serial,
    documentType: "sales_invoice",
    sourceType: "store_sale",
    sourceId: id,
    at: p.deviceTime,
    snapshot: {
      ...receipt,
      tax,
    },
  });
  if (document.document_number !== p.receiptNumber)
    refuse("Receipt number differs from its fiscal allocation");
  const frozen = {
    ...receipt,
    receiptNumber: document.document_number,
    fiscal: document.snapshot.registration,
    tax: document.snapshot.tax,
  };
  await canonicalOrder(c, {
    id,
    number: document.document_number,
    customerCode: outlet.account_code,
    outletId: r.outlet_id,
    channel: outlet.channel,
    total: Number(total),
    lines: priced.lines,
    movementId: movement.movementId,
    pricing: priced,
  });
  await db`insert into store_sales(id,shift_id,order_id,device_id,receipt_number,fiscal_document_id,movement_id,captured_request,receipt,sold_at) values(${id},${shift.id},${id},${device.id},${document.document_number},${document.id},${movement.movementId},${p},${frozen},${new Date(p.deviceTime)})`;
  for (const t of tenders)
    await db`insert into store_tenders(shift_id,sale_id,operation_id,method,reference,amount_centavos,label,status) values(${shift.id},${id},${c.op.clientOpId},${t.method},${t.reference},${t.amountCentavos},${t.label},${t.status})`;
  if (policy.loyalty_enabled && customer) {
    const earn = BigInt(total) / BigInt(policy.earn_per_centavos);
    if (earn)
      await db`insert into store_points(customer_id,sale_id,delta,kind) values(${customer.id},${id},${String(earn)},'earn')`;
    if (points)
      await db`insert into store_points(customer_id,sale_id,delta,kind) values(${customer.id},${id},${String(-points)},'redeem')`;
  }
  await recordClaim(db, {
    sourceType: "store_sale",
    sourceId: id,
    orgUnitId: r.org_unit_id,
    legal,
    claimed: p.discountClaim ?? {},
    actorProfileId: actor.profileId,
    documentId: document.id,
  });
  await enqueueSapPosting(db, document);
  return { entityId: id, movementId: movement.movementId };
}
/** IP-BIR: tax is split PER LINE from each product's governed treatment (never one whole-basket rate).
 * Zero-value free-goods lines carry no tax. @param {any[]} lines @param {any[]} legalLines @param {any} legal @param {string} totalMinor */
export function storeTax(lines, legalLines, legal, totalMinor) {
  /** @type {any[]} */ const taxLines = [],
    /** @type {any[]} */ results = [];
  lines.forEach((/** @type {any} */ l, /** @type {number} */ i) => {
    const gross = legalLines[i].grossCentavos;
    if (gross === 0) return;
    if (!l.taxTreatment || typeof l.taxCode !== "string")
      refuse(
        `${l.description} has no tax set-up. Ask the office to finish its price and tax set-up before selling it.`,
        "tax_setup_missing",
      );
    taxLines.push({
      totalMinor: String(l.lineTotalCentavos),
      grossMinor: String(gross),
      promoDiscountMinor: String(legalLines[i].promoDiscountCentavos),
      taxBasisPoints: l.taxBasisPoints,
      taxTreatment: l.taxTreatment,
      taxCode: l.taxCode,
      sourceTaxInclusive: l.sourceTaxInclusive,
      sourceSellingUnitMinor: String(l.unitPriceCentavos ?? 0),
      sourceNetUnitMinor: String(
        l.sourceUnitPriceCentavos ?? l.unitPriceCentavos ?? 0,
      ),
      sapConditionKey: l.sapKey ?? null,
      sapConditionVersion: l.sapVersion ?? null,
    });
    results.push(legal.results?.[i] ?? null);
  });
  return buildTaxSnapshot(taxLines, {
    results: legal.claim ? results : null,
    claim: legal.claim,
    totalMinor,
  });
}
/** F-R03: canonical analytics sees exactly the same net, source and frozen line amounts. @param {any} c @param {any} v */
export async function canonicalOrder(c, v) {
  const { db, actor, register: r, payload: p } = c;
  const signedMoney = (/** @type {number} */ n) =>
    `${n < 0 ? "-" : ""}${decimalMoney(Math.abs(n))}`;
  await db`insert into orders(id,organization_id,client_request_id,order_number,order_type,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,channel_key,service_date,status,subtotal,total,subtotal_centavos,total_centavos,amount_known,pricing_snapshot,source_location_id,offline_created_at,inventory_movement_id,original_order_id)
 values(${v.id},${r.organization_id},${v.id},${v.number},${v.originalId ? "return" : "store_pos"},${v.customerCode},${v.salespersonSubject ?? actor.subject},${v.salespersonId ?? actor.profileId},${actor.subject},${r.org_unit_id},${v.outletId},${v.channel},${today(p.deviceTime)},'fulfilled',${signedMoney(v.total)},${signedMoney(v.total)},${v.total},${v.total},true,${v.pricing ?? {}},${r.location_id},${new Date(p.deviceTime)},${v.movementId},${v.originalId ?? null})`;
  for (const [i, l] of v.lines.entries())
    await db`insert into order_lines(order_id,ordinal,product_id,product_code,description,uom,quantity,quantity_base,unit_price,line_total,unit_price_centavos,line_total_centavos,price_list_id) values(${v.id},${i},${l.productId},${l.productCode},${l.description},${l.uom},${l.quantity},${l.quantityBase},${decimalMoney(l.unitPriceCentavos ?? 0)},${signedMoney(l.lineTotalCentavos)},${l.unitPriceCentavos},${l.lineTotalCentavos},${l.priceListId ?? null})`;
}
/** F-R07 normalized exact phone lookup; never fuzzy-match another person's account. @param {any} v */
export function phone(v) {
  const n = text(v, 24, true)?.replace(/[ ()+-]/g, "");
  if (!n || !/^\d{7,15}$/.test(n)) refuse("Enter a valid customer phone");
  return n;
}
