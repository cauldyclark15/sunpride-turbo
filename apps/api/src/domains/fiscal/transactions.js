import {
  issueDocument,
  allocateDocumentNumber,
  allocationDto,
  issuanceGate,
} from "./series.js";
import { integer, refuse, safeNumber, uuid } from "../van/model.js";
import { authorityContext } from "./authority.js";
import { roleHas } from "../../core/capabilities.js";
import { invoiceTaxSnapshot } from "./taxes.js";
import { canonicalJson } from "../../core/util.js";
import { buildTaxSnapshot } from "./legal-sale.js";
/** F-108/F-109: inclusive VAT, exact half-up centavos; the frozen registration owns the rate.
 * @param {string} total @param {number} bps */
export function taxSnapshot(total, bps) {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000)
    refuse("Tax treatment needs setup");
  const amount = integer(total),
    net = (amount * 10000n + BigInt(10000 + bps) / 2n) / BigInt(10000 + bps);
  return {
    inclusive: true,
    rateBasisPoints: bps,
    vatableSalesMinor: String(bps ? net : 0n),
    vatMinor: String(bps ? amount - net : 0n),
    vatExemptMinor: String(bps ? 0n : amount),
    zeroRatedMinor: "0",
    totalMinor: total,
  };
}
/** SEAM(SAP): integration/enqueueSapPosting must consume this owned durable outbox at integration.
 * No SAP acknowledgement or posted status is invented here. @param {any} db @param {any} document */
export async function enqueueSapPosting(db, document) {
  const key = `fiscal:${document.id}`;
  await db`insert into fiscal_posting_requests(document_id,effect_key,payload) values(${document.id},${key},${{ effectKey: key, documentId: document.id, documentNumber: document.document_number, kind: document.snapshot.documentType, snapshot: document.snapshot }}) on conflict(document_id) do nothing`;
  return { effectKey: key, status: "pending_sap_seam" };
}
/** F-108 one controlled SI per canonical sale. @param {any} db @param {any} actor @param {any} trip @param {any} p @param {any} receipt @param {string} deviceId */
export async function invoiceForSale(db, actor, trip, p, receipt, deviceId) {
  if (!p.fiscal)
    refuse("Download an authorized Sales Invoice range before selling");
  const [r] =
    await db`select r.*,a.registration_snapshot from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id where a.id=${uuid(p.fiscal.allocationId)}`;
  if (!r || r.org_unit_id !== trip.org_unit_id)
    refuse("Fiscal range belongs to another branch");
  /** @type {any} */
  let tax;
  if (receipt.discountClaim) {
    // IP-BIR: a statutory discount keeps its own amounts; the server tax is authoritative (a phone tax blob is not compared).
    tax = vanClaimTax(receipt);
  } else tax = invoiceTaxSnapshot(receipt.lines, receipt.totalMinor);
  if (receipt.discountClaim) {
    // tax already computed from the recomputed per-line privilege results
  } else if (p.fiscal.tax) {
    if (canonicalJson(p.fiscal.tax) !== canonicalJson(tax))
      refuse(
        "Selling tax changed; keep the invoice for office review rather than rewriting its printed facts",
      );
  } else {
    const rate = r.registration_snapshot?.taxBasisPoints;
    if (
      !receipt.lines.every(
        (/** @type {any} */ l) =>
          l.taxTreatment === "vatable" &&
          l.taxBasisPoints === rate &&
          l.sourceTaxInclusive === true,
      )
    )
      refuse("Update the handheld before issuing this tax treatment");
    tax = taxSnapshot(receipt.totalMinor, rate);
  }
  const document = await issueDocument(db, {
    actor,
    deviceId,
    vehicleId: trip.vehicle_id,
    // The wire chooses only a reserved number, never the authenticated issuer.
    allocationId: p.fiscal.allocationId,
    serial: p.fiscal.serial,
    documentType: "sales_invoice",
    sourceType: "van_sale",
    sourceId: p.saleId,
    at: p.deviceTime,
    snapshot: {
      ...receipt,
      tax,
    },
  });
  await enqueueSapPosting(db, document);
  return document;
}
/** NF-2. Which active series of `type` a handheld numbers from. Several may apply to one branch (a van's own
 * series, a store's branch-level series, a register's machine registration). BIR numbering is per registered
 * machine / per van, so the most specific one wins: a registration bound to THIS register, then the van's series,
 * then the branch's. A series registered to another register never applies. Two at the same winning level is an
 * office setup error and is refused loudly, never silently left without a range.
 * @param {any[]} candidates @param {string} type @param {string} deviceId */
export function mostSpecificSeries(candidates, type, deviceId) {
  const level = (/** @type {any} */ s) =>
    s.registration_device_id ? 3 : s.vehicle_id ? 2 : 1;
  const usable = candidates.filter(
    (s) =>
      s.document_type === type &&
      (!s.registration_device_id || s.registration_device_id === deviceId),
  );
  if (!usable.length) return null;
  const top = Math.max(...usable.map(level));
  const winners = usable.filter((s) => level(s) === top);
  if (winners.length > 1)
    refuse(
      `Fiscal setup needs the office: ${winners.length} active ${type.replace("_", " ")} series apply to this handheld at the same level (${winners
        .map((s) => s.prefix)
        .join(", ")}). End all but one in Fiscal setup, or bind one to this van or register.`,
    );
  return winners[0];
}
/** F-019 bootstrap carries already reserved ranges. Repeat download never resets the phone counter.
 * IP-REFUND: `opts.creditMemo` (a phone that asked with `params.refunds`) also gets its credit-memo range; phones that
 * keep at most two ranges never see a third.
 * @param {any} db @param {any} actor @param {any} trip @param {string} deviceId @param {Record<string,string|undefined>} [env] @param {{creditMemo?:boolean}} [opts] */
export async function fiscalBundle(db, actor, trip, deviceId, env, opts = {}) {
  const types = [
    "sales_invoice",
    "official_receipt",
    ...(opts.creditMemo ? ["credit_memo"] : []),
  ];
  const candidates =
    await db`select s.*,r.document_type,r.device_id as registration_device_id from fiscal_series s join fiscal_registrations r on r.id=s.registration_id
    where r.org_unit_id=${trip.org_unit_id} and (s.vehicle_id is null or s.vehicle_id=${trip.vehicle_id}) and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now())
    and r.effective_from<=now() and (r.effective_to is null or r.effective_to>now())
    and (s.next_allocate<=s.last_serial or exists(select 1 from fiscal_allocations a where a.series_id=s.id and a.device_id=${deviceId} and a.next_issue<=a.last_serial))
    and r.document_type in ${db(types)} order by s.prefix limit 101`;
  if (candidates.length > 100)
    refuse("Too many active document series; narrow the branch");
  const ranges = [];
  for (const type of types) {
    const s = mostSpecificSeries(candidates, type, deviceId);
    if (!s) continue;
    const [r] =
      await db`select * from fiscal_registrations where id=${s.registration_id}`;
    try {
      await issuanceGate(db, r, deviceId, Date.now());
    } catch {
      continue;
    }
    const open =
      await db`select * from fiscal_allocations where series_id=${s.id} and device_id=${deviceId} and profile_id=${actor.profileId} and next_issue<=last_serial and not exists(select 1 from fiscal_allocation_closures c where c.allocation_id=fiscal_allocations.id) order by first_serial limit 2`;
    if (open.length > 1)
      refuse("Multiple unclosed ranges require reconciliation");
    if (open[0]) ranges.push(allocationDto(open[0], s, r));
    else if (BigInt(s.next_allocate) <= BigInt(s.last_serial))
      ranges.push(
        await allocateDocumentNumber(db, {
          actor,
          deviceId,
          seriesId: s.id,
          requestKey: crypto.randomUUID(),
          count: Math.min(
            100,
            safeNumber(BigInt(s.last_serial) - BigInt(s.next_allocate) + 1n),
          ),
        }),
      );
  }
  return {
    required: true,
    ranges,
    ...(env &&
    (roleHas(actor.role, "order.create") || roleHas(actor.role, "order.encode"))
      ? { authority: await authorityContext(db, actor, trip.org_unit_id, env) }
      : {}),
  };
}

/** IP-BIR: tax snapshot of a van sale that carries a discount claim (lines hold their recomputed `legal` results).
 * @param {any} receipt */
function vanClaimTax(receipt) {
  const taxLines = [],
    results = [];
  for (const l of receipt.lines) {
    if (BigInt(l.grossMinor) === 0n) continue;
    taxLines.push({
      totalMinor: l.totalMinor,
      grossMinor: l.grossMinor,
      promoDiscountMinor: l.discountMinor,
      taxBasisPoints: l.taxBasisPoints,
      taxTreatment: l.taxTreatment,
      taxCode: l.taxCode,
      sourceTaxInclusive: l.sourceTaxInclusive,
      sourceSellingUnitMinor: l.sourceSellingUnitMinor,
      sourceNetUnitMinor: l.sourceNetUnitMinor,
      sapConditionKey: l.sapConditionKey,
      sapConditionVersion: l.sapConditionVersion,
    });
    results.push(l.legal);
  }
  return buildTaxSnapshot(taxLines, {
    results,
    claim: receipt.discountClaim,
    totalMinor: receipt.totalMinor,
  });
}
