import {
  issueDocument,
  allocateDocumentNumber,
  allocationDto,
  issuanceGate,
} from "./series.js";
import { integer, refuse, safeNumber } from "../van/model.js";
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
    await db`select r.*,a.registration_snapshot from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id where a.id=${p.fiscal.allocationId}`;
  if (!r || r.org_unit_id !== trip.org_unit_id)
    refuse("Fiscal range belongs to another branch");
  const document = await issueDocument(db, {
    actor,
    deviceId,
    vehicleId: trip.vehicle_id,
    ...p.fiscal,
    documentType: "sales_invoice",
    sourceType: "van_sale",
    sourceId: p.saleId,
    at: p.deviceTime,
    snapshot: {
      ...receipt,
      tax: taxSnapshot(
        receipt.totalMinor,
        r.registration_snapshot?.taxBasisPoints,
      ),
    },
  });
  await enqueueSapPosting(db, document);
  return document;
}
/** F-019 bootstrap carries already reserved ranges. Repeat download never resets the phone counter.
 * @param {any} db @param {any} actor @param {any} trip @param {string} deviceId */
export async function fiscalBundle(db, actor, trip, deviceId) {
  const candidates =
    await db`select s.*,r.document_type from fiscal_series s join fiscal_registrations r on r.id=s.registration_id
    where r.org_unit_id=${trip.org_unit_id} and (s.vehicle_id is null or s.vehicle_id=${trip.vehicle_id}) and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now())
    and r.document_type in ('sales_invoice','official_receipt') order by s.prefix limit 101`;
  if (candidates.length > 100)
    refuse("Too many active document series; narrow the branch");
  const ranges = [];
  for (const type of ["sales_invoice", "official_receipt"]) {
    const matches = candidates.filter(
      (/** @type {any} */ s) => s.document_type === type,
    );
    if (matches.length !== 1) continue;
    const s = matches[0];
    const [r] =
      await db`select * from fiscal_registrations where id=${s.registration_id}`;
    try {
      await issuanceGate(db, r, deviceId, Date.now());
    } catch {
      continue;
    }
    const open =
      await db`select * from fiscal_allocations where series_id=${s.id} and device_id=${deviceId} and profile_id=${actor.profileId} and next_issue<=last_serial order by first_serial limit 2`;
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
  return { required: true, ranges };
}
