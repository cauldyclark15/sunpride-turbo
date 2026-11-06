import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { forbidden } from "../../core/errors.js";
import { scopeFilterForActor } from "../org/scope.js";
import { pinSettings } from "../storepos/security.js";
import { audit } from "./facts.js";
import { date, dayString, refuse, text, today, uuid } from "./model.js";

/**
 * IP-VANDAY: the weekly roster, the crew on a trip, the phone that belongs to the truck and the people who take turns on it.
 * Plain words in every refusal: this is what the supervisor reads.
 */

export const CREW_ROLES = ["seller", "helper", "driver", "relief"];
const DAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
/** ISO weekday (1 = Monday ... 7 = Sunday) of a Manila date string. @param {string} day */
export const isoWeekday = (day) => {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
/** @param {number[]} days */
export const weekdayLabel = (days) =>
  [...days]
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d]?.slice(0, 3))
    .join(", ");

/** @param {any} db @param {any} actor @returns {Promise<{all:boolean, ids:string[]}>} */
async function scopeOf(db, actor) {
  const scope = await scopeFilterForActor(db, actor);
  return {
    all: scope.unitIds === null,
    ids: scope.unitIds?.length
      ? scope.unitIds
      : ["00000000-0000-0000-0000-000000000000"],
  };
}

/** An active person who may sell from a truck. @param {any} db @param {any} id @param {string} what */
async function crewPerson(db, id, what) {
  const [p] =
    await db`select id,name,role,org_unit_id,user_id from profiles where id=${uuid(id)} and status='active' and deleted_at is null`;
  if (!p || !p.user_id) refuse(`Choose an active person for ${what}`);
  if (!roleHas(p.role, "van.operate"))
    refuse(`${p.name} cannot work on a van. Choose a seller or helper`);
  return p;
}

// ------------------------------------------------------------------ roster

/** Create or change one roster line, or end it. @param {any} db @param {any} actor @param {any} p */
export async function saveRoster(db, actor, p) {
  const [vehicle] =
    await db`select * from vehicles where id=${uuid(p.vehicleId)} and status='active' and deleted_at is null`;
  if (!vehicle) refuse("Choose an active truck");
  await requireCapability({ db, actor }, "van.manage", vehicle.org_unit_id);
  /** @type {any} */ let existing = null;
  if (p.rosterId) {
    [existing] =
      await db`select * from van_rosters where id=${uuid(p.rosterId)} and deleted_at is null for update`;
    if (!existing) refuse("That roster line is not found");
    if (existing.vehicle_id !== vehicle.id)
      refuse("A roster line stays with its truck");
  }
  if (p.end === true) {
    if (!existing) refuse("Choose the roster line to end");
    const endOn = p.effectiveTo ? date(p.effectiveTo) : today();
    await db`update van_rosters set status='ended',effective_to=greatest(effective_from,${endOn}::date),updated_by=${actor.subject},updated_at=now() where id=${existing.id}`;
    await audit(db, null, actor, "van.roster.ended", existing.id);
    return { rosterId: existing.id, ended: true };
  }
  const days = [
    ...new Set(
      (Array.isArray(p.weekdays) ? p.weekdays : []).map((/** @type {any} */ d) =>
        Number(d),
      ),
    ),
  ].sort((a, b) => a - b);
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    refuse("Pick the days of the week, Monday to Sunday");
  const from = date(p.effectiveFrom ?? existing?.effective_from?.toISOString?.().slice(0, 10) ?? today());
  const to = p.effectiveTo ? date(p.effectiveTo) : null;
  if (to && to < from) refuse("The end date is before the start date");
  const seller = await crewPerson(db, p.sellerProfileId, "the seller");
  const helper = p.helperProfileId
    ? await crewPerson(db, p.helperProfileId, "the helper")
    : null;
  const driver = p.driverProfileId
    ? await crewPerson(db, p.driverProfileId, "the driver")
    : null;
  await requireCapability({ db, actor }, "van.manage", seller.org_unit_id);
  if (new Set([seller.id, helper?.id, driver?.id].filter(Boolean)).size !==
    [seller.id, helper?.id, driver?.id].filter(Boolean).length)
    refuse("The seller, helper and driver must be different people");
  /** @type {string|null} */ let routeId = null;
  if (p.routeId) {
    const [r] =
      await db`select id from routes where id=${uuid(p.routeId)} and status='active' and deleted_at is null`;
    if (!r) refuse("Choose an active route");
    routeId = r.id;
  }
  let sourceLocationId = vehicle.home_location_id;
  if (p.sourceLocationId) {
    const [l] =
      await db`select id,type,org_unit_id from inventory_locations where id=${uuid(p.sourceLocationId)} and active and deleted_at is null`;
    if (!l || l.type === "truck") refuse("Load from a depot, not a truck");
    await requireCapability({ db, actor }, "van.manage", l.org_unit_id);
    sourceLocationId = l.id;
  }
  // No two lines may put the same truck, or the same seller, on the same weekday in the same dates.
  const overlaps = await db`select r.id,r.weekdays,r.vehicle_id,r.seller_profile_id,v.vehicle_code,s.name as seller_name from van_rosters r join vehicles v on v.id=r.vehicle_id join profiles s on s.id=r.seller_profile_id
    where r.deleted_at is null and r.status='active' and (${existing?.id ?? null}::uuid is null or r.id<>${existing?.id ?? null}::uuid)
      and (r.vehicle_id=${vehicle.id} or r.seller_profile_id=${seller.id})
      and r.weekdays && ${db.array(days, "INT2")}::smallint[]
      and r.effective_from<=coalesce(${to}::date,'9999-12-31'::date) and coalesce(r.effective_to,'9999-12-31'::date)>=${from}::date`;
  for (const o of overlaps) {
    const shared = days.filter((d) => o.weekdays.includes(d));
    if (o.vehicle_id === vehicle.id)
      refuse(
        `${o.vehicle_code} is already rostered with ${o.seller_name} on ${weekdayLabel(shared)} in those dates`,
      );
    refuse(
      `${seller.name} is already rostered on ${o.vehicle_code} on ${weekdayLabel(shared)} in those dates`,
    );
  }
  const values = {
    unit: vehicle.org_unit_id,
    route: routeId,
    helper: helper?.id ?? null,
    driver: driver?.id ?? null,
    note: text(p.note, 200),
  };
  let id = existing?.id;
  if (existing)
    await db`update van_rosters set route_id=${values.route},seller_profile_id=${seller.id},helper_profile_id=${values.helper},driver_profile_id=${values.driver},source_location_id=${sourceLocationId},weekdays=${db.array(days, "INT2")},effective_from=${from},effective_to=${to},note=${values.note},updated_by=${actor.subject},updated_at=now() where id=${existing.id}`;
  else {
    [{ id }] =
      await db`insert into van_rosters(organization_id,org_unit_id,vehicle_id,route_id,seller_profile_id,helper_profile_id,driver_profile_id,source_location_id,weekdays,effective_from,effective_to,note,created_by)
      values(${vehicle.organization_id},${vehicle.org_unit_id},${vehicle.id},${values.route},${seller.id},${values.helper},${values.driver},${sourceLocationId},${db.array(days, "INT2")},${from},${to},${values.note},${actor.subject}) returning id`;
  }
  await audit(db, null, actor, existing ? "van.roster.changed" : "van.roster.created", id);
  return { rosterId: id };
}

/** @param {any} db @param {any} actor @param {{unitId?:string|null, day?:string|null, vehicleId?:string|null}} q */
export async function listRosters(db, actor, q) {
  await requireCapability({ db, actor }, "van.read");
  const scope = await scopeOf(db, actor);
  const day = q.day ? date(q.day) : null;
  const list = await db`select r.id as "rosterId",r.vehicle_id as "vehicleId",v.vehicle_code as "vehicleCode",v.plate_number as "plateNumber",r.route_id as "routeId",rt.name as "routeName",
      r.seller_profile_id as "sellerProfileId",s.name as "sellerName",r.helper_profile_id as "helperProfileId",h.name as "helperName",r.driver_profile_id as "driverProfileId",d.name as "driverName",
      r.weekdays,r.effective_from as "effectiveFrom",r.effective_to as "effectiveTo",r.status,r.note,r.org_unit_id as "unitId",r.source_location_id as "sourceLocationId"
    from van_rosters r join vehicles v on v.id=r.vehicle_id join profiles s on s.id=r.seller_profile_id
      left join profiles h on h.id=r.helper_profile_id left join profiles d on d.id=r.driver_profile_id left join routes rt on rt.id=r.route_id
    where r.deleted_at is null and (${scope.all} or r.org_unit_id in ${db(scope.ids)})
      and (${q.unitId ?? null}::uuid is null or r.org_unit_id=${q.unitId ?? null}::uuid)
      and (${q.vehicleId ?? null}::uuid is null or r.vehicle_id=${q.vehicleId ?? null}::uuid)
      and (${day}::date is null or (r.status='active' and r.effective_from<=${day}::date and (r.effective_to is null or r.effective_to>=${day}::date) and ${day ? isoWeekday(day) : 0}::smallint=any(r.weekdays)))
    order by v.vehicle_code,r.effective_from limit 500`;
  return {
    items: list.map((/** @type {any} */ r) => ({
      ...r,
      effectiveFrom: dayString(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? dayString(r.effectiveTo) : null,
      weekdayLabel: weekdayLabel(r.weekdays),
    })),
  };
}

/** Rosters that run on a Manila date. @param {any} db @param {string} day @param {string|null} unitId */
export async function rostersOn(db, day, unitId) {
  return db`select r.*,v.vehicle_code,v.plate_number,v.truck_location_id,v.home_location_id,v.status as vehicle_status
    from van_rosters r join vehicles v on v.id=r.vehicle_id
    where r.deleted_at is null and r.status='active' and r.effective_from<=${day}::date and (r.effective_to is null or r.effective_to>=${day}::date)
      and ${isoWeekday(day)}=any(r.weekdays) and (${unitId}::uuid is null or r.org_unit_id=${unitId}::uuid)
    order by v.vehicle_code,r.id`;
}

// ------------------------------------------------------------------ trip crew

/** Put people on a trip's crew (the seller is always on it). @param {any} db @param {string} tripId @param {Array<{profileId:string, role:string}>} members @param {string} source @param {string} by */
export async function addCrew(db, tripId, members, source, by) {
  for (const m of members) {
    if (!m.profileId) continue;
    await db`insert into van_trip_crew(trip_id,profile_id,role,source,added_by) values(${tripId},${m.profileId},${m.role},${source},${by}) on conflict do nothing`;
  }
}

/** POST van/trips/crew: add or take off a crew member before or during the day. @param {any} db @param {any} actor @param {any} p */
export async function setTripCrew(db, actor, p) {
  const [trip] =
    await db`select * from van_trips where id=${uuid(p.tripId)} and deleted_at is null for update`;
  if (!trip) refuse("Trip not found");
  await requireCapability({ db, actor }, "van.manage", trip.org_unit_id);
  if (["closed", "cancelled"].includes(trip.status))
    refuse("This trip is already finished");
  const role = String(p.role ?? "");
  if (!CREW_ROLES.includes(role) || role === "seller")
    refuse("Choose helper, driver or relief. The seller changes by handover");
  const person = await crewPerson(db, p.profileId, "the crew");
  if (p.remove === true) {
    await db`update van_trip_crew set ended_at=now(),ended_by=${actor.subject} where trip_id=${trip.id} and profile_id=${person.id} and role=${role} and ended_at is null`;
    await audit(db, trip, actor, "van.crew.removed", person.id, { role });
    return { tripId: trip.id, profileId: person.id };
  }
  await db`insert into van_trip_crew(trip_id,profile_id,role,source,added_by) values(${trip.id},${person.id},${role},'manual',${actor.subject}) on conflict do nothing`;
  if (role === "helper")
    await db`update van_trips set helper_name=${person.name},updated_at=now() where id=${trip.id}`;
  if (role === "driver")
    await db`update van_trips set driver_name=${person.name},updated_at=now() where id=${trip.id}`;
  await audit(db, trip, actor, "van.crew.added", person.id, { role });
  return { tripId: trip.id, profileId: person.id };
}

// ------------------------------------------------------------------ device -> truck

/** POST van/devices/bind: this phone belongs to this truck. Replaces the truck's previous phone. @param {any} db @param {any} actor @param {any} p */
export async function bindDevice(db, actor, p) {
  const [vehicle] =
    await db`select * from vehicles where id=${uuid(p.vehicleId)} and status='active' and deleted_at is null for update`;
  if (!vehicle) refuse("Choose an active truck");
  await requireCapability({ db, actor }, "van.manage", vehicle.org_unit_id);
  const [device] =
    await db`select * from registered_devices where id=${uuid(p.deviceId)} for update`;
  if (!device || device.app !== "van-android" || device.status !== "active")
    refuse("Choose a van phone that is set up and working");
  if (device.org_unit_id)
    await requireCapability({ db, actor }, "van.manage", device.org_unit_id);
  const [same] =
    await db`select id from van_device_bindings where device_id=${device.id} and vehicle_id=${vehicle.id} and released_at is null`;
  if (same) return { bindingId: same.id, vehicleId: vehicle.id, unchanged: true };
  await db`update van_device_bindings set released_at=now(),released_by=${actor.subject} where (device_id=${device.id} or vehicle_id=${vehicle.id}) and released_at is null`;
  const [row] =
    await db`insert into van_device_bindings(device_id,vehicle_id,bound_by,note) values(${device.id},${vehicle.id},${actor.subject},${text(p.note, 200)}) returning id`;
  // The people on the old phone are no longer "on" it once it leaves the truck.
  await db`update van_crew_sessions set ended_at=now(),ended_reason='phone moved to another truck' where device_id=${device.id} and ended_at is null and vehicle_id is distinct from ${vehicle.id}`;
  await audit(db, null, actor, "van.device.bound", row.id, {
    deviceId: device.id,
    vehicleId: vehicle.id,
  });
  return { bindingId: row.id, vehicleId: vehicle.id };
}

/** POST van/devices/unbind. @param {any} db @param {any} actor @param {any} p */
export async function unbindDevice(db, actor, p) {
  const [b] =
    await db`select b.*,v.org_unit_id from van_device_bindings b join vehicles v on v.id=b.vehicle_id where b.device_id=${uuid(p.deviceId)} and b.released_at is null for update of b`;
  if (!b) refuse("That phone is not on a truck");
  await requireCapability({ db, actor }, "van.manage", b.org_unit_id);
  await db`update van_device_bindings set released_at=now(),released_by=${actor.subject} where id=${b.id}`;
  await audit(db, null, actor, "van.device.unbound", b.id, { deviceId: b.device_id });
  return { bindingId: b.id };
}

/** The truck a phone belongs to now, or null. @param {any} db @param {string} deviceId */
export async function vehicleOfDevice(db, deviceId) {
  const [row] =
    await db`select v.id as "vehicleId",v.vehicle_code as "vehicleCode",v.plate_number as "plateNumber",b.bound_at as "boundAt" from van_device_bindings b join vehicles v on v.id=b.vehicle_id where b.device_id=${deviceId} and b.released_at is null`;
  return row
    ? { ...row, boundAt: new Date(row.boundAt).getTime() }
    : null;
}

// ------------------------------------------------------------------ PINs and the phone's current person

/** POST van/crew/pin: the office sets one person's PIN for taking over a shared phone. @param {any} db @param {any} actor @param {any} p */
export async function setCrewPin(db, actor, p) {
  const [person] =
    await db`select id,name,role,org_unit_id from profiles where id=${uuid(p.profileId)} and status='active' and deleted_at is null for update`;
  if (!person || !roleHas(person.role, "van.operate"))
    refuse("Choose an active seller or helper");
  await requireCapability({ db, actor }, "van.manage", person.org_unit_id);
  const pin = String(p.pin ?? "");
  if (!/^\d{6,12}$/.test(pin)) refuse("Use a PIN of 6 to 12 digits");
  const s = pinSettings(pin);
  await db`update van_crew_pins set effective_to=clock_timestamp() where profile_id=${person.id} and effective_to is null`;
  const [row] =
    await db`insert into van_crew_pins(profile_id,pin_salt,pin_hash,pin_key,set_by) values(${person.id},${s.salt},${s.hash},${s.key},${actor.profileId}) returning id`;
  await db`delete from van_crew_pin_attempts where profile_id=${person.id}`;
  await audit(db, null, actor, "van.crew.pin_set", row.id, { profileId: person.id });
  return { pinId: row.id, profileId: person.id };
}

/** The message both the phone and the server sign, so a PIN entry cannot be replayed for another switch.
 * @param {{deviceId:string, tripId:string, toProfileId:string, pinId:string, at:number}} m */
export const crewMessage = (m) =>
  `crew|${m.deviceId}|${m.tripId}|${m.toProfileId}|${m.pinId}|${m.at}`;
/** @param {string} keyHex @param {Parameters<typeof crewMessage>[0]} m */
export const crewProof = (keyHex, m) =>
  createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(crewMessage(m))
    .digest("hex");

const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
/** @param {any} db @param {string} profileId */
async function checkLocked(db, profileId) {
  const [a] =
    await db`select * from van_crew_pin_attempts where profile_id=${profileId}`;
  if (a?.locked_until && new Date(a.locked_until).getTime() > Date.now())
    throw new (await import("../../core/errors.js")).ApiError(
      "rate_limited",
      429,
      "Too many wrong PINs. Wait 10 minutes or ask the office to reset it.",
    );
}
/** @param {any} db @param {string} profileId */
async function noteFailure(db, profileId) {
  await db`insert into van_crew_pin_attempts(profile_id,failures,window_started_at) values(${profileId},1,now())
    on conflict (profile_id) do update set
      failures=case when van_crew_pin_attempts.window_started_at<now()-interval '10 minutes' then 1 else van_crew_pin_attempts.failures+1 end,
      window_started_at=case when van_crew_pin_attempts.window_started_at<now()-interval '10 minutes' then now() else van_crew_pin_attempts.window_started_at end,
      locked_until=case when (case when van_crew_pin_attempts.window_started_at<now()-interval '10 minutes' then 1 else van_crew_pin_attempts.failures+1 end)>=${MAX_FAILURES} then now()+${LOCK_MS / 1000} * interval '1 second' else van_crew_pin_attempts.locked_until end`;
}

/** Online PIN check for taking over the phone. Run on the POOL (its own statements), so wrong tries are kept even though the
 * refusal aborts the caller's transaction. 5 wrong in 10 minutes locks that person's PIN for 10 minutes.
 * @param {any} pool @param {string} profileId @param {string} pin */
export async function verifyCrewPinOnline(pool, profileId, pin) {
  await checkLocked(pool, uuid(profileId));
  const [row] =
    await pool`select k.*,p.name from van_crew_pins k join profiles p on p.id=k.profile_id where k.profile_id=${profileId} and k.effective_to is null`;
  if (!row) refuse("That person has no PIN yet. Ask the office to set one");
  const given = String(pin ?? "");
  const ok =
    /^\d{6,12}$/.test(given) &&
    (() => {
      const key = Buffer.from(pbkdf2Sync(given, row.pin_salt, 160000, 32, "sha256").toString("hex"));
      const stored = Buffer.from(row.pin_key);
      return key.length === stored.length && timingSafeEqual(key, stored);
    })();
  if (!ok) {
    await noteFailure(pool, profileId);
    refuse("That PIN was not accepted");
  }
  await pool`delete from van_crew_pin_attempts where profile_id=${profileId}`;
  return true;
}

/** Who is on a phone right now. @param {any} db @param {string} deviceId @param {number} [at] */
export async function personOnDevice(db, deviceId, at = Date.now()) {
  const [s] =
    await db`select s.id,s.profile_id,s.role,s.started_at,s.method,s.trip_id,p.name from van_crew_sessions s join profiles p on p.id=s.profile_id
      where s.device_id=${deviceId} and s.started_at<=${new Date(at)} and (s.ended_at is null or s.ended_at>${new Date(at)}) order by s.started_at desc limit 1`;
  return s
    ? {
        sessionId: s.id,
        profileId: s.profile_id,
        name: s.name,
        role: s.role,
        since: new Date(s.started_at).getTime(),
        method: s.method,
        tripId: s.trip_id,
      }
    : null;
}

/** The trip's active crew with the PIN verifiers a phone needs to check a PIN offline. Only one-way verifiers leave the server.
 * @param {any} db @param {string} tripId */
export async function crewDirectory(db, tripId) {
  const members = await db`select c.profile_id as "profileId",p.name,c.role,k.id as "pinId",k.pin_salt as salt,k.pin_hash as hash
    from van_trip_crew c join profiles p on p.id=c.profile_id left join van_crew_pins k on k.profile_id=c.profile_id and k.effective_to is null
    where c.trip_id=${tripId} and c.ended_at is null order by case c.role when 'seller' then 0 when 'helper' then 1 when 'driver' then 2 else 3 end,p.name`;
  return members;
}

/**
 * Put another crew member on the phone. The phone, its sign-in and its trip are untouched: one session ends, one starts.
 * Online, the person types a PIN and the server checks it. Offline, the phone sends the HMAC proof it derived from the PIN.
 * Idempotent per client op id.
 * @param {any} db
 * @param {{deviceId:string, trip:any, toProfileId:string, method:'pin_online'|'pin_offline'|'office'|'start', verified?:boolean, pinId?:string, proof?:string, at:number, clientOpId?:string|null, recordedBy:string}} s
 */
export async function switchCrew(db, s) {
  const { trip } = s;
  if (s.clientOpId) {
    const [prior] =
      await db`select * from van_crew_sessions where client_op_id=${s.clientOpId}`;
    if (prior) return { sessionId: prior.id, profileId: prior.profile_id, replay: true };
  }
  const [crew] =
    await db`select c.role,p.name,p.id from van_trip_crew c join profiles p on p.id=c.profile_id where c.trip_id=${trip.id} and c.profile_id=${s.toProfileId} and c.ended_at is null and p.status='active' and p.deleted_at is null order by case c.role when 'seller' then 0 else 1 end limit 1`;
  if (!crew)
    refuse(
      "That person is not on this trip's crew. Ask the office to add them first",
    );
  if (s.method !== "office" && s.method !== "start") {
    const [pin] = s.pinId
      ? await db`select * from van_crew_pins where id=${s.pinId} and profile_id=${crew.id} and effective_from<=${new Date(s.at)} and (effective_to is null or effective_to>${new Date(s.at)})`
      : await db`select * from van_crew_pins where profile_id=${crew.id} and effective_to is null`;
    if (!pin) refuse(`${crew.name} has no PIN yet. Ask the office to set one`);
    if (s.method === "pin_online") {
      // Checked (and wrong tries counted) outside this transaction by verifyCrewPinOnline, so a refusal cannot roll the count back.
      if (s.verified !== true) refuse("That PIN was not accepted");
    } else {
      const expected = crewProof(pin.pin_key, {
        deviceId: s.deviceId,
        tripId: trip.id,
        toProfileId: crew.id,
        pinId: pin.id,
        at: s.at,
      });
      const a = Buffer.from(expected, "hex"),
        b = Buffer.from(String(s.proof ?? ""), "hex");
      if (!/^[a-f0-9]{64}$/.test(String(s.proof ?? "")) || a.length !== b.length || !timingSafeEqual(a, b))
        refuse("That PIN was not accepted");
    }
  }
  const [cur] =
    await db`select * from van_crew_sessions where device_id=${s.deviceId} and ended_at is null for update`;
  if (cur && cur.profile_id === crew.id && cur.trip_id === trip.id)
    return { sessionId: cur.id, profileId: crew.id, unchanged: true };
  if (cur)
    await db`update van_crew_sessions set ended_at=${new Date(s.at)},ended_reason=${cur.profile_id === crew.id ? "same person, new trip" : "crew changed"} where id=${cur.id}`;
  const [vehicle] = await vehicleOfDevice(db, s.deviceId).then((v) => [v]);
  const [row] =
    await db`insert into van_crew_sessions(device_id,vehicle_id,trip_id,profile_id,role,method,started_at,switched_from,client_op_id,recorded_by)
    values(${s.deviceId},${vehicle?.vehicleId ?? trip.vehicle_id},${trip.id},${crew.id},${crew.role},${s.method},${new Date(s.at)},${cur?.id ?? null},${s.clientOpId ?? null},${s.recordedBy}) returning id`;
  return {
    sessionId: row.id,
    profileId: crew.id,
    name: crew.name,
    role: crew.role,
    switchedFrom: cur?.profile_id ?? null,
  };
}

/** POST van/crew-sessions (online, from the phone or the office): `{deviceId, tripId, toProfileId, pin}` or office `{…, office:true}`.
 * @param {any} db @param {any} actor @param {any} p @param {boolean} [verified] the route already checked the PIN */
export async function crewSessionCommand(db, actor, p, verified = false) {
  const [trip] =
    await db`select * from van_trips where id=${uuid(p.tripId)} and deleted_at is null for update`;
  if (!trip) refuse("Trip not found");
  const [device] =
    await db`select * from registered_devices where id=${uuid(p.deviceId)}`;
  if (!device || device.status !== "active")
    refuse("That phone is not set up and working");
  const office = p.office === true;
  if (office) await requireCapability({ db, actor }, "van.manage", trip.org_unit_id);
  else if (device.profile_id !== actor.profileId)
    throw forbidden("Use this on your own phone, or ask the office", "device_unavailable");
  if (["closed", "cancelled"].includes(trip.status))
    refuse("This trip is already finished");
  const result = await switchCrew(db, {
    deviceId: device.id,
    trip,
    toProfileId: uuid(p.toProfileId),
    method: office ? "office" : "pin_online",
    verified,
    at: Date.now(),
    recordedBy: actor.subject,
  });
  await audit(db, trip, actor, "van.crew.switched", result.sessionId, {
    toProfileId: result.profileId,
  });
  return { tripId: trip.id, ...result };
}

/** Handover (SPEC 5.3): a supervisor moves the trip, the open items and cash custody to another person and/or another phone.
 * The trip keeps its stock and sales; only who is accountable (and which phone) changes. @param {any} db @param {any} actor @param {any} p */
export async function handoverTrip(db, actor, p) {
  const [trip] =
    await db`select * from van_trips where id=${uuid(p.tripId)} and deleted_at is null for update`;
  if (!trip) refuse("Trip not found");
  await requireCapability({ db, actor }, "van.load.approve", trip.org_unit_id);
  if (!["loaded", "active", "closing"].includes(trip.status))
    refuse("Only a trip that has been loaded can be handed over");
  if (actor.profileId === trip.salesperson_profile_id)
    throw forbidden("You cannot hand over your own trip");
  const reason = text(p.reason, 200, true);
  let sellerId = trip.salesperson_profile_id;
  let sellerSubject = trip.salesperson_subject;
  if (p.toProfileId && p.toProfileId !== trip.salesperson_profile_id) {
    const person = await crewPerson(db, p.toProfileId, "the new seller");
    if (
      (
        await db`select 1 from van_trips where salesperson_profile_id=${person.id} and service_date=${trip.service_date} and id<>${trip.id} and status not in ('cancelled','closed') and deleted_at is null`
      ).length
    )
      refuse(`${person.name} already has another trip that day`);
    sellerId = person.id;
    sellerSubject = person.user_id;
    await db`update van_trip_crew set ended_at=now(),ended_by=${actor.subject} where trip_id=${trip.id} and role='seller' and ended_at is null`;
    await db`insert into van_trip_crew(trip_id,profile_id,role,source,added_by) values(${trip.id},${person.id},'seller','handover',${actor.subject}) on conflict do nothing`;
  }
  let deviceId = trip.started_device_id;
  if (p.toDeviceId) {
    const [d] =
      await db`select * from registered_devices where id=${uuid(p.toDeviceId)} and app='van-android' and status='active'`;
    if (!d) refuse("Choose a van phone that is set up and working");
    if (d.profile_id !== sellerId)
      refuse("The new phone must belong to the person taking over");
    deviceId = d.id;
  }
  await db`update van_trips set salesperson_profile_id=${sellerId},salesperson_subject=${sellerSubject},started_device_id=${trip.started_device_id ? deviceId : null},updated_at=now() where id=${trip.id}`;
  if (deviceId && trip.started_device_id && deviceId !== trip.started_device_id)
    await db`update van_crew_sessions set ended_at=now(),ended_reason='handed over' where device_id=${trip.started_device_id} and ended_at is null`;
  await audit(db, trip, actor, "van.trip.handed_over", trip.id, {
    reason,
    fromProfileId: trip.salesperson_profile_id,
    toProfileId: sellerId,
    fromDeviceId: trip.started_device_id,
    toDeviceId: deviceId,
  });
  return { tripId: trip.id, sellerProfileId: sellerId, deviceId };
}

/** SPEC 6.10 / 5.3: a helper or driver may sell and collect, but not void a sale or close the trip.
 * Checked from the crew session that was on the phone when the operation was captured. @param {any} db @param {any} device @param {string} opType @param {number} at */
export async function crewGuard(db, device, opType, at) {
  if (!["sale.void", "trip.close"].includes(opType)) return;
  const on = await personOnDevice(db, device.id, at);
  if (on && ["helper", "driver"].includes(on.role))
    refuse(
      `${on.name} is on the phone as ${on.role}. Voiding a sale and closing the trip are for the seller. Switch to the seller first`,
      "forbidden",
    );
}

/** Remember who was on the phone for this operation. @param {any} db @param {any} trip @param {any} device @param {any} op */
export async function recordCrewAction(db, trip, device, op) {
  const at = Number.isFinite(op.clientTime) ? op.clientTime : Date.now();
  const on = await personOnDevice(db, device.id, at);
  await db`insert into van_crew_actions(trip_id,device_id,session_id,profile_id,op_type,client_op_id,occurred_at)
    values(${trip.id},${device.id},${on?.sessionId ?? null},${on?.profileId ?? trip.salesperson_profile_id},${op.opType},${op.clientOpId},${new Date(at)}) on conflict (client_op_id) do nothing`;
}

/** Office list of who worked a trip: crew now and every switch. @param {any} db @param {any} actor @param {string} tripId */
export async function tripCrewDetail(db, actor, tripId) {
  await requireCapability({ db, actor }, "van.read");
  const crew = await crewDirectory(db, uuid(tripId));
  const sessions = await db`select s.id,s.profile_id as "profileId",p.name,s.role,s.method,s.started_at as "startedAt",s.ended_at as "endedAt",s.ended_reason as "endedReason"
    from van_crew_sessions s join profiles p on p.id=s.profile_id where s.trip_id=${tripId} order by s.started_at`;
  const actions = await db`select a.op_type as "opType",a.profile_id as "profileId",p.name,a.occurred_at as "at" from van_crew_actions a join profiles p on p.id=a.profile_id where a.trip_id=${tripId} order by a.occurred_at limit 500`;
  return {
    crew: crew.map((/** @type {any} */ c) => ({ profileId: c.profileId, name: c.name, role: c.role, hasPin: Boolean(c.pinId) })),
    sessions,
    actions,
  };
}
