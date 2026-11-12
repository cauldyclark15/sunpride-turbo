import { isPlainObject, isUuid } from "../../core/util.js";
import { issueDocument } from "./series.js";

/** Documents the phone prints before the office sees them: point-of-sale invoices and the till's item-refund credit
 * memo (SP-0169 POS-026: one refused credit memo used to block every later one with a series gap). Van collections and
 * van credit memos are issued online and keep their own refusal paths (their tests re-issue the same number). */
const SALE_OPS = new Set(["sale.record", "store.sale", "store.refund.part"]);
/** Cheap check before any transaction: a sale op that carries a fiscal number. @param {any} op */
export const refusedSaleApplies = (op) =>
  SALE_OPS.has(op?.opType) && isPlainObject(op?.payload?.fiscal);
/** Plain words kept on the spoiled document and in the e-journal. @param {string} code */
export const refusedReason = (code) =>
  `Refused by the office (${code}); number recorded as spoiled`;

/**
 * SP-0169: a numbered document (invoice, OR, credit memo) that the office refuses PERMANENTLY was already printed
 * on the handheld. Its number may never be reused and the series may not have a gap, so the refused number is
 * recorded as SPOILED here, in its own transaction after the refused op rolled back. Then the phone's next reserved
 * number is valid again and the trip can keep selling.
 *
 * Only the exact next reserved number of this device's own allocation is spoiled (never a later one: a number above
 * the gap stays refused, so nothing is skipped silently). The spoil is keyed by the refused op's clientOpId, so a
 * re-sent refused op answers with the same spoiled number instead of spoiling another.
 * No supervisor authority is asked: the office itself refused the document; the seller chose nothing.
 * @param {any} db @param {any} actor @param {any} device @param {any} op @param {string} code
 * @returns {Promise<{spoiled:{documentNumber:string,serial:string}}|null>}
 */
export async function spoilRefusedDocument(db, actor, device, op, code) {
  if (!refusedSaleApplies(op)) return null;
  /** @type {any} */
  const f = isPlainObject(op?.payload) ? op.payload.fiscal : null;
  if (
    !isPlainObject(f) ||
    !isUuid(f.allocationId) ||
    !/^[1-9][0-9]{0,17}$/.test(String(f.serial ?? "")) ||
    !isUuid(op.clientOpId)
  )
    return null;
  const answer = (/** @type {any} */ d) => ({
    spoiled: { documentNumber: d.document_number, serial: String(d.serial) },
  });
  const [prior] =
    await db`select document_number,serial from fiscal_documents where source_type='spoiled' and source_id=${op.clientOpId}`;
  if (prior) return answer(prior);
  const [a] =
    await db`select a.*,s.vehicle_id,r.document_type from fiscal_allocations a join fiscal_series s on s.id=a.series_id join fiscal_registrations r on r.id=s.registration_id where a.id=${f.allocationId} for update of a`;
  if (
    !a ||
    a.device_id !== device.id ||
    a.profile_id !== actor.profileId ||
    String(a.next_issue) !== String(f.serial) ||
    BigInt(String(f.serial)) > BigInt(a.last_serial)
  )
    return null;
  const [closed] =
    await db`select 1 from fiscal_allocation_closures where allocation_id=${a.id}`;
  if (closed) return null;
  const reason = refusedReason(code);
  const d = await issueDocument(db, {
    actor,
    deviceId: device.id,
    vehicleId: a.vehicle_id,
    allocationId: a.id,
    serial: String(f.serial),
    documentType: a.document_type,
    sourceType: "spoiled",
    sourceId: op.clientOpId,
    at: Date.now(),
    snapshot: { reason, refusedOpType: op.opType, code },
  });
  await db`insert into fiscal_document_events(document_id,kind,request_key,reason,actor_profile_id) values(${d.id},'spoiled',${crypto.randomUUID()},${reason},${actor.profileId})`;
  return answer(d);
}
