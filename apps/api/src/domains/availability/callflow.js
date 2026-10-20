import { ApiError } from "../../core/errors.js";
import { releasesAt, outletAt } from "./masters.js";
import { resolveSet } from "./rules.js";

/** SEAM(CALLFLOW): configure the engine's availability step with this validator.
 * Existing field End / van sale boundaries invoke it until CALLFLOW lands.
 * @param {any} db @param {string} profileId @param {string} outletId @param {string} callKey @param {number} at */
export async function requireAvailability(
  db,
  profileId,
  outletId,
  callKey,
  at,
) {
  const set = resolveSet(
    await outletAt(db, outletId),
    await releasesAt(db, "msl", at),
  );
  if (!set) return;
  const [check] =
    await db`select complete,checked_count,required_count from availability_checks where profile_id=${profileId} and outlet_id=${outletId} and call_key=${callKey} and device_time<=${new Date(at)} order by device_time desc,id desc limit 1`;
  if (!check?.complete || check.checked_count !== check.required_count)
    throw new ApiError(
      "availability_incomplete",
      422,
      "Check every MSL line before completing this call step",
    );
}
