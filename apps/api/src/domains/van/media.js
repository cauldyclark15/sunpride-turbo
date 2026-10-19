import { tx } from "@sunpride/db/client";
import { currentDeviceActor, tripFor } from "./access.js";
import { today, DAMAGE_POLICY, refuse } from "./model.js";

export const VAN_MEDIA_PURPOSES = ["truck-damage"];
/** VISITS calls this from the shared canClaimMedia hook. Never register/replace that hook here.
 * @param {any} db @param {any} actor @param {{purpose:string,ownerId:string|null,deviceId:string}} input
 */
export async function canClaimMedia(db, actor, input) {
  if (input.purpose !== "truck-damage") return false;
  return tx(db, async (t) => {
    const { actor: fresh } = await currentDeviceActor(t, actor, input.deviceId);
    const trips =
      await t`select * from van_trips where salesperson_profile_id=${fresh.profileId} and service_date=${today()}
      and status='active' and deleted_at is null`;
    if (trips.length !== 1) return false;
    const trip = await tripFor(t, fresh, trips[0].id, "van.operate");
    return (
      (input.ownerId === null || input.ownerId === trip.id) &&
      (!trip.started_device_id || trip.started_device_id === input.deviceId)
    );
  });
}
/** Consume uploaded bytes by digest only after checking subject, device, purpose and trip.
 * @param {any} db @param {any} actor @param {any} device @param {any} trip @param {any} digest @param {boolean} required
 */
export async function damagePhoto(db, actor, device, trip, digest, required) {
  if (!digest) {
    if (required)
      refuse("Upload a damage photo first", "evidence_pending_review");
    return null;
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
    refuse("Invalid photo digest", "invalid_request");
  const files =
    await db`select * from files where sha256=${digest} and created_by=${actor.userId} and device_id=${device.id}
    and purpose='truck-damage' and (owner_id=${trip.id} or owner_id is null) and status='stored' and mime='image/jpeg'
    and size>0 and size<=${DAMAGE_POLICY.photoMaxBytes} and created_at>=${trip.created_at} for update`;
  if (files.length !== 1)
    refuse(
      "Damage photo is missing or belongs to another trip",
      "evidence_pending_review",
    );
  const file = files[0];
  const [prior] =
    await db`select * from van_damage_photos where profile_id=${actor.profileId} and sha256=${digest} for update`;
  if (prior?.damage_record_id || (prior && prior.trip_id !== trip.id))
    refuse("Photo already belongs to another damage record", "invalid_request");
  if (prior) return prior.id;
  const [photo] =
    await db`insert into van_damage_photos(organization_id,profile_id,device_id,sha256,storage_id,size,trip_id)
    values(${trip.organization_id},${actor.profileId},${device.id},${digest},${file.id},${file.size},${trip.id}) returning id`;
  return photo.id;
}
