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
import { scopeFilterForActor, subtree } from "../org/scope.js";
import { definitionsAt, reference, masterDto } from "./definitions.js";
import { placeDetails, PlacesUnavailable, placesConfigured } from "./places.js";
import {
  distanceMeters,
  findDuplicates,
  candidatesInScope,
} from "./duplicates.js";
import { MAX_ATTEMPTS, enqueue } from "../../core/jobs.js";
import { allocate } from "../org/outlets.js";

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
  const encoded = required(p.photoJpegBase64, "Storefront photo", 220000);
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
  if (p.decision === "duplicate") {
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
  await ctx.db`insert into census_reviews(capture_id,decision,outlet_id,actor_profile_id,reason) values(${capture.id},${p.decision},${outletId},${actor.profileId},${reason})`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'F-011.census.review','census',${capture.id},${JSON.stringify({ decision: p.decision, outletId, reason, ...(capture.location_status === "mismatch" && p.decision === "accept" ? { pinChoice: p.pinChoice } : {}) })})`;
  const [made] = outletId
    ? await ctx.db`select code from outlets where id=${outletId}`
    : [];
  return {
    id: capture.id,
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
/** @param {any} ctx */
export async function censusQueue(ctx) {
  const actor = await requireCapability(ctx, "outlet.verify");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const batches = await ctx.db`select b.id,b.name,b.expected_outlets,
    (select count(*)::int from census_captures c where c.batch_id=b.id) captured,
    (select count(*)::int from census_captures c join census_reviews r on r.capture_id=c.id where c.batch_id=b.id and r.decision='accept') accepted,
    (select count(*)::int from census_captures c left join census_reviews r on r.capture_id=c.id where c.batch_id=b.id and r.id is null) pending
    from census_batches b where (${unitIds === null} or org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by b.created_at desc limit 101`;
  const rows =
    await ctx.db`select c.id,c.name,c.address,c.accuracy_meters,c.captured_at,c.owner_name,c.owner_phone,c.estimated_class,p.name agent,b.name batch,coalesce(case when pc.status='verified' then pc.place_latitude end,c.latitude) latitude,coalesce(case when pc.status='verified' then pc.place_longitude end,c.longitude) longitude,c.location_source,c.formatted_address,c.address_components,c.landmark,c.duplicate_flag,c.duplicate_candidates,c.acknowledged_duplicate_ids,c.actor_profile_id,(case when c.location_source='gps' then 'verified' when pc.capture_id is null then 'pending' else pc.status end) location_status,c.latitude device_latitude,c.longitude device_longitude,pc.place_latitude,pc.place_longitude,ch.label channel,sc.label subchannel from census_captures c join profiles p on p.id=c.actor_profile_id join census_batches b on b.id=c.batch_id left join census_place_checks pc on pc.capture_id=c.id left join lateral (select v.label from master_versions v where v.master_id=c.channel_id order by v.version desc limit 1) ch on true left join lateral (select v.label from master_versions v where v.master_id=c.subchannel_id order by v.version desc limit 1) sc on true left join census_reviews r on r.capture_id=c.id where r.id is null and (${unitIds === null} or b.org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by c.captured_at limit 101`;
  return {
    batches: batches.slice(0, 100).map((/** @type {any} */ b) => ({
      ...b,
      coveragePct: Math.min(100, (100 * b.accepted) / b.expected_outlets),
      targetPct: 98,
    })),
    // B1: stored candidates were computed at capture time; drop any this reader cannot see now.
    rows: await candidatesInScope(ctx.db, rows.slice(0, 100), unitIds),
    truncated: rows.length > 100 || batches.length > 100,
  };
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
