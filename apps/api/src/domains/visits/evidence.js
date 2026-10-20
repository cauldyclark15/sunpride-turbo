import { tx } from "@sunpride/db/client";
import { fieldAdapter } from "../callflow/engine.js";
import {
  accessVisit,
  ORGANIZATION,
  ownedVisit,
  reject,
  uuid,
  PHOTO_TYPES,
  validTime,
  ms,
  event,
  changed,
} from "./shared.js";

/** Media claim authorization for visit purposes only. VAN must compose its hook for truck-damage. @param {any} db @param {any} actor @param {any} claim */
export async function canClaimVisitMedia(db, actor, claim) {
  if (claim.purpose !== "visit-photo" || !claim.ownerId) return false;
  try {
    return await tx(db, async (t) => {
      const [device] =
        await t`select * from registered_devices where id=${uuid(claim.deviceId)} for share`;
      if (
        !device ||
        device.status !== "active" ||
        device.profile_id !== actor.profileId ||
        device.bound_subject !== actor.subject ||
        device.org_unit_id !== actor.orgUnitId ||
        !["field-android", "field-ios"].includes(device.app)
      )
        return false;
      const [visit] =
        await t`select * from visit_executions where id=${uuid(claim.ownerId)} for share`;
      await accessVisit({ db: t, actor }, visit, "visit.record", true);
      return ["checked-in", "in-progress", "checked-out"].includes(visit.state);
    });
  } catch {
    return false;
  }
}
/** @param {any} ctx */
export async function attach(ctx) {
  const p = ctx.payload;
  const visit = await ownedVisit(ctx, p.visitId, true);
  if (!["checked-in", "in-progress", "checked-out"].includes(visit.state))
    reject("invalid_transition");
  validTime(p.capturedAt, ctx.now);
  if (
    p.source !== "mobile" ||
    p.mime !== "image/jpeg" ||
    !Number.isSafeInteger(p.size) ||
    p.size < 1 ||
    p.size > 10 * 1024 * 1024 ||
    typeof p.checksum !== "string" ||
    !/^[0-9a-f]{64}$/.test(p.checksum) ||
    !PHOTO_TYPES.some((t) => t.code === p.photoType)
  )
    reject();
  const [blob] =
    await ctx.db`select * from files where id=${uuid(p.blobId)} for update`;
  if (
    !blob ||
    blob.purpose !== "visit-photo" ||
    blob.owner_id !== visit.id ||
    blob.created_by !== ctx.actor.userId ||
    blob.device_id !== ctx.device.id ||
    blob.status !== "stored" ||
    !blob.path ||
    blob.sha256 !== p.checksum ||
    blob.mime !== p.mime ||
    Number(blob.size) !== p.size ||
    !blob.stored_at
  )
    reject("evidence_pending_review");
  const [prior] =
    await ctx.db`select * from field_evidence_files where visit_id=${visit.id} and owner_profile_id=${ctx.actor.profileId} and checksum=${p.checksum}`;
  if (prior) {
    if (
      prior.storage_id !== blob.id ||
      prior.mime !== p.mime ||
      Number(prior.size_bytes) !== p.size ||
      ms(prior.captured_at) !== p.capturedAt ||
      prior.photo_type !== p.photoType
    )
      reject("idempotency_conflict");
    return { entityId: prior.id, eventIds: [] };
  }
  const [{ n }] =
    await ctx.db`select count(*)::int as n from field_evidence_files where visit_id=${visit.id}`;
  if (n >= 500) reject();
  const consumed =
    await ctx.db`select 1 from evidence_upload_claims where storage_id=${blob.id}`;
  if (consumed.length) reject("idempotency_conflict");
  // Platform files is the issued claim: subject/device/owner/digest are persisted before PUT.
  // Upload capability expiry gates PUT; offline metadata can arrive later without losing evidence.
  await ctx.db`insert into evidence_upload_claims (organization_id,visit_id,profile_id,device_id,subject,issued_at,expires_at,consumed_at,storage_id)
    values (${ORGANIZATION},${visit.id},${ctx.actor.profileId},${ctx.device.id},${ctx.actor.subject},${blob.created_at},${blob.upload_expires_at},${new Date(ctx.now)},${blob.id})`;
  const [row] =
    await ctx.db`insert into field_evidence_files (organization_id,org_unit_id,storage_id,visit_id,owner_profile_id,outlet_id,mime,size_bytes,checksum,captured_at,photo_type,uploaded_at,status)
    values (${ORGANIZATION},${visit.org_unit_id},${blob.id},${visit.id},${ctx.actor.profileId},${visit.outlet_id},${p.mime},${p.size},${p.checksum},${new Date(p.capturedAt)},${p.photoType},${new Date(ctx.now)},'pending') returning id`;
  await fieldAdapter(ctx, visit.id, "photo", row.id);
  const eventId = await event(
    ctx,
    visit,
    "visit",
    visit.id,
    "evidence.attached",
    { after: "pending" },
  );
  await ctx.change("evidence", row.id, visit.org_unit_id);
  await changed(ctx, visit);
  return { entityId: row.id, eventIds: [eventId] };
}
