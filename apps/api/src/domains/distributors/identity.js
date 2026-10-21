import { actorFor } from "../../core/context.js";
import { forbidden } from "../../core/errors.js";
import { authorize } from "./model.js";
/** F-404/F-407: reauthenticate partner membership without inventing employee assignment/capabilities.
 * @param {any} db @param {any} actor @param {string} grant */
export async function currentPartnerActor(db, actor, grant) {
  if (!actor || actor.role !== "distributor")
    throw forbidden("Use an active distributor identity");
  const [profile] =
    await db`select p.*,u.disabled_at from profiles p join users u on u.id=p.user_id where p.id=${actor.profileId} for share of p,u`;
  if (
    !profile ||
    profile.disabled_at ||
    profile.deleted_at ||
    profile.status !== "active" ||
    profile.user_id !== actor.userId ||
    profile.role !== "distributor" ||
    profile.org_unit_id !== actor.orgUnitId
  )
    throw forbidden("Partner identity changed", "scope_withdrawn");
  const rows =
    await db`select d.id from distributors d join distributor_users u on u.distributor_id=d.id join org_units o on o.id=d.device_org_unit_id where u.profile_id=${actor.profileId} and ${grant}=any(u.grants) and u.effective_from<=clock_timestamp() and (u.effective_to is null or u.effective_to>clock_timestamp()) and d.device_org_unit_id=${actor.orgUnitId} and d.status='accredited' and d.effective_from<=clock_timestamp() and (d.effective_to is null or d.effective_to>clock_timestamp()) and o.status='active' and o.deleted_at is null and o.effective_from<=clock_timestamp() and (o.effective_to is null or o.effective_to>clock_timestamp()) for share of d,u,o`;
  if (rows.length !== 1)
    throw forbidden("Partner permission changed", "scope_withdrawn");
  const fresh = await actorFor(db, actor.userId);
  if (
    !fresh ||
    fresh.profileId !== actor.profileId ||
    fresh.role !== actor.role ||
    fresh.orgUnitId !== actor.orgUnitId
  )
    throw forbidden("Partner identity changed", "scope_withdrawn");
  await authorize({ db, actor: fresh }, rows[0].id, grant);
  return fresh;
}
