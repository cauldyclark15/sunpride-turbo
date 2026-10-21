import { partnerContext } from "../partners/boundary.js";
import { forbidden } from "../../core/errors.js";
/** F-408: only a dedicated, active partner van login may operate its arranged trip.
 * Shared locks serialize withdrawal against the existing van business transaction.
 * @param {any} db @param {any} actor @param {any} [trip] */
export async function partnerVan(db, actor, trip = null) {
  const member = await partnerContext(db, actor);
  if (!member) return null;
  await db`select id from distributors where id=${member.distributor_id} for share`;
  await db`select id from distributor_users where id=${member.id} for share`;
  const current = await partnerContext(db, actor);
  if (
    !current ||
    current.id !== member.id ||
    current.partner_kind !== "distributor" ||
    current.partner_status !== "accredited" ||
    actor.role !== "sales" ||
    !current.grants.includes("van") ||
    actor.orgUnitId !== current.org_unit_id
  )
    throw forbidden(
      "A dedicated active distributor van operator is required",
      "out_of_scope",
    );
  if (trip) {
    if (
      trip.distributor_id !== current.distributor_id ||
      trip.salesperson_profile_id !== actor.profileId ||
      trip.org_unit_id !== current.org_unit_id
    )
      throw forbidden(
        "This trip belongs to another operator or arrangement",
        "out_of_scope",
      );
    const [arrangement] =
      await db`select id from distributor_van_arrangements where distributor_id=${current.distributor_id} and vehicle_id=${trip.vehicle_id} and stock_owner='sunpride' and effective_from<=now() and (effective_to is null or effective_to>now()) for share`;
    if (!arrangement)
      throw forbidden(
        "The distributor van arrangement is no longer active",
        "out_of_scope",
      );
  }
  return current;
}
