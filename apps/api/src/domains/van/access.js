import {
  requireCapability,
  roleHas,
  capabilitiesFor,
} from "../../core/capabilities.js";
import { reauthorizeDevice } from "../../core/devices.js";
import { forbidden, unauthenticated, ApiError } from "../../core/errors.js";
import { outletOwnerUnit } from "../org/scope.js";
import { uuid } from "./model.js";
import { partnerVan } from "./partner.js";
import { partnerOutlet } from "../partners/boundary.js";

/** Lock persisted person independently of the proof snapshot and profile hook. @param {any} db @param {any} actor */
export async function currentActor(db, actor) {
  if (!actor) throw unauthenticated();
  const [p] =
    await db`select p.*, u.disabled_at from profiles p join users u on u.id=p.user_id where p.id=${actor.profileId} for share of p,u`;
  if (
    !p ||
    p.disabled_at ||
    p.deleted_at ||
    p.status !== "active" ||
    p.user_id !== actor.userId ||
    p.role !== actor.role ||
    p.org_unit_id !== actor.orgUnitId
  )
    throw forbidden("Your access changed", "scope_withdrawn");
  const assignments =
    await db`select role,org_unit_id from employee_assignments where profile_id=${p.id} and effective_from<=now() and (effective_to is null or effective_to>now()) and deleted_at is null for share`;
  if (
    assignments.length !== 1 ||
    assignments[0].role !== p.role ||
    assignments[0].org_unit_id !== p.org_unit_id
  )
    throw forbidden("Your assignment changed", "scope_withdrawn");
  const [unit] =
    await db`select id from org_units where id=${p.org_unit_id} and status='active' and effective_from<=now() and (effective_to is null or effective_to>now()) and deleted_at is null for share`;
  if (!unit)
    throw forbidden("Your organizational scope is inactive", "scope_withdrawn");
  return {
    ...actor,
    name: p.name,
    capabilities: new Set(capabilitiesFor(p.role)),
  };
}
/** @param {any} db @param {any} actor @param {string} deviceId */
export async function currentDeviceActor(db, actor, deviceId) {
  const fresh = await currentActor(db, actor);
  const checked = await reauthorizeDevice(db, fresh, deviceId);
  if (checked.device.app !== "van-android")
    throw forbidden("Use a registered van device", "device_unavailable");
  await requireCapability({ db, actor: fresh }, "van.operate", fresh.orgUnitId);
  const partner = await partnerVan(db, fresh);
  return { ...checked, actor: fresh, partner };
}
/** @param {any} db @param {any} actor @param {string} tripId @param {string} [capability] @param {boolean} [lock] */
export async function tripFor(
  db,
  actor,
  tripId,
  capability = "van.read",
  lock = false,
) {
  await requireCapability({ db, actor }, capability);
  uuid(tripId);
  const [trip] = lock
    ? await db`select * from van_trips where id=${tripId} and deleted_at is null for update`
    : await db`select * from van_trips where id=${tripId} and deleted_at is null`;
  if (!trip) throw new ApiError("not_found", 404, "Trip not found");
  const partner = await partnerVan(db, actor, trip);
  if (!partner && trip.distributor_id && actor.role === "sales")
    throw forbidden(
      "A partner-arranged trip needs its dedicated operator",
      "out_of_scope",
    );
  await requireCapability({ db, actor }, capability, trip.org_unit_id);
  if (actor.role === "sales" && trip.salesperson_profile_id !== actor.profileId)
    throw forbidden("This trip belongs to another seller", "out_of_scope");
  return trip;
}
/** @param {any} db @param {any} actor @param {string} id @param {string} cap */
export async function locationFor(db, actor, id, cap) {
  uuid(id);
  const [l] =
    await db`select * from inventory_locations where id=${id} and deleted_at is null and active`;
  if (!l || !l.org_unit_id)
    throw forbidden("Location is unavailable or unassigned", "out_of_scope");
  await requireCapability({ db, actor }, cap, l.org_unit_id);
  return l;
}
/** @param {any} db @param {any} actor @param {string} outletId */
export async function outletFor(db, actor, outletId) {
  uuid(outletId);
  const [outlet] =
    await db`select * from outlets where id=${outletId} and status='active' and deleted_at is null`;
  if (!outlet) throw forbidden("Customer is unavailable", "out_of_scope");
  const partner = await partnerVan(db, actor);
  if (partner) await partnerOutlet(db, actor, outletId);
  else {
    const unit = await outletOwnerUnit(db, outletId, Date.now());
    if (!unit) throw forbidden("Customer has no current owner", "out_of_scope");
    await requireCapability({ db, actor }, "van.read", unit);
  }
  const [link] =
    await db`select c.code from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${outletId} and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) and l.deleted_at is null and c.active and c.deleted_at is null order by l.effective_from desc limit 1`;
  return { ...outlet, customerCode: link?.code ?? null };
}
/** @param {any} actor @param {any} trip */
export function notSelf(actor, trip) {
  if (actor.profileId === trip.salesperson_profile_id)
    throw forbidden("You cannot approve your own trip");
}
/** @param {any} actor @param {string} capability */
export const can = (actor, capability) =>
  Boolean(actor && roleHas(actor.role, capability));
