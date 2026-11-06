import { installExtended } from "./extended.js";
import { expectedCash } from "./cash.js";
import { installZday } from "./zday-routes.js";
import { tillDayForOpen } from "./till-days.js";
import { nextDocNumber } from "../../core/docnum.js";
import { slipCode } from "./cash.js";
import { pinSettings } from "./security.js";
import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { ApiError, forbidden } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import { scopeFilterForActor } from "../org/scope.js";
import {
  integer,
  uuid,
  text,
  choice,
  refuse,
  dayString,
  openingFloat,
} from "../van/model.js";
import { currentActor, currentDeviceActor } from "../van/access.js";
import {
  cashierContext,
  captureTime,
  registerFor,
  shiftView,
} from "./model.js";

/** F-R01 commands are transactional and reauthorize before replay.
 * @param {any} router @param {any} platform */
export function install(router, platform) {
  installExtended(router, platform);
  installZday(router, platform);
  platform.registerTopic("storepos", (/** @type {any} */ a) =>
    roleHas(a.role, "van.read"),
  );
  for (const kind of [
    "store.shift.open",
    "store.shift.close",
    "store.shift.suspend",
    "store.shift.resume",
  ])
    platform.registerOp(kind, async (/** @type {any} */ c) => {
      try {
        const result = await shiftOperation(c);
        await c.change(
          "storepos",
          result.entityId,
          `profile:${c.actor.profileId}`,
        );
        // The handheld's bundle carries the server's view of its sessions: refresh it (acknowledgement).
        await c.change(
          "van.bundle",
          c.actor.profileId,
          `profile:${c.actor.profileId}`,
        );
        c.publish("storepos");
        return result;
      } catch (error) {
        if (error instanceof ApiError)
          throw new OpRejected(
            error.status === 403 ? "out_of_scope" : error.code,
          );
        throw error;
      }
    });
  const commands = {
    "registers/save": saveRegister,
    "cashiers/save": saveCashier,
    "policies/save": savePolicy,
    "mode/set": setMode,
    "shifts/decide": decideShift,
  };
  for (const [path, work] of Object.entries(commands))
    router.post(`/api/v1/storepos/${path}`, async (/** @type {any} */ c) => {
      if (!c.body || typeof c.body !== "object" || Array.isArray(c.body))
        throw new ApiError(
          "invalid_request",
          400,
          "Use an object command body",
        );
      const response = await tx(c.db, async (db) => {
        const actor = await currentActor(db, c.actor);
        await requireCapability(
          { db, actor },
          path === "shifts/decide" ? "van.cash.approve" : "admin.manage",
        );
        await db`select set_config('sunpride.actor',${actor.userId},true)`;
        const key = uuid(c.body.requestKey),
          hash = sha256Hex(canonicalJson({ path, body: c.body }));
        await db`select pg_advisory_xact_lock(hashtextextended(${actor.profileId + key},0))`;
        // Work functions repeat target scope checks on replay, before returning stored data.
        await authorizeTarget(db, actor, path, c.body);
        const [old] =
          await db`select * from store_pos_commands where actor_profile_id=${actor.profileId} and request_key=${key}`;
        if (old) {
          if (old.payload_hash !== hash)
            throw new ApiError(
              "idempotency_conflict",
              409,
              "Request key was reused",
            );
          return old.response;
        }
        const result = await work(db, actor, c.body);
        await db`insert into store_pos_commands(actor_profile_id,request_key,payload_hash,response) values(${actor.profileId},${key},${hash},${result})`;
        await platform.recordChange(db, {
          entity: "storepos",
          entityId: result.id,
          scopeKey: `unit:${actor.orgUnitId}`,
        });
        return result;
      });
      c.publish("storepos");
      c.publish("van");
      return response;
    });
  router.get("/api/v1/storepos/workspace", workspace);
}
/** @param {any} db @param {any} actor @param {string} path @param {any} p */
async function authorizeTarget(db, actor, path, p) {
  if (path === "mode/set") {
    const [device] =
      await db`select * from registered_devices where id=${uuid(p.deviceId)} for update`;
    if (!device || device.app !== "van-android" || device.status !== "active")
      refuse("Choose an active POS handheld");
    await requireCapability({ db, actor }, "admin.manage", device.org_unit_id);
    if (p.registerId) {
      const r = await registerFor(
        db,
        actor,
        uuid(p.registerId),
        "admin.manage",
      );
      if (r.org_unit_id !== device.org_unit_id)
        refuse("Choose a register in the handheld's assigned unit");
    }
  } else if (path === "registers/save") {
    const [l] =
      await db`select * from inventory_locations where id=${uuid(p.locationId)} and type='store' and active and deleted_at is null for share`;
    if (!l) refuse("Choose an active store inventory location");
    await requireCapability({ db, actor }, "admin.manage", l.org_unit_id);
    if (p.id) await registerFor(db, actor, uuid(p.id), "admin.manage");
  } else if (path === "shifts/decide") {
    const [s] =
      await db`select s.register_id,s.cashier_id from store_shift_closures c join store_shifts s on s.id=c.shift_id where c.id=${uuid(p.closureId)}`;
    if (!s) refuse("Choose a submitted count");
    await registerFor(db, actor, s.register_id, "van.cash.approve");
    if (s.cashier_id === actor.profileId)
      throw forbidden("A second person must decide your count");
  } else await registerFor(db, actor, uuid(p.registerId), "admin.manage");
}
/** F-R01. @param {any} db @param {string} registerId */
async function noOpenShift(db, registerId) {
  const [open] =
    await db`select 1 from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.register_id=${registerId} and c.id is null`;
  if (open)
    refuse("Close the register's cashier session before changing its setup");
}
/** F-R01. @param {any} db @param {any} actor @param {any} p */
async function saveRegister(db, actor, p) {
  const id = p.id ? uuid(p.id) : crypto.randomUUID();
  const [old] =
    await db`select * from store_registers where id=${id} for update`;
  if (old) {
    await noOpenShift(db, id);
    if (old.location_id !== p.locationId)
      refuse("A register cannot change inventory location");
  }
  await db`insert into store_registers(id,location_id,terminal_code,name,effective_from) values(${id},${p.locationId},${text(p.terminalCode, 40, true)},${text(p.name, 100, true)},now()) on conflict(id) do update set name=excluded.name,terminal_code=excluded.terminal_code,updated_at=now()`;
  return { id };
}
/** F-R01. @param {any} db @param {any} actor @param {any} p */
async function savePolicy(db, actor, p) {
  const r = await registerFor(db, actor, uuid(p.registerId), "admin.manage");
  await noOpenShift(db, r.id);
  const tolerance = integer(p.toleranceCentavos);
  const [prior] =
    await db`select * from store_register_policies where register_id=${r.id} and effective_to is null`;
  const pin = p.pin
    ? pinSettings(p.pin)
    : {
        salt: prior?.pin_salt ?? null,
        hash: prior?.pin_hash ?? null,
        key: prior?.pin_key ?? null,
      };
  const bps = Number(
    p.employeeDiscountBps ?? prior?.employee_discount_bps ?? 1000,
  );
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000)
    refuse("Set employee discount from 0 to 10000 basis points");
  const [stamp] = await db`select clock_timestamp() as at`;
  await db`update store_register_policies set effective_to=${stamp.at},updated_at=now() where register_id=${r.id} and effective_to is null`;
  const [row] =
    await db`insert into store_register_policies(register_id,tolerance_centavos,effective_from,loyalty_enabled,earn_per_centavos,point_value_centavos,employee_discount_bps,pin_salt,pin_hash,pin_key) values(${r.id},${String(tolerance)},${stamp.at},${p.loyaltyEnabled ?? prior?.loyalty_enabled ?? false},${String(integer(p.earnPerCentavos ?? prior?.earn_per_centavos ?? "10000", true))},${String(integer(p.pointValueCentavos ?? prior?.point_value_centavos ?? "100", true))},${bps},${pin.salt},${pin.hash},${pin.key}) returning id`;
  return { id: row.id };
}
/** F-R01. @param {any} db @param {any} actor @param {any} p */
async function saveCashier(db, actor, p) {
  const r = await registerFor(db, actor, uuid(p.registerId), "admin.manage");
  const [person] =
    await db`select id,org_unit_id,role from profiles where id=${uuid(p.profileId)} and status='active' and deleted_at is null for share`;
  if (
    !person ||
    person.org_unit_id !== r.org_unit_id ||
    !roleHas(person.role, "van.operate")
  )
    refuse("Choose an active POS cashier in the store's unit");
  await noOpenShift(db, r.id);
  if (typeof p.enabled !== "boolean")
    refuse("Choose whether the cashier is assigned");
  const [old] =
    await db`select id from store_cashier_assignments where register_id=${r.id} and profile_id=${person.id} and effective_to is null`;
  if (p.enabled && old) return { id: old.id };
  if (!p.enabled) {
    if (!old) return { id: r.id };
    await db`update store_cashier_assignments set effective_to=clock_timestamp(),updated_at=now() where id=${old.id}`;
    return { id: old.id };
  }
  const [row] =
    await db`insert into store_cashier_assignments(register_id,profile_id,effective_from) values(${r.id},${person.id},clock_timestamp()) returning id`;
  return { id: row.id };
}
/** F-R01: mode changes never strand an acknowledged open session or live van trip.
 * @param {any} db @param {any} actor @param {any} p */
async function setMode(db, actor, p) {
  const mode = choice(p.mode, ["van", "store"]);
  if (typeof p.allowLocalSwitch !== "boolean")
    refuse("Choose whether manager switching is allowed");
  if (p.allowLocalSwitch) {
    const [pin] =
      await db`select pin_hash from store_register_policies where register_id=${uuid(p.registerId)} and effective_from<=now() and (effective_to is null or effective_to>now())`;
    if (!pin?.pin_hash) refuse("Set the register supervisor PIN first");
  }
  const registerId = p.registerId ? uuid(p.registerId) : null;
  if (mode === "store" && !registerId) refuse("Choose a store register");
  if (registerId) {
    await registerFor(db, actor, registerId, "admin.manage");
    await noOpenShift(db, registerId);
  }
  const [open] =
    await db`select 1 from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.device_id=${p.deviceId} and c.id is null`;
  if (open) refuse("Close the cashier session before switching mode");
  const [trip] =
    await db`select 1 from van_trips where started_device_id=${p.deviceId} and status not in ('closed','cancelled') and deleted_at is null`;
  if (trip) refuse("Settle the active van trip before switching mode");
  const [stamp] = await db`select clock_timestamp() as at`;
  await db`update pos_device_modes set effective_to=${stamp.at},updated_at=now() where device_id=${p.deviceId} and effective_to is null`;
  const [row] =
    await db`insert into pos_device_modes(device_id,register_id,mode,effective_from,actor_profile_id,allow_local_switch) values(${p.deviceId},${registerId},${mode},${stamp.at},${actor.profileId},${p.allowLocalSwitch}) returning id`;
  return { id: row.id };
}
/** F-R01: no second stock or commercial ledger. Sales stay unavailable until the shared POS adapter is delivered.
 * @param {any} c */
export async function shiftOperation(c) {
  const { db, payload: p } = c,
    at = captureTime(c);
  const {
    actor,
    device,
    register: r,
    mode,
  } = await cashierContext(db, c.actor, c.device, at);
  await db`select set_config('sunpride.actor',${actor.userId},true)`;
  if (p.registerId !== r.id || p.modeVersionId !== mode.id)
    refuse("Download the register's current configuration");
  const shiftId = uuid(p.shiftId);
  /** @type {string|null} */ let tillDayId = null;
  if (c.op.opType === "store.shift.open") {
    await noOpenShift(db, r.id);
    const [deviceOpen] =
      await db`select 1 from store_shifts s left join store_shift_closures x on x.shift_id=s.id where s.device_id=${device.id} and x.id is null`;
    if (deviceOpen) refuse("This handheld already has an open cashier session");
    const [policy] =
      await db`select * from store_register_policies where id=${uuid(p.policyId)} and register_id=${r.id} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
    if (!policy || +new Date(mode.effective_from) > at)
      refuse("Register policy was not effective at capture time");
    const [previous] =
      await db`select max(c.closed_at) as at from store_shift_closures c join store_shifts s on s.id=c.shift_id where s.register_id=${r.id}`;
    if (previous.at && at < +new Date(previous.at))
      refuse("A session cannot overlap an earlier closed session");
    const day = await tillDayForOpen(db, r, at);
    const number = await nextDocNumber(db, r.organization_id, {
      type: "SHF",
      locationCode: slipCode(r, null),
      at,
    });
    await db`insert into store_shifts(id,register_id,mode_version_id,policy_id,device_id,cashier_id,service_date,opening_centavos,opened_at,till_day_id,doc_number) values(${shiftId},${r.id},${mode.id},${policy.id},${device.id},${actor.profileId},${dayString(day.business_date)},${String(openingFloat(p, "openingFloatCentavos", "openingCentavos"))},${new Date(at)},${day.id},${number})`;
    tillDayId = day.id;
  } else {
    const [s] =
      await db`select * from store_shifts where id=${shiftId} for update`;
    if (
      !s ||
      s.device_id !== device.id ||
      s.cashier_id !== actor.profileId ||
      s.register_id !== r.id
    )
      throw forbidden("This session belongs to another cashier or terminal");
    tillDayId = s.till_day_id;
    if (
      c.op.opType === "store.shift.suspend" ||
      c.op.opType === "store.shift.resume"
    ) {
      const [done] =
        await db`select 1 from store_shift_closures where shift_id=${shiftId}`;
      if (done) refuse("This session is already closed");
      const [lastEvent] =
        await db`select kind from store_session_events where shift_id=${shiftId} order by captured_at desc,created_at desc limit 1`;
      const suspended = lastEvent?.kind === "suspended";
      const suspend = c.op.opType === "store.shift.suspend";
      if (suspend === suspended)
        refuse(
          suspend
            ? "This session is already on hold"
            : "This session is not on hold",
        );
      await db`insert into store_session_events(id,shift_id,kind,reason,actor_profile_id,captured_at) values(${uuid(c.op.clientOpId)},${shiftId},${suspend ? "suspended" : "resumed"},${p.reason ? String(p.reason).slice(0, 300) : null},${actor.profileId},${new Date(at)})`;
      return { entityId: shiftId, eventIds: [s.till_day_id] };
    }
    if (at < +new Date(s.opened_at))
      refuse("Close time must follow opening time");
    const [closed] =
      await db`select 1 from store_shift_closures where shift_id=${shiftId}`;
    if (closed) refuse("This session already has a blind declaration");
    if ("expectedCentavos" in p || "varianceCentavos" in p)
      refuse("Submit only the blind counted amount");
    const [policy] =
      await db`select tolerance_centavos from store_register_policies where id=${s.policy_id}`;
    const [pending] =
      await db`select 1 from store_reversals where shift_id=${s.id} and status='pending'`;
    if (pending) refuse("Decide pending voids/refunds before the blind count");
    const expected = await expectedCash(db, s.id),
      declared = integer(p.declaredCentavos),
      variance = declared - expected;
    const review =
      (variance < 0n ? -variance : variance) >
      BigInt(policy.tolerance_centavos);
    await db`insert into store_shift_closures(id,shift_id,declared_centavos,expected_centavos,variance_centavos,needs_review,closed_at) values(${uuid(c.op.clientOpId)},${s.id},${String(declared)},${String(expected)},${String(variance)},${review},${new Date(at)})`;
  }
  return { entityId: shiftId, eventIds: tillDayId ? [tillDayId] : [] };
}
/** F-R01. @param {any} db @param {any} actor @param {any} p */
async function decideShift(db, actor, p) {
  const [c] =
    await db`select c.* from store_shift_closures c where c.id=${uuid(p.closureId)} for update`;
  if (!c?.needs_review) refuse("This count does not need escalation");
  const [old] =
    await db`select 1 from store_shift_decisions where closure_id=${c.id}`;
  if (old) refuse("This count was already decided");
  const [row] =
    await db`insert into store_shift_decisions(closure_id,actor_profile_id,decision,reason) values(${c.id},${actor.profileId},${choice(p.decision, ["accepted", "investigate"])},${text(p.reason, 300, true)}) returning id`;
  return { id: row.id };
}
/** F-R01 office setup and independent blind-count review. @param {any} c */
async function workspace(c) {
  return tx(c.db, async (db) => {
    const actor = await currentActor(db, c.actor);
    await requireCapability({ db, actor }, "van.read");
    const scope = await scopeFilterForActor(db, actor),
      ids = scope.unitIds?.length
        ? scope.unitIds
        : ["00000000-0000-0000-0000-000000000000"];
    const locations =
      await db`select id,name,org_unit_id from inventory_locations where type='store' and active and deleted_at is null and (${scope.unitIds === null} or org_unit_id in ${db(ids)}) order by name limit 501`;
    const registers =
      await db`select r.id,r.name,r.terminal_code,r.location_id,l.name as store_name, (select tolerance_centavos::text from store_register_policies p where p.register_id=r.id and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now())) as tolerance_centavos from store_registers r join inventory_locations l on l.id=r.location_id where l.active and l.deleted_at is null and (${scope.unitIds === null} or l.org_unit_id in ${db(ids)}) order by l.name,r.name limit 501`;
    const canManage = roleHas(actor.role, "admin.manage");
    const devices = canManage
      ? await db`select d.id,d.inventory_tag as name,d.org_unit_id,m.mode,m.register_id from registered_devices d left join pos_device_modes m on m.device_id=d.id and m.effective_from<=now() and (m.effective_to is null or m.effective_to>now()) where d.app='van-android' and d.status='active' and (${scope.unitIds === null} or d.org_unit_id in ${db(ids)}) order by d.inventory_tag limit 501`
      : [];
    const people = canManage
      ? await db`select id,name,org_unit_id from profiles where status='active' and role='sales' and deleted_at is null and (${scope.unitIds === null} or org_unit_id in ${db(ids)}) order by name limit 501`
      : [];
    const shifts =
      await db`select s.*,r.name as register_name,l.name as store_name,p.name as cashier_name,c.id as closure_id,c.declared_centavos,c.expected_centavos,c.variance_centavos,c.needs_review,c.closed_at,c.kind as closure_kind,d.decision,exists(select 1 from store_session_events e where e.shift_id=s.id and e.kind='suspended' and not exists(select 1 from store_session_events e2 where e2.shift_id=s.id and e2.kind='resumed' and e2.captured_at>e.captured_at)) as suspended from store_shifts s join store_registers r on r.id=s.register_id join inventory_locations l on l.id=r.location_id join profiles p on p.id=s.cashier_id left join store_shift_closures c on c.shift_id=s.id left join store_shift_decisions d on d.closure_id=c.id where l.active and l.deleted_at is null and (${scope.unitIds === null} or l.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or s.cashier_id=${actor.profileId}) order by s.opened_at desc,s.id desc limit 501`;
    return {
      locations: locations.slice(0, 500),
      registers: registers.slice(0, 500),
      devices: devices.slice(0, 500),
      people: people.slice(0, 500),
      shifts: await Promise.all(
        shifts
          .slice(0, 500)
          .map((/** @type {any} */ s) => shiftView(db, actor, s)),
      ),
      canManage,
      truncated: [locations, registers, devices, people, shifts].some(
        (a) => a.length > 500,
      ),
      transactionsEnabled: true,
    };
  });
}
