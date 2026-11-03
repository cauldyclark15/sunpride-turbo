import { tx } from "@sunpride/db/client";
import { currentDeviceActor, tripFor, outletFor } from "../van/access.js";
import { damagePhoto } from "../van/media.js";
import { audit as vanAudit } from "../van/facts.js";
import {
  ownedCall,
  advance,
  locationResult,
  integrityBlocked,
} from "../callflow/engine.js";
import { requireCapability } from "../../core/capabilities.js";
import { OpRejected } from "../../core/sync.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { invalid } from "../../core/errors.js";
import { uuid, text, integer, manilaDate } from "../orders/validation.js";
import { writeAudit } from "../org/audit.js";
import { day } from "./service.js";
import { reverseDeliveryBenefits } from "../tpm/returns.js";

/** F-303: a delivery is assigned to an existing trip/person/registered phone, never inferred from a cached customer.
 * @param {any} ctx @param {string} dropId */
export async function driverDrop(ctx, dropId) {
  const { actor, device } = await currentDeviceActor(
    ctx.db,
    ctx.actor,
    ctx.device.id,
  );
  const [d] =
    await ctx.db`select d.*,h.order_id,h.outlet_id,h.org_unit_id,h.snapshot,h.status as handoff_status,r.trip_id,r.status as run_status from delivery_drops d join delivery_handoffs h on h.id=d.handoff_id join delivery_runs r on r.id=d.run_id where d.id=${uuid(dropId)} for update of d`;
  if (!d) throw new OpRejected("out_of_scope");
  const trip = await tripFor(ctx.db, actor, d.trip_id, "van.operate", true);
  const [order] =
    await ctx.db`select status from orders where id=${d.order_id} for share`;
  if (
    actor.profileId !== trip.salesperson_profile_id ||
    (trip.started_device_id && trip.started_device_id !== device.id) ||
    trip.org_unit_id !== d.org_unit_id ||
    !["active", "closing"].includes(trip.status) ||
    d.run_status !== "released" ||
    d.handoff_status !== "acknowledged" ||
    !["approved", "posted"].includes(order?.status)
  )
    throw new OpRejected("out_of_scope");
  await outletFor(ctx.db, actor, d.outlet_id);
  return { drop: d, trip, actor, device };
}
/** Pure F-304 total partition. All quantities are frozen base units, never reinterpreted through today's UOM.
 * @param {any[]} expected @param {any} captured @param {any[]} reasons */
export function validateDeliveryLines(expected, captured, reasons) {
  if (
    !Array.isArray(captured) ||
    captured.length !== expected.length ||
    new Set(captured.map((l) => l.lineId)).size !== expected.length
  )
    throw invalid("Count every delivery line exactly once");
  return expected.map((line) => {
    const l = captured.find((l) => l.lineId === line.id);
    if (!l) throw invalid("A delivery line is missing");
    const accepted = integer(l.acceptedBase, "Accepted pieces", 1e9),
      short = integer(l.shortBase, "Short pieces", 1e9),
      rejected = integer(l.rejectedBase, "Rejected pieces", 1e9),
      damaged = integer(l.damagedBase, "Damaged pieces", 1e9);
    if (accepted + short + rejected + damaged !== Number(line.expected_base))
      throw invalid(
        "Accepted, short, rejected and damaged quantities must equal the allocated line",
      );
    const variance = short + rejected + damaged > 0;
    const reason = variance ? text(l.reason, "Variance reason", 64) : null;
    if (variance && !reasons.some((r) => r.code === reason))
      throw invalid("Choose a reason from the captured delivery policy");
    if (
      l.lotNumber != null &&
      (typeof l.lotNumber !== "string" ||
        !l.lotNumber.trim() ||
        l.lotNumber.length > 100)
    )
      throw invalid("Invalid delivered batch");
    return {
      lineId: line.id,
      acceptedBase: accepted,
      shortBase: short,
      rejectedBase: rejected,
      damagedBase: damaged,
      reason,
      note: l.note == null ? null : text(l.note, "Door note", 500),
      lotNumber: l.lotNumber ?? null,
    };
  });
}
/** The phone's trip.close manifest lists every APPLIED trip operation, so each accepted delivery op owns an
 * operation-keyed audit row. The trip is the one already derived from the drop's released run (driverDrop), never the
 * payload. Written in the op's own transaction, after every check passed: a rejected op rolls back and leaves nothing.
 * @param {any} ctx @param {any} trip @param {any} actor @param {string} kind @param {string} entityId */
async function auditDeliveryOp(ctx, trip, actor, kind, entityId) {
  await vanAudit(ctx.db, trip, actor, kind, entityId, {
    clientOpId: ctx.op.clientOpId,
  });
}
/** F-303 F-304 adapter: immutable proof advances the configured delivery_confirm step in the ONE engine.
 * @param {any} ctx */
export async function recordProof(ctx) {
  const p = ctx.payload,
    { drop, trip, actor, device } = await driverDrop(ctx, p.dropId);
  const fresh = { ...ctx, actor, device };
  const call = await ownedCall(fresh, { clientCallId: uuid(p.clientCallId) });
  if (
    !call ||
    call.trip_id !== trip.id ||
    call.outlet_id !== drop.outlet_id ||
    call.definition_snapshot.channelProfile !== "driver_delivery"
  )
    throw new OpRejected("invalid_transition");
  const at = p.deviceTime;
  // Historical offline capture is allowed within the frozen confirmed delivery day, not today's upload day.
  if (
    !Number.isSafeInteger(at) ||
    at < +new Date(call.started_at) ||
    at > ctx.now + 60000 ||
    manilaDate(at) !== drop.snapshot.confirmedDeliveryDate
  )
    throw new OpRejected("wrong_date");
  if (
    locationResult(
      call.policy_snapshot,
      p.location,
      at,
      integrityBlocked(fresh, p.location),
    ) !== "within_radius"
  )
    throw new OpRejected("evidence_pending_review");
  const hash = sha256Hex(canonicalJson(p));
  const [prior] =
    await ctx.db`select id,payload_hash from delivery_proofs where drop_id=${drop.id}`;
  if (prior) {
    if (prior.payload_hash !== hash)
      throw new OpRejected("idempotency_conflict");
    // Same proof under another op id: no second business effect, but that applied receipt must still be in the manifest.
    await auditDeliveryOp(ctx, trip, actor, "delivery.confirm", prior.id);
    return { entityId: prior.id };
  }
  if (drop.status !== "scheduled") throw new OpRejected("invalid_transition");
  const expected =
    await ctx.db`select * from delivery_drop_lines where drop_id=${drop.id} order by ordinal`;
  const lines = validateDeliveryLines(
    expected,
    p.lines,
    drop.snapshot.policy.variance_reasons,
  );
  const receiver = text(p.receiverName, "Receiver name", 100);
  const signature = p.signature;
  if (
    !Array.isArray(signature) ||
    signature.length < 2 ||
    signature.length > 2048 ||
    signature.some(
      (pt) =>
        !Array.isArray(pt) ||
        pt.length !== 2 ||
        pt.some((n) => !Number.isFinite(n) || n < 0 || n > 1),
    ) ||
    new Set(signature.map((pt) => pt.join(","))).size < 2
  )
    throw invalid("Capture the receiving person’s signature");
  const wm = p.watermark;
  // SEAM(INTEGRITY): native renders these facts into the JPEG BEFORE SHA-256; server binds immutable metadata/digest.
  // This is not a claim of server-side pixel attestation or OS integrity certification.
  if (
    !wm ||
    wm.version !== 1 ||
    wm.outletId !== drop.outlet_id ||
    wm.profileId !== actor.profileId ||
    wm.capturedAt !== at ||
    wm.latitude !== p.location.latitude ||
    wm.longitude !== p.location.longitude
  )
    throw invalid("Capture a watermarked delivery photo at this store");
  const photo = await damagePhoto(
    ctx.db,
    actor,
    device,
    trip,
    p.photoSha256,
    true,
  );
  if (
    (
      await ctx.db`select 1 from call_step_events where adapter='evidence' and entity_id=${photo}`
    ).length
  )
    throw invalid("This photo already belongs to a call");
  const within = manilaDate(at) <= drop.snapshot.confirmedDeliveryDate;
  const [proof] =
    await ctx.db`insert into delivery_proofs(drop_id,call_id,profile_id,device_id,operation_key,photo_id,signature,receiver_name,location,captured_at,watermark,lines,payload_hash,within_sla)
    values(${drop.id},${call.id},${actor.profileId},${device.id},${ctx.op.clientOpId},${photo},${{ values: signature }}::jsonb->'values',${receiver},${p.location},${new Date(at)},${wm},${{ values: lines }}::jsonb->'values',${hash},${within}) returning id`;
  for (const l of lines.filter((l) => l.reason))
    await ctx.db`insert into delivery_variances(proof_id,drop_line_id,accepted_base,short_base,rejected_base,damaged_base,reason,note)
    values(${proof.id},${l.lineId},${l.acceptedBase},${l.shortBase},${l.rejectedBase},${l.damagedBase},${l.reason},${l.note})`;
  await reverseDeliveryBenefits(fresh, drop.order_id, proof.id);
  await advance(fresh, call, "delivery_confirm", proof.id);
  const variance = lines.some(
    (l) => l.shortBase + l.rejectedBase + l.damagedBase > 0,
  );
  await ctx.db`update delivery_drops set status=${variance ? "variance" : "delivered"},updated_at=now() where id=${drop.id}`;
  if (variance)
    await ctx.enqueue({
      kind: "presell.variance",
      key: proof.id,
      payload: { id: proof.id },
    });
  await writeAudit(ctx.db, {
    subject: actor.subject,
    action: "delivery.confirmed",
    entityType: "delivery",
    entityId: proof.id,
    details: { variance },
  });
  await auditDeliveryOp(ctx, trip, actor, "delivery.confirm", proof.id);
  await ctx.change("delivery", drop.id, `unit:${drop.org_unit_id}`);
  ctx.publish("delivery");
  return { entityId: proof.id };
}
/** F-308 actual arrival/unloading/departure facts, captured offline in the existing outbox.
 * @param {any} ctx */
export async function recordTiming(ctx) {
  const p = ctx.payload,
    { drop, trip, actor } = await driverDrop(ctx, p.dropId),
    at = p.deviceTime;
  if (
    !Number.isSafeInteger(at) ||
    at > ctx.now + 60000 ||
    manilaDate(at) !== drop.snapshot.confirmedDeliveryDate
  )
    throw new OpRejected("wrong_date");
  const call = await ownedCall(ctx, { clientCallId: uuid(p.clientCallId) });
  if (
    !call ||
    call.outlet_id !== drop.outlet_id ||
    at < +new Date(call.started_at)
  )
    throw new OpRejected("invalid_transition");
  const violation =
    drop.window_start &&
    (at < +new Date(drop.window_start) || at > +new Date(drop.window_end));
  if (p.stage === "arrival") {
    if (drop.arrived_at) throw new OpRejected("invalid_transition");
    const reason = violation ? text(p.reason, "Outside-window reason") : null;
    await ctx.db`update delivery_drops set arrived_at=${new Date(at)},window_breach_reason=${reason} where id=${drop.id}`;
  } else if (p.stage === "unloading") {
    if (
      !drop.arrived_at ||
      drop.unloading_at ||
      at < +new Date(drop.arrived_at)
    )
      throw new OpRejected("invalid_transition");
    await ctx.db`update delivery_drops set unloading_at=${new Date(at)} where id=${drop.id}`;
  } else if (p.stage === "departure") {
    if (
      !drop.unloading_at ||
      drop.departed_at ||
      at < +new Date(drop.unloading_at) ||
      !["delivered", "variance"].includes(drop.status)
    )
      throw new OpRejected("invalid_transition");
    await ctx.db`update delivery_drops set departed_at=${new Date(at)} where id=${drop.id}`;
  } else throw invalid("Choose arrival, unloading or departure");
  await auditDeliveryOp(ctx, trip, actor, "delivery.timing", drop.id);
  await ctx.change("delivery", drop.id, `unit:${drop.org_unit_id}`);
  ctx.publish("delivery");
  return { entityId: drop.id };
}
/** Additive v2 bundle data only; existing v1 DTOs are unchanged.
 * @param {any} db @param {any} actor @param {any} trip */
export async function deliveryBundle(db, actor, trip) {
  await requireCapability({ db, actor }, "van.operate", trip.org_unit_id);
  const rows =
    await db`select d.*,h.outlet_id,h.snapshot,h.order_id,r.status as run_status from delivery_drops d join delivery_handoffs h on h.id=d.handoff_id join delivery_runs r on r.id=d.run_id join orders o on o.id=h.order_id
    where r.trip_id=${trip.id} and r.status='released' and h.status='acknowledged' and o.status in ('approved','posted') order by d.sequence limit 501`;
  if (rows.length > 500) throw invalid("Delivery run exceeds 500 drops");
  const data = [];
  for (const d of rows) {
    await outletFor(db, actor, d.outlet_id);
    const lines =
      await db`select * from delivery_drop_lines where drop_id=${d.id} order by ordinal`;
    data.push({
      dropId: d.id,
      outletId: d.outlet_id,
      sequence: d.sequence,
      status: d.status,
      orderNumber: d.snapshot.orderNumber,
      confirmedDeliveryDate: d.snapshot.confirmedDeliveryDate,
      windowStart: d.window_start ? +new Date(d.window_start) : null,
      windowEnd: d.window_end ? +new Date(d.window_end) : null,
      bookingReference: d.booking_reference,
      arrivedAt: d.arrived_at ? +new Date(d.arrived_at) : null,
      unloadingAt: d.unloading_at ? +new Date(d.unloading_at) : null,
      departedAt: d.departed_at ? +new Date(d.departed_at) : null,
      reasons: d.snapshot.policy.variance_reasons,
      lines: lines.map((/** @type {any} */ l) => ({
        lineId: l.id,
        productCode: l.product_code,
        description: l.description,
        uom: l.uom,
        quantity: Number(l.ordered_quantity),
        expectedBase: Number(l.expected_base),
      })),
    });
  }
  return data;
}
/** SEAM(SAP): mock compensating request receipt ONLY. Actual stock/credit posting is not fabricated.
 * @param {any} db @param {string} id */
export async function processVariance(db, id) {
  return tx(db, async (t) => {
    await t`update delivery_variances set sap_status='mock_acknowledged' where proof_id=${uuid(id)} and sap_status='pending'`;
  });
}
