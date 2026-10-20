import { requireCapability, roleHas, ROLES } from "../../core/capabilities.js";
import { scopeFilterForActor } from "../org/scope.js";
import { refuse, date, today } from "./model.js";

/** F-102/F-105 bounded, currently authorized office pickers; no client-entered internal IDs.
 * @param {any} db @param {any} actor @param {string|null} requestedDay
 */
export async function planningChoices(db, actor, requestedDay) {
  await requireCapability({ db, actor }, "van.manage");
  const day = date(requestedDay ?? today()),
    scope = await scopeFilterForActor(db, actor),
    all = scope.unitIds === null,
    ids = scope.unitIds?.length
      ? scope.unitIds
      : ["00000000-0000-0000-0000-000000000000"];
  const roles = ROLES.filter((role) => roleHas(role, "van.operate"));
  const vehicles =
    await db`select v.id as "vehicleId",v.name,v.plate_number as "plateNumber",v.org_unit_id as "unitId",v.home_location_id as "homeLocationId",exists(select 1 from van_trips t where t.vehicle_id=v.id and t.service_date=${day} and t.status not in ('cancelled','closed') and t.deleted_at is null) as busy from vehicles v where v.status='active' and v.deleted_at is null and (${all} or v.org_unit_id in ${db(ids)}) order by v.vehicle_code limit 601`;
  const sellers =
    await db`select id as "profileId",name,org_unit_id as "unitId" from profiles where status='active' and deleted_at is null and role in ${db(roles)} and (${all} or org_unit_id in ${db(ids)}) order by name,id limit 601`;
  const depots =
    await db`select id as "locationId",name,code from inventory_locations where active and deleted_at is null and type<>'truck' and (${all} or org_unit_id in ${db(ids)}) order by name,id limit 601`;
  const routes =
    await db`select r.id as "routeId",r.name,r.code from routes r where r.status='active' and r.deleted_at is null and exists(select 1 from route_territories rt join territory_ownerships o on o.territory_id=rt.territory_id where rt.route_id=r.id and rt.effective_from<=now() and (rt.effective_to is null or rt.effective_to>now()) and o.effective_from<=now() and (o.effective_to is null or o.effective_to>now())) and not exists(select 1 from route_territories rt join territory_ownerships o on o.territory_id=rt.territory_id where rt.route_id=r.id and rt.effective_from<=now() and (rt.effective_to is null or rt.effective_to>now()) and o.effective_from<=now() and (o.effective_to is null or o.effective_to>now()) and not (${all} or o.org_unit_id in ${db(ids)})) order by r.name,r.id limit 601`;
  if ([vehicles, sellers, depots, routes].some((rows) => rows.length > 600))
    refuse(
      "Narrow organizational scope before planning; a picker exceeds 600 choices",
    );
  return { vehicles, sellers, depots, routes };
}
