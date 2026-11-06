import { createHmac, pbkdf2Sync, createHash, timingSafeEqual } from "node:crypto";
import { tx } from "@sunpride/db/client";
import { ApiError, forbidden } from "../../core/errors.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { actorFor } from "../../core/context.js";
import { currentActor } from "../van/access.js";
import { uuid, refuse, text, choice } from "../van/model.js";
import { pinSettings } from "./security.js";

/** Override kinds (SPEC 7.2) plus the cash and day-end ones that also need a supervisor. */
export const OVERRIDE_KINDS = [
  "void_line",
  "void_sale",
  "refund",
  "price",
  "discount",
  "reprint",
  "no_sale",
  "cash_drop",
  "cash_pickup",
  "paid_out",
  "z_reading",
  "force_close",
];
export const OVERRIDE_LABELS = /** @type {Record<string,string>} */ ({
  void_line: "Line void",
  void_sale: "Sale void",
  refund: "Refund",
  price: "Price change",
  discount: "Discount",
  reprint: "Reprint",
  no_sale: "No sale (open drawer)",
  cash_drop: "Cash drop",
  cash_pickup: "Cash pickup",
  paid_out: "Paid out",
  z_reading: "Z reading",
  force_close: "Forced close",
});
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;

/** The text both the phone and the server sign. Binds the proof to ONE action so a PIN entry cannot be replayed.
 * @param {{kind:string, refId:string, shiftId?:string|null, amountCentavos?:string|null, pinId:string}} m */
export function overrideMessage(m) {
  return `override|${m.kind}|${m.refId}|${m.shiftId ?? ""}|${m.amountCentavos ?? "0"}|${m.pinId}`;
}
/** @param {string} keyHex @param {Parameters<typeof overrideMessage>[0]} m */
export function overrideProof(keyHex, m) {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(overrideMessage(m))
    .digest("hex");
}

/** Office sets or rotates ONE supervisor's own PIN. History is kept; the old row simply ends.
 * @param {any} db @param {any} actor @param {any} p */
export async function setSupervisorPin(db, actor, p) {
  const profileId = uuid(p.profileId);
  const [person] =
    await db`select id,name,role,org_unit_id from profiles where id=${profileId} and status='active' and deleted_at is null for update`;
  if (!person || !roleHas(person.role, "van.cash.approve"))
    refuse("Choose an active supervisor who can approve cash");
  await requireCapability({ db, actor }, "admin.manage", person.org_unit_id);
  if (person.id === actor.profileId && actor.role !== "super_admin")
    refuse("Ask another administrator to set your PIN");
  const pin = pinSettings(String(p.pin ?? ""));
  const [stamp] = await db`select clock_timestamp() as at`;
  await db`update store_supervisor_pins set effective_to=${stamp.at},updated_at=now() where profile_id=${person.id} and effective_to is null`;
  const [row] =
    await db`insert into store_supervisor_pins(profile_id,pin_salt,pin_hash,pin_key,effective_from,set_by) values(${person.id},${pin.salt},${pin.hash},${pin.key},${stamp.at},${actor.profileId}) returning id`;
  await db`delete from store_supervisor_pin_attempts where profile_id=${person.id}`;
  return { id: row.id };
}

/** Supervisors that have a current PIN and can approve at this register. Only one-way verifiers leave the server.
 * @param {any} db @param {any} register */
export async function supervisorDirectory(db, register) {
  const rows =
    await db`select k.id as pin_id,k.profile_id,k.pin_salt,k.pin_hash,p.name,p.role,p.user_id,p.org_unit_id from store_supervisor_pins k join profiles p on p.id=k.profile_id where k.effective_from<=now() and k.effective_to is null and p.status='active' and p.deleted_at is null order by p.name limit 200`;
  const out = [];
  for (const r of rows) {
    if (!roleHas(r.role, "van.cash.approve")) continue;
    if (!(await inRegisterScope(db, r, register))) continue;
    out.push({
      profileId: r.profile_id,
      name: r.name,
      pinId: r.pin_id,
      salt: r.pin_salt,
      hash: r.pin_hash,
    });
  }
  return out;
}
/** @param {any} db @param {any} person @param {any} register */
async function inRegisterScope(db, person, register) {
  try {
    const a = await actorFor(db, person.user_id);
    if (!a) return false;
    await requireCapability({ db, actor: a }, "van.cash.approve", register.org_unit_id);
    return true;
  } catch {
    return false;
  }
}

/** Office list: who has a PIN and since when. Never the verifier. @param {any} db @param {any} actor */
export async function listSupervisors(db, actor) {
  await requireCapability({ db, actor }, "admin.manage");
  const rows =
    await db`select p.id,p.name,p.role,p.org_unit_id,k.effective_from as pin_set_at from profiles p left join store_supervisor_pins k on k.profile_id=p.id and k.effective_to is null where p.status='active' and p.deleted_at is null order by p.name limit 501`;
  return rows
    .filter((/** @type {any} */ r) => roleHas(r.role, "van.cash.approve"))
    .slice(0, 500)
    .map((/** @type {any} */ r) => ({
      profileId: r.id,
      name: r.name,
      hasPin: Boolean(r.pin_set_at),
      pinSetAt: r.pin_set_at ? +new Date(r.pin_set_at) : null,
    }));
}

/** Online check: counts the attempt BEFORE checking the PIN (outside the business transaction so a refusal still counts),
 * locks the supervisor for 10 minutes after 5 misses in 10 minutes.
 * @param {any} rawDb @param {string} profileId */
async function reserveAttempt(rawDb, profileId) {
  const outcome = await tx(rawDb, async (/** @type {any} */ db) => {
    const [a] =
      await db`select * from store_supervisor_pin_attempts where profile_id=${profileId} for update`;
    const now = Date.now();
    if (a?.locked_until && +new Date(a.locked_until) > now)
      return { locked: +new Date(a.locked_until) - now };
    const fresh = a && now - +new Date(a.window_started_at) < WINDOW_MS;
    const count = fresh ? a.failed_count + 1 : 1;
    const start = fresh ? a.window_started_at : new Date(now);
    const lockUntil = count > MAX_FAILURES ? new Date(now + LOCK_MS) : null;
    await db`insert into store_supervisor_pin_attempts(profile_id,failed_count,window_started_at,locked_until) values(${profileId},${count},${start},${lockUntil}) on conflict(profile_id) do update set failed_count=excluded.failed_count,window_started_at=excluded.window_started_at,locked_until=excluded.locked_until`;
    return lockUntil ? { locked: LOCK_MS } : { locked: 0 };
  });
  if (outcome.locked)
    throw new ApiError(
      "rate_limited",
      429,
      "Too many wrong PINs. Wait 10 minutes or ask the office to reset it.",
    );
}

/** POST storepos/overrides/verify: the cashier's handheld is online. The server checks the supervisor's PIN and signs
 * the ONE action with that supervisor's key, so the op that follows carries the same proof an offline check produces.
 * @param {any} c route context (c.db is the pool) */
export async function verifyOnline(c) {
  const p = c.body;
  if (!p || typeof p !== "object" || Array.isArray(p))
    refuse("Use an object command body");
  const supervisorId = uuid(p.supervisorProfileId);
  const kind = choice(p.kind, OVERRIDE_KINDS);
  const refId = String(text(p.refId, 100, true));
  await reserveAttempt(c.db, supervisorId);
  const answer = await tx(c.db, async (/** @type {any} */ db) => {
    const { currentDeviceActor } = await import("../van/access.js");
    const fresh = await currentDeviceActor(db, c.actor, uuid(p.deviceId));
    const { modeAt, registerFor } = await import("./model.js");
    const mode = await modeAt(db, fresh.device.id);
    if (mode?.mode !== "store" || !mode.register_id)
      refuse("This handheld is not in Store mode");
    const register = await registerFor(db, fresh.actor, mode.register_id, "van.operate");
    const sup = await supervisorFor(db, supervisorId, register, Date.now());
    if (sup.profile.id === fresh.actor.profileId)
      throw forbidden("A supervisor cannot approve their own action");
    const pin = String(p.pin ?? "");
    if (!/^\d{6,12}$/.test(pin)) refuse("Enter the supervisor PIN");
    const hash = createHash("sha256")
      .update(pbkdf2Sync(pin, sup.pin.pin_salt, 160000, 32, "sha256"))
      .digest();
    const stored = Buffer.from(sup.pin.pin_hash, "hex");
    if (stored.length !== hash.length || !timingSafeEqual(hash, stored))
      refuse("Supervisor PIN was not accepted");
    const m = {
      kind,
      refId,
      shiftId: p.shiftId ? uuid(p.shiftId) : null,
      amountCentavos: p.amountCentavos ? String(p.amountCentavos) : "0",
      pinId: sup.pin.id,
    };
    return {
      supervisorProfileId: sup.profile.id,
      supervisorName: sup.profile.name,
      pinId: sup.pin.id,
      proof: overrideProof(sup.pin.pin_key, m),
      method: "pin_online",
    };
  });
  await c.db`delete from store_supervisor_pin_attempts where profile_id=${supervisorId}`;
  return answer;
}

/** Supervisor identity at a moment: active, can approve cash, in scope of the register, with a PIN valid then.
 * @param {any} db @param {string} profileId @param {any} register @param {number} at @param {string} [pinId] */
async function supervisorFor(db, profileId, register, at, pinId) {
  const [profile] =
    await db`select id,user_id,name,role,org_unit_id,status,deleted_at from profiles where id=${profileId}`;
  if (!profile || profile.status !== "active" || profile.deleted_at)
    refuse("That supervisor is not active");
  const base = await actorFor(db, profile.user_id);
  if (!base) refuse("That supervisor is not active");
  const sup = await currentActor(db, base);
  await requireCapability({ db, actor: sup }, "van.cash.approve", register.org_unit_id);
  const when = new Date(at);
  const [pin] = pinId
    ? await db`select * from store_supervisor_pins where id=${pinId} and profile_id=${profileId} and effective_from<=${when} and (effective_to is null or effective_to>${when})`
    : await db`select * from store_supervisor_pins where profile_id=${profileId} and effective_from<=now() and effective_to is null`;
  if (!pin) refuse("That supervisor has no PIN set for this time");
  return { profile, actor: sup, pin };
}

/**
 * Check a supervisor's signed approval carried by an op (offline or online-signed) and write the override log row.
 * The proof must match the supervisor's PIN key AS IT WAS when the cashier captured it; the supervisor must still
 * be active, in scope and allowed to approve now (re-check on sync).
 * @param {any} c store op context (db, actor, register, shift, now)
 * @param {{kind:string, refType:string, refId:string, amountCentavos?:string|null, reason?:string|null, required?:boolean, tillDayId?:string|null, overrideId?:string}} need
 * @returns {Promise<null | {overrideId:string, supervisor:any, supervisorProfileId:string}>}
 */
export async function useSupervisor(c, need) {
  const { db, register, shift, payload: p } = c;
  const given = p.supervisor;
  if (!given) {
    if (need.required)
      refuse("A supervisor must approve this with their PIN", "forbidden");
    return null;
  }
  if (typeof given !== "object") refuse("Supervisor approval is malformed");
  const profileId = uuid(given.profileId),
    pinId = uuid(given.pinId);
  if (typeof given.proof !== "string" || !/^[a-f0-9]{64}$/.test(given.proof))
    refuse("Supervisor approval is malformed");
  const sup = await supervisorFor(db, profileId, register, c.now, pinId);
  if (sup.profile.id === c.actor.profileId)
    throw forbidden("A supervisor cannot approve their own action");
  const expected = overrideProof(sup.pin.pin_key, {
    kind: need.kind,
    refId: need.refId,
    shiftId: shift?.id ?? null,
    amountCentavos: need.amountCentavos ?? "0",
    pinId,
  });
  const a = Buffer.from(expected, "hex"),
    b = Buffer.from(given.proof, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b))
    refuse("Supervisor approval was not accepted", "forbidden");
  const method = given.method === "pin_online" ? "pin_online" : "pin_offline";
  const overrideId = need.overrideId ?? uuid(c.op.clientOpId);
  await db`insert into store_overrides(id,register_id,till_day_id,shift_id,kind,method,supervisor_profile_id,supervisor_pin_id,cashier_profile_id,reason,amount_centavos,ref_type,ref_id,captured_at) values(${overrideId},${register.id},${need.tillDayId ?? shift?.till_day_id ?? null},${shift?.id ?? null},${need.kind},${method},${sup.profile.id},${pinId},${c.actor.profileId},${need.reason ? text(need.reason, 300) : null},${need.amountCentavos ?? null},${need.refType},${need.refId},${new Date(c.now)})`;
  return { overrideId, supervisor: sup.actor, supervisorProfileId: sup.profile.id };
}

/** Office actions that are themselves the supervisor's decision (force close, Z on the web).
 * @param {any} db @param {any} register @param {any} actor @param {{kind:string, tillDayId?:string|null, shiftId?:string|null, refType:string, refId:string, reason?:string|null, amountCentavos?:string|null, cashierProfileId?:string|null}} o */
export async function logOfficeOverride(db, register, actor, o) {
  const id = crypto.randomUUID();
  await db`insert into store_overrides(id,register_id,till_day_id,shift_id,kind,method,supervisor_profile_id,cashier_profile_id,reason,amount_centavos,ref_type,ref_id,captured_at) values(${id},${register.id},${o.tillDayId ?? null},${o.shiftId ?? null},${o.kind},'office',${actor.profileId},${o.cashierProfileId ?? null},${o.reason ? text(o.reason, 300) : null},${o.amountCentavos ?? null},${o.refType},${o.refId},now())`;
  return id;
}

/** Office review list, newest first. @param {any} db @param {any} actor @param {{registerId?:string|null, kind?:string|null, from?:string|null, to?:string|null, scopeUnitIds:string[]|null}} q */
export async function listOverrides(db, actor, q) {
  const ids = q.scopeUnitIds ?? [];
  const rows =
    await db`select o.*,r.name as register_name,sup.name as supervisor_name,cash.name as cashier_name,d.business_date::text as business_date from store_overrides o join store_registers r on r.id=o.register_id join inventory_locations l on l.id=r.location_id join profiles sup on sup.id=o.supervisor_profile_id left join profiles cash on cash.id=o.cashier_profile_id left join store_till_days d on d.id=o.till_day_id where (${q.scopeUnitIds === null} or l.org_unit_id in ${db(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])}) and (${q.registerId ?? null}::uuid is null or o.register_id=${q.registerId ?? null}) and (${q.kind ?? null}::text is null or o.kind=${q.kind ?? null}) and (${q.from ?? null}::date is null or (o.captured_at at time zone 'Asia/Manila')::date>=${q.from ?? null}::date) and (${q.to ?? null}::date is null or (o.captured_at at time zone 'Asia/Manila')::date<=${q.to ?? null}::date) order by o.captured_at desc,o.id desc limit 501`;
  return rows.slice(0, 500).map((/** @type {any} */ o) => ({
    id: o.id,
    registerId: o.register_id,
    registerName: o.register_name,
    businessDate: o.business_date,
    kind: o.kind,
    label: OVERRIDE_LABELS[o.kind] ?? o.kind,
    method: o.method,
    supervisorName: o.supervisor_name,
    cashierName: o.cashier_name,
    reason: o.reason,
    amountCentavos: o.amount_centavos == null ? null : String(o.amount_centavos),
    refType: o.ref_type,
    refId: o.ref_id,
    capturedAt: +new Date(o.captured_at),
  }));
}
