import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { requireCapability } from "../../core/capabilities.js";
import { filesDir } from "../../core/media.js";
import { reauthorizeDevice } from "../../core/devices.js";
import { currentActor } from "../van/access.js";
import { validateCensusJpeg } from "./photo.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { OpRejected } from "../../core/sync.js";
import { ApiError } from "../../core/errors.js";
import { required, uuid, integer, rule } from "../org/model.js";
import { scopeFilterForActor, subtree, outletOwnerUnit } from "../org/scope.js";
import { definitionsAt, reference, masterDto } from "./definitions.js";
import { placeDetails, PlacesUnavailable, placesConfigured } from "./places.js";
import {
  distanceMeters,
  findDuplicates,
  candidatesInScope,
} from "./duplicates.js";
import { MAX_ATTEMPTS, enqueue } from "../../core/jobs.js";
import { allocate, enrolmentCommand } from "../org/outlets.js";

const FIELD_APPS = ["field-android", "field-ios"];
const COMPONENT_KEYS = [
  "street",
  "barangay",
  "city",
  "province",
  "region",
  "postalCode",
];
/** Ongoing per-unit batch used when a capture names no batch (SP-0162).
 * Looked up by the is_default flag (unique per unit), never by code. Created on first use;
 * idempotent under concurrency via the unique default index. The code is only a label:
 * when `ONGOING-<unit code>` is already taken by another batch (an office round, or two
 * unit codes equal after truncation) it falls back to a unit-id suffix, then a random one,
 * so a capture is never permanently refused for a code collision.
 * @param {any} db @param {string} unitId */
export async function defaultBatch(db, unitId) {
  const find = async () =>
    (
      await db`select * from census_batches where org_unit_id=${unitId} and is_default`
    )[0] ?? null;
  const found = await find();
  if (found) return found;
  const [unit] = await db`select code from org_units where id=${unitId}`;
  if (!unit) return null;
  const base = `ONGOING-${unit.code}`.slice(0, 31);
  for (const code of [
    `ONGOING-${unit.code}`.slice(0, 40),
    `${base}-${unitId.replace(/-/g, "").slice(0, 8)}`,
    `${base}-${crypto.randomUUID().slice(0, 8)}`,
  ]) {
    await db`insert into census_batches(code,name,org_unit_id,expected_outlets,effective_from,is_default) values(${code},'Ongoing store gathering',${unitId},1000,${new Date("2000-01-01T00:00:00Z")},true) on conflict do nothing`;
    const made = await find();
    if (made) return made;
  }
  return null;
}
/** @param {any} v @param {string} label @param {number} max */
function optionalText(v, label, max) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008]/.test(v))
    rule(`${label} is too long or not valid.`);
  return v.trim() || null;
}
/** @param {any} v */
function readComponents(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v))
    rule("Address parts are not valid.");
  /** @type {Record<string,string|null>} */ const out = {};
  for (const [k, value] of Object.entries(v)) {
    if (!COMPONENT_KEYS.includes(k)) rule("Address parts are not valid.");
    out[k] = optionalText(value, "Address part", 120);
  }
  return out;
}
/** @param {any} v */
function readAcknowledged(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 10)
    rule("Too many stores marked as different.");
  return [...new Set(v.map((/** @type {any} */ id) => uuid(id)))];
}

/** Location of a capture: a fresh non-mock GPS fix (default) or a searched Google place.
 * @param {any} p @param {number} at */
function readLocation(p, at) {
  const source = p.locationSource ?? "gps";
  if (!["gps", "places"].includes(source))
    rule("Choose how the location was set.");
  const l = p.location;
  const point =
    l &&
    Number.isFinite(l.latitude) &&
    Math.abs(l.latitude) <= 90 &&
    Number.isFinite(l.longitude) &&
    Math.abs(l.longitude) <= 180;
  /** @type {string|null} */ let placeId = null;
  if (source === "gps") {
    if (
      !point ||
      !Number.isFinite(l.accuracyMeters) ||
      l.accuracyMeters <= 0 ||
      l.accuracyMeters >= 50 ||
      l.mockSignal !== false ||
      typeof l.provider !== "string" ||
      !l.provider.trim() ||
      l.provider.length > 80 ||
      /[\u0000-\u001f]/.test(l.provider) ||
      !Number.isSafeInteger(l.fixTime) ||
      Math.abs(at - l.fixTime) > 120000
    )
      rule("Census needs a fresh, non-mock GPS fix with accuracy under 50 m.");
  } else {
    placeId = required(p.placeId, "Address search place", 300);
    if (!point) rule("Choose an address from the search list.");
  }
  return { source, placeId, l };
}
/** @param {any} encodedValue */
function readJpeg(encodedValue) {
  const encoded = required(encodedValue, "Storefront photo", 220000);
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length < 4 ||
    bytes.length > 160 * 1024 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217
  )
    rule("Take a storefront JPEG photo up to 160 KiB.");
  validateCensusJpeg(bytes);
  return bytes;
}
/** @param {any} ctx @param {string} id @param {Buffer} bytes @param {any} actor */
async function storeJpeg(ctx, id, bytes, actor) {
  const digest = sha256Hex(bytes),
    relative = `${digest.slice(0, 2)}/${digest}`;
  const folder = join(filesDir(ctx.env), digest.slice(0, 2));
  await mkdir(folder, { recursive: true });
  const temp = join(folder, `${digest}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temp, bytes);
    await rename(temp, join(filesDir(ctx.env), relative));
  } finally {
    await rm(temp, { force: true });
  }
  const [file] =
    await ctx.db`insert into files(owner_id,purpose,sha256,mime,size,path,status,device_id,created_by) values(${id},'census-storefront',${digest},'image/jpeg',${bytes.length},${relative},'stored',${ctx.device.id},${actor.userId}) on conflict(created_by,purpose,owner_id,sha256) do update set status='stored' returning id`;
  return file;
}
/** The store as the office knows it now: the old side of an Edit store change.
 * @param {any} db @param {string} outletId */
export async function storeSnapshot(db, outletId) {
  const [row] = await db`select o.name,o.address,o.directions landmark,
    c.name owner_name,c.phone owner_phone,p.latitude,p.longitude,
    (select f.file_id from outlet_photos f where f.outlet_id=o.id and f.deleted_at is null order by f.ordinal limit 1) photo_file_id
    from outlets o
    left join lateral (select name,phone from outlet_contacts where outlet_id=o.id and deleted_at is null order by ordinal limit 1) c on true
    left join lateral (select latitude,longitude from outlet_pins where outlet_id=o.id and status='verified' and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by effective_from desc limit 1) p on true
    where o.id=${outletId}`;
  return row
    ? {
        name: row.name,
        address: row.address ?? null,
        landmark: row.landmark ?? null,
        ownerName: row.owner_name ?? null,
        ownerPhone: row.owner_phone ?? null,
        latitude: row.latitude ?? null,
        longitude: row.longitude ?? null,
        photoFileId: row.photo_file_id ?? null,
      }
    : null;
}
/** Field "Edit store": a change request for an EXISTING store, linked by target_outlet_id.
 * The whole proposed store rides the op (the phone pre-fills the form); location and photo
 * are optional (left out = unchanged). Same permission as Add store; the office approves
 * it in the store-gathering review and Approve updates that store, never a new one.
 * @param {any} ctx @param {any} actor @param {any} p */
async function captureChange(ctx, actor, p) {
  const targetId = uuid(p.targetOutletId);
  const { access } = await import("../org/readers.js");
  const outlet = await access(ctx, "outlets", targetId, "outlet.enrol.propose");
  if (outlet.deleted_at || outlet.status === "inactive")
    rule("This store is closed and cannot be edited.");
  const unit = await outletOwnerUnit(ctx.db, targetId, ctx.now);
  const batch = await defaultBatch(ctx.db, unit ?? actor.orgUnitId);
  if (!batch) rule("Census batch not found.");
  const at = integer(p.deviceTime, ctx.now - 7 * 86400000, ctx.now + 120000);
  const id = uuid(p.captureId),
    name = required(p.name, "Store name", 200),
    address = required(p.address, "Address", 500);
  const ownerName = required(p.ownerName, "Owner contact name", 150),
    ownerPhone = required(p.ownerPhone, "Owner phone", 40);
  if (ownerPhone.replace(/\D/g, "").length < 7)
    rule("Enter a complete owner phone number.");
  const moved = p.location !== undefined && p.location !== null;
  const loc = moved ? readLocation(p, at) : null;
  const components = moved ? readComponents(p.addressComponents) : null;
  const formattedAddress = moved
    ? optionalText(p.formattedAddress, "Address from search", 500)
    : null;
  const landmark = optionalText(p.landmark, "Landmark", 200);
  const bytes =
    p.photoJpegBase64 === undefined ||
    p.photoJpegBase64 === null ||
    p.photoJpegBase64 === ""
      ? null
      : readJpeg(p.photoJpegBase64);
  const hash = sha256Hex(canonicalJson(p));
  const [prior] =
    await ctx.db`select id,payload_hash,actor_profile_id from census_captures where id=${id}`;
  if (prior) {
    if (
      prior.payload_hash !== hash ||
      prior.actor_profile_id !== actor.profileId
    )
      throw new OpRejected("idempotency_conflict");
    return { entityId: id, eventIds: [] };
  }
  const before = await storeSnapshot(ctx.db, targetId);
  if (!before) rule("Store not found.");
  const same = (/** @type {any} */ a, /** @type {any} */ b) =>
    String(a ?? "").trim() === String(b ?? "").trim();
  if (
    !moved &&
    !bytes &&
    same(before.name, name) &&
    same(before.address, address) &&
    same(before.ownerName, ownerName) &&
    same(before.ownerPhone, ownerPhone) &&
    (landmark === null || same(before.landmark, landmark))
  )
    rule("Nothing was changed.");
  const file = bytes ? await storeJpeg(ctx, id, bytes, actor) : null;
  const gps = loc?.source === "gps";
  await ctx.db`insert into census_captures(id,batch_id,actor_profile_id,payload_hash,name,address,latitude,longitude,accuracy_meters,captured_at,owner_name,owner_phone,channel_id,subchannel_id,estimated_class,photo_file_id,location_provider,location_recorded_at,device_id,location_source,place_id,address_components,formatted_address,landmark,app,kind,target_outlet_id,previous_values) values(${id},${batch.id},${actor.profileId},${hash},${name},${address},${loc ? loc.l.latitude : null},${loc ? loc.l.longitude : null},${gps ? loc.l.accuracyMeters : null},${new Date(at)},${ownerName},${ownerPhone},${null},${null},${null},${file?.id ?? null},${loc ? (gps ? loc.l.provider : "places") : null},${loc ? new Date(gps ? loc.l.fixTime : at) : null},${ctx.device.id},${loc?.source ?? "gps"},${loc?.placeId ?? null},${components},${formattedAddress},${landmark},${ctx.app},'change',${targetId},${before})`;
  if (loc?.source === "places")
    await ctx.enqueue({
      kind: RESOLVE_PLACE_JOB,
      key: id,
      payload: { captureId: id },
    });
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'F-011.census.change','census',${id},${JSON.stringify({ targetOutletId: targetId })})`;
  await ctx.change("census", id, batch.org_unit_id);
  ctx.publish("masters");
  return { entityId: id, eventIds: [] };
}
/** Approve a store change: update the existing store in place (no new store row).
 * @param {any} ctx @param {any} capture @param {any} actor @param {string} reason */
async function applyChange(ctx, capture, actor, reason) {
  const id = capture.target_outlet_id;
  const [outlet] =
    await ctx.db`select id,status,deleted_at from outlets where id=${id} for update`;
  if (!outlet || outlet.deleted_at) rule("Store not found.");
  // Landmark / place left out of the change keep the store's current value.
  const placeId =
    capture.latitude !== null && capture.location_source === "places"
      ? capture.place_id
      : null;
  await ctx.db`update outlets set name=${capture.name},address=${capture.address},directions=coalesce(${capture.landmark ?? null}::text,directions),place_id=coalesce(${placeId}::text,place_id) where id=${id}`;
  await ctx.db`insert into outlet_contacts(outlet_id,ordinal,name,phone) values(${id},0,${capture.owner_name},${capture.owner_phone}) on conflict (outlet_id,ordinal) do update set name=excluded.name,phone=excluded.phone,deleted_at=null,updated_at=now()`;
  if (capture.photo_file_id)
    await ctx.db`insert into outlet_photos(outlet_id,ordinal,file_id) values(${id},0,${capture.photo_file_id}) on conflict (outlet_id,ordinal) do update set file_id=excluded.file_id,deleted_at=null,updated_at=now()`;
  if (capture.latitude !== null) {
    const now = ctx.now;
    const [current] =
      await ctx.db`select id,effective_from from outlet_pins where outlet_id=${id} and status='verified' and deleted_at is null and (effective_to is null or effective_to>${new Date(now)}) order by effective_from desc limit 1`;
    const from = Math.max(
      now,
      current ? new Date(current.effective_from).getTime() + 1 : now,
    );
    if (current)
      await ctx.db`update outlet_pins set effective_to=${new Date(from)} where id=${current.id}`;
    await ctx.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,evidence_storage_id,status,effective_from,proposed_by,proposed_at,verified_by,verified_at,reviewer_reason) values(${id},${capture.latitude},${capture.longitude},50,'census',${capture.photo_file_id ?? null},'verified',${new Date(from)},${capture.actor_profile_id},${capture.captured_at},${actor.userId},${new Date(now)},${reason})`;
  }
  return id;
}
/** F-011 standalone survey adapter, not a second call-flow engine. Photo bytes are
 * bounded to 160 KiB and ride one signed durable operation; no placeholder file IDs.
 * SP-0162: location from GPS (default) or a Google place re-resolved here.
 * @param {any} ctx @param {any} p */
export async function captureCensus(ctx, p) {
  if (!FIELD_APPS.includes(ctx.app))
    throw new OpRejected("unsupported_operation");
  const fresh = await currentActor(ctx.db, ctx.actor);
  const checked = await reauthorizeDevice(ctx.db, fresh, ctx.device.id);
  if (checked.device.app !== ctx.app)
    throw new OpRejected("unsupported_operation");
  ctx = { ...ctx, actor: fresh };
  const actor = await requireCapability(ctx, "outlet.enrol.propose");
  if (p.kind === "change") return captureChange(ctx, actor, p);
  if (p.kind !== undefined && p.kind !== "new") rule("Unknown store request.");
  // SP-0170: a capture carrying the client's customer fields becomes a prospect customer
  // (field enrolment + draft customer profile) for the office to complete and approve.
  if (p.customer !== undefined) return captureCustomer(ctx, actor, p);
  let batch;
  if (p.batchId !== undefined && p.batchId !== null) {
    [batch] =
      await ctx.db`select * from census_batches where id=${uuid(p.batchId)}`;
    if (!batch) rule("Census batch not found.");
  } else {
    if (!actor.orgUnitId) rule("Your access has no organizational scope");
    batch = await defaultBatch(ctx.db, actor.orgUnitId);
    if (!batch) rule("Census batch not found.");
  }
  await requireCapability(ctx, "outlet.enrol.propose", batch.org_unit_id);
  const at = integer(p.deviceTime, ctx.now - 7 * 86400000, ctx.now + 120000);
  if (
    new Date(batch.effective_from).getTime() > at ||
    (batch.effective_to && new Date(batch.effective_to).getTime() <= at)
  )
    rule("The census batch was not open at capture time.");
  const id = uuid(p.captureId),
    name = required(p.name, "Store name", 200),
    address = required(p.address, "Address", 500);
  const ownerName = required(p.ownerName, "Owner contact name", 150),
    ownerPhone = required(p.ownerPhone, "Owner phone", 40);
  if (ownerPhone.replace(/\D/g, "").length < 7)
    rule("Enter a complete owner phone number.");
  if (!["A", "B", "C", "D"].includes(p.estimatedClass))
    rule("Estimate class A, B, C or D.");
  const { source, placeId, l } = readLocation(p, at);
  const components = readComponents(p.addressComponents);
  const formattedAddress = optionalText(
    p.formattedAddress,
    "Address from search",
    500,
  );
  const landmark = optionalText(p.landmark, "Landmark", 200);
  const acknowledged = readAcknowledged(p.acknowledgedDuplicateIds);
  const channel = await reference(ctx, p.channelId, "channel", at),
    sub = await reference(ctx, p.subchannelId, "subchannel", at);
  if (sub.data.channelId !== channel.id)
    rule("Choose the channel's matching sub-channel.");
  const bytes = readJpeg(p.photoJpegBase64);
  const hash = sha256Hex(canonicalJson(p));
  const [prior] =
    await ctx.db`select id,payload_hash,actor_profile_id from census_captures where id=${id}`;
  if (prior) {
    if (
      prior.payload_hash !== hash ||
      prior.actor_profile_id !== actor.profileId
    )
      throw new OpRejected("idempotency_conflict");
    return { entityId: id, eventIds: [] };
  }
  const latitude = l.latitude,
    longitude = l.longitude;
  // Address-search places are never checked against Google inside the sync op (no third
  // party in the transaction, no retryable refusal that would stall the phone's outbox).
  // The capture (append-only) keeps the phone's point; until the census.resolvePlace job
  // writes its census_place_checks row it is "pending" (SP-0162 B2/SF2).
  const pendingPlace = source === "places";
  // Candidates come from the BATCH unit's subtree (already inside the actor's scope by the
  // capability check above), never the actor's wider scope (SP-0162 B1).
  const unitIds = await subtree(ctx.db, batch.org_unit_id);
  const { candidates } = await findDuplicates(
    ctx,
    {
      name,
      phone: ownerPhone,
      latitude,
      longitude,
      placeId,
      excludeCaptureId: id,
    },
    unitIds,
  );
  const flag = candidates.some(
    (/** @type {any} */ c) => !acknowledged.includes(c.id),
  );
  const file = await storeJpeg(ctx, id, bytes, actor);
  const gps = source === "gps";
  await ctx.db`insert into census_captures(id,batch_id,actor_profile_id,payload_hash,name,address,latitude,longitude,accuracy_meters,captured_at,owner_name,owner_phone,channel_id,subchannel_id,estimated_class,photo_file_id,location_provider,location_recorded_at,device_id,location_source,place_id,address_components,formatted_address,landmark,acknowledged_duplicate_ids,duplicate_candidates,duplicate_flag,app) values(${id},${batch.id},${actor.profileId},${hash},${name},${address},${latitude},${longitude},${gps ? l.accuracyMeters : null},${new Date(at)},${ownerName},${ownerPhone},${channel.id},${sub.id},${p.estimatedClass},${file.id},${gps ? l.provider : "places"},${new Date(gps ? l.fixTime : at)},${ctx.device.id},${source},${placeId},${components},${formattedAddress},${landmark},${acknowledged},${candidates},${flag},${ctx.app})`;
  if (pendingPlace)
    await ctx.enqueue({
      kind: RESOLVE_PLACE_JOB,
      key: id,
      payload: { captureId: id },
    });
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'F-011.census.capture','census',${id},'Survey received; location and contact evidence kept separately')`;
  await ctx.change("census", id, batch.org_unit_id);
  ctx.publish("masters");
  return { entityId: id, eventIds: [] };
}
export const RESOLVE_PLACE_JOB = "census.resolvePlace";
/** Background check of an address-search capture against Google Place Details. Runs
 * outside any sync transaction. Within 50 m: 'verified' (Google's point becomes the store
 * pin). Over 50 m or the place is gone: 'mismatch' (both points kept; the reviewer must
 * confirm a pin). Google unavailable: throw so the jobs worker retries with backoff; on the
 * last attempt a fresh job is queued an hour out so a capture is never stuck pending.
 * @param {{db:any, env:any, payload:any, job:any, change?:(t:any,id:string,unit:string)=>Promise<void>, publish?:(topic:string)=>void}} j */
export async function resolvePlaceJob(j) {
  const { db, env, payload, job } = j;
  const [c] =
    await db`select c.id,c.place_id,c.latitude,c.longitude,b.org_unit_id from census_captures c join census_batches b on b.id=c.batch_id left join census_place_checks pc on pc.capture_id=c.id where c.id=${payload.captureId} and c.location_source='places' and pc.capture_id is null`;
  if (!c) return;
  let place;
  try {
    place = await placeDetails(env, c.place_id);
  } catch (e) {
    if (
      e instanceof PlacesUnavailable &&
      Number(job?.attempts ?? 0) >= MAX_ATTEMPTS
    )
      await enqueue(db, {
        kind: RESOLVE_PLACE_JOB,
        key: c.id,
        runAt: Date.now() + 3600_000,
        payload: { captureId: c.id },
      });
    throw e;
  }
  const gap = place
    ? distanceMeters(c.latitude, c.longitude, place.latitude, place.longitude)
    : null;
  const status = gap !== null && gap <= 50 ? "verified" : "mismatch";
  await db.begin(async (/** @type {any} */ t) => {
    const made =
      await t`insert into census_place_checks(capture_id,status,place_latitude,place_longitude,distance_meters) values(${c.id},${status},${place?.latitude ?? null},${place?.longitude ?? null},${gap}) on conflict (capture_id) do nothing returning capture_id`;
    if (made.length && j.change) await j.change(t, c.id, c.org_unit_id);
  });
  j.publish?.("masters");
}
/** @param {any} ctx @param {any} p */
export async function createBatch(ctx, p) {
  const actor = await requireCapability(
    ctx,
    "outlet.manage",
    uuid(p.orgUnitId),
  );
  const [batch] =
    await ctx.db`insert into census_batches(code,name,org_unit_id,expected_outlets,effective_from) values(${required(p.code, "Batch code", 40)},${required(p.name, "Batch name", 160)},${p.orgUnitId},${integer(p.expectedOutlets, 1, 1000000)},${new Date(ctx.now)}) returning id`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'F-011.census.batch','census',${batch.id},'Census batch created')`;
  return { id: batch.id };
}
/** SP-0170 "Add customer": the same census.capture op, with the client's `customer` object
 * (contract §6). It goes through the existing enrolment writer (provisional code, pending pin,
 * pending enrolment) and saves the customer profile at `draft`; the office completes Payment,
 * Delivery, Tax, Pricing, Sales Office and Delivering Plant before approval. Old payloads (no
 * `customer`) keep the census review path unchanged.
 * @param {any} ctx @param {any} actor @param {any} p */
async function captureCustomer(ctx, actor, p) {
  if (
    !p.customer ||
    typeof p.customer !== "object" ||
    Array.isArray(p.customer)
  )
    rule("Enter the customer details.");
  const id = uuid(p.captureId);
  const at = integer(p.deviceTime, ctx.now - 7 * 86400000, ctx.now + 120000);
  const name = required(
    p.customer.customerName ?? p.name,
    "Customer Name",
    200,
  );
  const [previous] =
    await ctx.db`select id,outlet_id from outlet_enrolments where proposed_by=${actor.subject} and client_request_id=${id}`;
  if (previous) return { entityId: previous.outlet_id, eventIds: [] };
  const address = required(p.address, "Customer Address", 500);
  const contactName = required(p.ownerName, "Contact Person", 150);
  const contactPhone =
    typeof p.ownerPhone === "string" && p.ownerPhone.trim()
      ? required(p.ownerPhone, "Mobile No.", 40)
      : null;
  const { l } = readLocation(p, at);
  const bytes = readJpeg(p.photoJpegBase64);
  const file = await storeJpeg(ctx, id, bytes, actor);
  const result = await enrolmentCommand(ctx, "propose", {
    name,
    address,
    contactName,
    contactPhone,
    latitude: l.latitude,
    longitude: l.longitude,
    photoStorageIds: [file.id],
    clientRequestId: id,
    note: "Captured through Add customer on the field app",
    customer: { ...p.customer, customerName: name },
  });
  if (!result) rule("The customer was not saved.");
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'SP-0170.customer.capture','outlet',${result.outletId},'New customer captured on the field app; office completes it before approval')`;
  ctx.publish("outlets");
  ctx.publish("masters");
  return { entityId: result.outletId, eventIds: [] };
}
/** @param {any} ctx @param {any} p */
export async function reviewCensus(ctx, p) {
  const actor = await requireCapability(ctx, "outlet.verify");
  const [capture] =
    await ctx.db`select c.*,b.org_unit_id,pc.place_latitude,pc.place_longitude,(case when c.location_source='gps' then 'verified' when pc.capture_id is null then 'pending' else pc.status end) location_status from census_captures c join census_batches b on b.id=c.batch_id left join census_place_checks pc on pc.capture_id=c.id where c.id=${uuid(p.captureId)}`;
  if (!capture) rule("Capture not found.");
  await requireCapability(ctx, "outlet.verify", capture.org_unit_id);
  if (actor.profileId === capture.actor_profile_id)
    rule("Another person must review the census capture.");
  if (!["accept", "reject", "duplicate"].includes(p.decision))
    rule("Choose a census decision.");
  const reason = required(p.reason, "Review reason", 500);
  const [prior] =
    await ctx.db`select 1 from census_reviews where capture_id=${capture.id}`;
  if (prior) rule("This capture was already reviewed.");
  let outletId = p.outletId ? uuid(p.outletId) : null;
  if (capture.kind === "change") {
    // Edit store: Approve updates the linked store in place; Reject leaves it untouched.
    if (p.decision === "duplicate") rule("Approve or reject a store change.");
    outletId = capture.target_outlet_id;
    if (p.decision === "accept") {
      if (capture.latitude !== null) {
        if (capture.location_status === "pending")
          rule(
            "Still checking the address. Try again in a minute.",
            "location_pending",
          );
        if (
          capture.location_source === "places" &&
          capture.location_status === "verified"
        ) {
          capture.latitude = capture.place_latitude;
          capture.longitude = capture.place_longitude;
        }
        if (capture.location_status === "mismatch") {
          if (p.pinChoice === "place" && capture.place_latitude !== null) {
            capture.latitude = capture.place_latitude;
            capture.longitude = capture.place_longitude;
          } else if (p.pinChoice !== "device")
            rule(
              "The pin and the searched address are far apart. Confirm which pin is right.",
              "location_mismatch",
            );
        }
      }
      await applyChange(ctx, capture, actor, reason);
    }
  } else if (p.decision === "duplicate") {
    if (!outletId) rule("Choose the existing survivor store.");
    const { access } = await import("../org/readers.js");
    const outlet = await access(ctx, "outlets", outletId, "outlet.verify");
    if (outlet.status !== "active") rule("Choose an active survivor.");
  } else if (p.decision === "accept") {
    // SP-0162 B2: an address-search pin is approved only once checked against Google, or
    // when the reviewer explicitly confirms which pin to keep after a mismatch.
    if (capture.location_status === "pending")
      rule(
        "Still checking the address. Try again in a minute.",
        "location_pending",
      );
    if (
      capture.location_source === "places" &&
      capture.location_status === "verified"
    ) {
      // Checked within 50 m: Google's point is the store pin.
      capture.latitude = capture.place_latitude;
      capture.longitude = capture.place_longitude;
    }
    if (capture.location_status === "mismatch") {
      if (p.pinChoice === "device") {
        // The phone's point (the capture's own coordinates) is kept as the pin.
      } else if (p.pinChoice === "place" && capture.place_latitude !== null) {
        capture.latitude = capture.place_latitude;
        capture.longitude = capture.place_longitude;
      } else
        rule(
          "The pin and the searched address are far apart. Confirm which pin is right.",
          "location_mismatch",
        );
    }
    // Blank code: the existing customer code allocator (SP-0082) picks the next one.
    const code =
      typeof p.code === "string" && p.code.trim()
        ? required(p.code, "New store code", 40)
        : await allocate(ctx, "customer");
    const [outlet] =
      await ctx.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,classification,address,enrolment_status,created_by) values('sunpride',${code},${capture.name},'active',${capture.org_unit_id},${null},${capture.address},'approved',${actor.userId}) returning id`;
    outletId = outlet.id;
    await ctx.db`update outlets set channel_id=${capture.channel_id},subchannel_id=${capture.subchannel_id},place_id=${capture.place_id ?? null},directions=${capture.landmark ?? null} where id=${outletId}`;
    await ctx.db`insert into outlet_contacts(outlet_id,ordinal,name,phone) values(${outletId},0,${capture.owner_name},${capture.owner_phone})`;
    await ctx.db`insert into outlet_photos(outlet_id,ordinal,file_id) values(${outletId},0,${capture.photo_file_id})`;
    await ctx.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,evidence_storage_id,status,effective_from,proposed_by,proposed_at,verified_by,verified_at,reviewer_reason) values(${outletId},${capture.latitude},${capture.longitude},50,'census',${capture.photo_file_id},'verified',${new Date(ctx.now)},${capture.actor_profile_id},${capture.captured_at},${actor.userId},${new Date(ctx.now)},${reason})`;
  } else outletId = null;
  if (capture.kind === "change" && p.decision === "reject") outletId = null;
  await ctx.db`insert into census_reviews(capture_id,decision,outlet_id,actor_profile_id,reason) values(${capture.id},${p.decision},${outletId},${actor.profileId},${reason})`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'F-011.census.review','census',${capture.id},${JSON.stringify({ decision: p.decision, kind: capture.kind, outletId, reason, ...(capture.location_status === "mismatch" && p.decision === "accept" ? { pinChoice: p.pinChoice } : {}) })})`;
  const [made] = outletId
    ? await ctx.db`select code from outlets where id=${outletId}`
    : [];
  return {
    id: capture.id,
    kind: capture.kind,
    outletId,
    decision: p.decision,
    code: made?.code ?? null,
  };
}
/** @param {any} ctx */
export async function censusConfig(ctx) {
  const actor = await requireCapability(ctx, "outlet.enrol.propose");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  // SP-0162: the actor's ongoing batch, once its first capture created it (reads never
  // create rows). Phones send no batchId when there is no batch to choose.
  const [fallback] = actor.orgUnitId
    ? await ctx.db`select id,name from census_batches where org_unit_id=${actor.orgUnitId} and is_default`
    : [];
  const batches =
    await ctx.db`select id,name,expected_outlets from census_batches where effective_from<=now() and (effective_to is null or effective_to>now()) and (${unitIds === null} or org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by name limit 101`;
  if (batches.length > 100) rule("Too many active census batches.", "overflow");
  return {
    batches,
    customerMaster: await customerMasterSetup(ctx, unitIds),
    defaultBatch: fallback ? { id: fallback.id, name: fallback.name } : null,
    addressSearch: placesConfigured(ctx.env),
    channels: (await definitionsAt(ctx, "channel"))
      .filter((/** @type {any} */ r) => r.status === "active")
      .map(masterDto),
    subchannels: (await definitionsAt(ctx, "subchannel"))
      .filter((/** @type {any} */ r) => r.status === "active")
      .map(masterDto),
  };
}
/** SP-0170 offline setup for "Add customer": the client's reference lists (small, ~250 rows),
 * the default Sales Organization (the one most of the agent's customers use; SFI 1000 when
 * none) and the provinces of the agent's customers (the phone keeps their barangays offline).
 * @param {any} ctx @param {string[]|null} unitIds */
async function customerMasterSetup(ctx, unitIds) {
  const { referenceRows } = await import("./customers.js");
  const lists = (await referenceRows(ctx.db)).map((/** @type {any} */ r) => ({
    list: r.list,
    salesOrgCode: r.salesOrgCode,
    channelCode: r.channelCode,
    group1Code: r.group1Code,
    code: r.code,
    name: r.name,
  }));
  const area =
    await ctx.db`select p.sales_org_code,p.province_code,count(*)::int n from customer_profiles p join outlets o on o.id=p.outlet_id where o.deleted_at is null and (${unitIds === null} or o.custodian_org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) group by 1,2 order by n desc limit 500`;
  /** @type {Map<string, number>} */ const orgs = new Map();
  for (const r of area)
    if (r.sales_org_code)
      orgs.set(r.sales_org_code, (orgs.get(r.sales_org_code) ?? 0) + r.n);
  const salesOrgCode =
    [...orgs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1000";
  const provinceCodes = [
    ...new Set(
      area
        .map((/** @type {any} */ r) => r.province_code)
        .filter((/** @type {any} */ c) => typeof c === "string" && c),
    ),
  ].slice(0, 12);
  return { salesOrgCode, provinceCodes, lists };
}
/** Field "Edit store": the office's decisions on the caller's OWN store changes (newest 100),
 * so the phone can clear "Change waiting for office" and say plainly when one was not accepted.
 * @param {any} ctx */
export async function myStoreChanges(ctx) {
  const actor = await requireCapability(ctx, "outlet.enrol.propose");
  const rows =
    await ctx.db`select c.id,c.target_outlet_id,r.decision,r.reason,r.created_at from census_captures c join census_reviews r on r.capture_id=c.id where c.actor_profile_id=${actor.profileId} and c.kind='change' order by r.created_at desc limit 100`;
  return {
    items: rows.map((/** @type {any} */ r) => ({
      captureId: r.id,
      targetOutletId: r.target_outlet_id,
      decision: r.decision === "accept" ? "accepted" : "rejected",
      reason: r.decision === "accept" ? null : (r.reason ?? null),
      decidedAt: new Date(r.created_at).getTime(),
    })),
  };
}
/** @param {any} ctx */
export async function censusQueue(ctx) {
  const actor = await requireCapability(ctx, "outlet.verify");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const batches = await ctx.db`select b.id,b.name,b.expected_outlets,
    (select count(*)::int from census_captures c where c.batch_id=b.id and c.kind='new') captured,
    (select count(*)::int from census_captures c join census_reviews r on r.capture_id=c.id where c.batch_id=b.id and c.kind='new' and r.decision='accept') accepted,
    (select count(*)::int from census_captures c left join census_reviews r on r.capture_id=c.id where c.batch_id=b.id and r.id is null) pending
    from census_batches b where (${unitIds === null} or org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by b.created_at desc limit 101`;
  const rows =
    await ctx.db`select c.id,c.name,c.address,c.accuracy_meters,c.captured_at,c.owner_name,c.owner_phone,c.estimated_class,p.name agent,b.name batch,coalesce(case when pc.status='verified' then pc.place_latitude end,c.latitude) latitude,coalesce(case when pc.status='verified' then pc.place_longitude end,c.longitude) longitude,c.location_source,c.formatted_address,c.address_components,c.landmark,c.duplicate_flag,c.duplicate_candidates,c.acknowledged_duplicate_ids,c.actor_profile_id,(case when c.location_source='gps' then 'verified' when pc.capture_id is null then 'pending' else pc.status end) location_status,c.latitude device_latitude,c.longitude device_longitude,pc.place_latitude,pc.place_longitude,ch.label channel,sc.label subchannel,c.kind,c.target_outlet_id,c.previous_values,(c.photo_file_id is not null) has_photo,t.code target_code from census_captures c left join outlets t on t.id=c.target_outlet_id join profiles p on p.id=c.actor_profile_id join census_batches b on b.id=c.batch_id left join census_place_checks pc on pc.capture_id=c.id left join lateral (select v.label from master_versions v where v.master_id=c.channel_id order by v.version desc limit 1) ch on true left join lateral (select v.label from master_versions v where v.master_id=c.subchannel_id order by v.version desc limit 1) sc on true left join census_reviews r on r.capture_id=c.id where r.id is null and (${unitIds === null} or b.org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by c.captured_at limit 101`;
  return {
    batches: batches.slice(0, 100).map((/** @type {any} */ b) => ({
      ...b,
      coveragePct: Math.min(100, (100 * b.accepted) / b.expected_outlets),
      targetPct: 98,
    })),
    // B1: stored candidates were computed at capture time; drop any this reader cannot see now.
    rows: await withChanges(
      ctx.db,
      await candidatesInScope(ctx.db, rows.slice(0, 100), unitIds),
    ),
    truncated: rows.length > 100 || batches.length > 100,
  };
}
/** Edit store rows: old -> new per field, against the store as it is NOW (the snapshot taken
 * at capture time is the fallback if the store has gone). Unchanged fields are left out.
 * @param {any} db @param {any[]} rows */
async function withChanges(db, rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind !== "change") {
      out.push({ ...r, kind: r.kind ?? "new", changes: [] });
      continue;
    }
    const now =
      (await storeSnapshot(db, r.target_outlet_id)) ?? r.previous_values ?? {};
    /** @type {{field:string,label:string,old:string|null,new:string|null}[]} */
    const changes = [];
    const text = (/** @type {any} */ v) =>
      v === null || v === undefined || String(v).trim() === ""
        ? null
        : String(v).trim();
    /** @param {string} field @param {string} label @param {any} before @param {any} after */
    const add = (field, label, before, after) => {
      if (text(before) !== text(after))
        changes.push({ field, label, old: text(before), new: text(after) });
    };
    add("name", "Store name", now.name, r.name);
    add("address", "Address", now.address, r.address);
    add("ownerName", "Owner", now.ownerName, r.owner_name);
    add("ownerPhone", "Owner phone", now.ownerPhone, r.owner_phone);
    if (r.landmark !== null)
      add("landmark", "Landmark", now.landmark, r.landmark);
    if (r.device_latitude !== null) {
      const pin = (/** @type {any} */ a, /** @type {any} */ b) =>
        a === null || a === undefined
          ? null
          : `${Number(a).toFixed(5)}, ${Number(b).toFixed(5)}`;
      changes.push({
        field: "location",
        label: "Location",
        old: pin(now.latitude, now.longitude),
        new: pin(r.latitude, r.longitude),
      });
    }
    if (r.has_photo)
      changes.push({
        field: "photo",
        label: "Photo",
        old: now.photoFileId ? "Current photo" : null,
        new: "New photo",
      });
    out.push({
      ...r,
      latitude: r.latitude ?? now.latitude ?? null,
      longitude: r.longitude ?? now.longitude ?? null,
      target: {
        id: r.target_outlet_id,
        code: r.target_code ?? null,
        name: now.name ?? null,
      },
      changes,
    });
  }
  return out;
}
/** @param {any} ctx */
export async function censusPhoto(ctx) {
  const actor = await requireCapability(ctx, "outlet.verify");
  const [row] =
    await ctx.db`select f.path,f.sha256,b.org_unit_id from census_captures c join census_batches b on b.id=c.batch_id join files f on f.id=c.photo_file_id where c.id=${uuid(ctx.params.id)} and f.status='stored'`;
  if (!row) throw new ApiError("not_found", 404, "Photo not found.");
  await requireCapability(ctx, "outlet.verify", row.org_unit_id);
  if (row.path !== `${row.sha256.slice(0, 2)}/${row.sha256}`)
    throw new ApiError("not_found", 404, "Photo not found.");
  const blob = Bun.file(join(filesDir(ctx.env), row.path));
  if (!(await blob.exists()))
    throw new ApiError("not_found", 404, "Photo not found.");
  return new Response(blob, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
