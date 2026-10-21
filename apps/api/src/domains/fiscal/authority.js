import { requireCapability, ROLES, roleHas } from "../../core/capabilities.js";
import {
  canonicalJson,
  sha256Hex,
  randomToken,
  safeEqual,
} from "../../core/util.js";
import { currentActor } from "../van/access.js";
import { actorFor } from "../../core/context.js";
import { uuid, text, choice, integer, refuse } from "../van/model.js";
import { instant } from "./series.js";
export const OVERRIDE_KINDS = ["price", "credit", "stock", "discount", "void"];
/** F-410: a portal principal is governed by its effective partner membership, not employee history.
 * Native employees retain the stricter assignment guard. @param {any} db @param {any} actor @param {any} p */
export async function currentFiscalActor(db, actor, p) {
  if (actor?.role !== "distributor") return currentActor(db, actor);
  const [valid] =
    await db`select p.id from profiles p join users u on u.id=p.user_id where p.id=${actor.profileId} and p.user_id=${actor.userId} and p.role='distributor' and p.org_unit_id=${actor.orgUnitId} and p.status='active' and p.deleted_at is null and u.disabled_at is null for share of p,u`;
  if (!valid) refuse("Your distributor access changed");
  const { authorize } = await import("../distributors/model.js");
  await db`select id from distributors where id=${uuid(p.distributorId)} for share`;
  await authorize({ db, actor }, p.distributorId, "order");
  return actor;
}
/** F-124/F-511. No ambiguous or absent rule can grant authority. @param {any} db @param {any} actor @param {any} p */
export async function authorityRule(db, actor, p) {
  if (actor.role === "distributor") {
    const { authorize } = await import("../distributors/model.js");
    const distributor = await authorize(
      { db, actor },
      uuid(p.distributorId),
      "order",
    );
    if (distributor.org_unit_id !== uuid(p.orgUnitId))
      refuse("Distributor authority belongs to another supervising area");
  } else
    await requireCapability(
      { db, actor },
      roleHas(actor.role, "order.create") ? "order.create" : "order.encode",
      uuid(p.orgUnitId),
    );
  const amount = integer(p.amountCentavos);
  const rules =
    await db`select * from fiscal_authority_rules where org_unit_id=${p.orgUnitId} and kind=${choice(p.kind, OVERRIDE_KINDS)} and role=${actor.role} and channel in (${text(p.channel, 50, true)},'*') and min_centavos<=${String(amount)} and max_centavos>=${String(amount)} and effective_from<=now() and (effective_to is null or effective_to>now()) order by (channel='*')`;
  const exact = rules.filter((/** @type {any} */ r) => r.channel === p.channel);
  const candidates = exact.length ? exact : rules;
  if (candidates.length !== 1)
    refuse(
      "Authority policy is missing or ambiguous; ask the office to configure it",
    );
  return candidates[0];
}
/** F-124 public seam. Caller owns transaction; facts must include original/proposed document facts.
 * @param {any} db @param {any} actor @param {any} p */
export async function requestOverride(db, actor, p) {
  actor = await currentFiscalActor(db, actor, p);
  const rule = await authorityRule(db, actor, p),
    id = uuid(p.id);
  const reason = text(p.reason, 300, true);
  if (
    !p.facts ||
    typeof p.facts !== "object" ||
    Array.isArray(p.facts) ||
    canonicalJson(p.facts).length > 10000
  )
    refuse("Supply bounded original and proposed facts");
  const factsHash = sha256Hex(canonicalJson(p.facts));
  const [prior] =
    await db`select * from fiscal_override_requests where id=${id}`;
  if (prior) {
    if (
      prior.requester_id !== actor.profileId ||
      prior.facts_hash !== factsHash ||
      prior.reason !== reason ||
      prior.kind !== p.kind ||
      prior.channel !== p.channel ||
      String(prior.amount_centavos) !== p.amountCentavos ||
      prior.org_unit_id !== p.orgUnitId
    )
      refuse("Override key was reused with different facts");
    return { id, requiresSecond: prior.requires_second };
  }
  const second = integer(p.amountCentavos) > BigInt(rule.self_limit_centavos);
  await db`insert into fiscal_override_requests(id,rule_id,org_unit_id,requester_id,kind,channel,amount_centavos,facts,facts_hash,reason,requires_second,expires_at)
   values(${id},${rule.id},${p.orgUnitId},${actor.profileId},${p.kind},${p.channel},${p.amountCentavos},${p.facts},${factsHash},${reason},${second},${new Date(Date.now() + 86400000)})`;
  return { id, requiresSecond: second };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function decideOverride(db, actor, p) {
  actor = await currentActor(db, actor);
  const [r] =
    await db`select * from fiscal_override_requests where id=${uuid(p.id)} for update`;
  if (!r) refuse("Override request not found");
  await requireCapability({ db, actor }, "order.approve", r.org_unit_id);
  if (r.requester_id === actor.profileId)
    refuse("A second person must approve this override");
  const [rule] =
    await db`select * from fiscal_authority_rules where id=${r.rule_id} and effective_from<=now() and (effective_to is null or effective_to>now()) for share`;
  if (
    !rule ||
    !rule.approver_roles.includes(actor.role) ||
    new Date(r.expires_at).getTime() <= Date.now()
  )
    refuse("This approver or request is no longer authorized");
  const [done] =
    await db`select id from fiscal_override_events where request_id=${r.id} and kind in ('approved','rejected')`;
  if (done) refuse("Override already decided");
  const kind = choice(p.decision, ["approved", "rejected"]),
    reason = text(p.reason, 300, true);
  const code =
    kind === "approved" && p.offline === true && rule.offline_allowed
      ? randomToken("OV-")
      : null;
  if (p.offline === true && !code)
    refuse("This policy does not permit offline pre-authorization");
  await db`insert into fiscal_override_events(request_id,kind,actor_profile_id,reason,code_hash) values(${r.id},${kind},${actor.profileId},${reason},${code ? sha256Hex(code) : null})`;
  return { id: r.id, decision: kind, offlineCode: code };
}
/** F-511 point-of-transaction enforcement. Only exact approved facts may be consumed, once.
 * @param {any} db @param {any} actor @param {any} p @param {{consume?:boolean}} [options] */
export async function enforceAuthority(db, actor, p, options = {}) {
  actor = await currentFiscalActor(db, actor, p);
  const rule = await authorityRule(db, actor, p);
  const [r] =
    await db`select * from fiscal_override_requests where id=${uuid(p.overrideId)} for update`;
  if (
    !r ||
    r.requester_id !== actor.profileId ||
    r.rule_id !== rule.id ||
    r.org_unit_id !== p.orgUnitId ||
    r.kind !== p.kind ||
    r.channel !== p.channel ||
    BigInt(r.amount_centavos) !== integer(p.amountCentavos) ||
    r.facts_hash !== sha256Hex(canonicalJson(p.facts)) ||
    new Date(r.expires_at).getTime() <= Date.now()
  )
    refuse("Request an override for these exact transaction facts");
  const events =
    await db`select * from fiscal_override_events where request_id=${r.id}`;
  const used = events.find((/** @type {any} */ e) => e.kind === "consumed");
  if (used) {
    if (used.operation_id !== p.operationId)
      refuse("Override was already consumed");
    return { overrideId: r.id };
  }
  if (events.some((/** @type {any} */ e) => e.kind === "rejected"))
    refuse("Override was refused");
  if (r.requires_second) {
    const approval = events.find(
      (/** @type {any} */ e) => e.kind === "approved",
    );
    if (!approval || approval.actor_profile_id === actor.profileId)
      refuse("A second approver is required");
    const [profile] =
      await db`select user_id from profiles where id=${approval.actor_profile_id} for share`;
    const approver = profile
      ? await currentActor(db, await actorFor(db, profile.user_id))
      : null;
    if (!approver || !rule.approver_roles.includes(approver.role))
      refuse("The approver's authority changed");
    await requireCapability(
      { db, actor: approver },
      "order.approve",
      r.org_unit_id,
    );
    if (
      p.offlineCode &&
      (!rule.offline_allowed ||
        !approval.code_hash ||
        !safeEqual(sha256Hex(p.offlineCode), approval.code_hash))
    )
      refuse("Offline authorization code is invalid");
  }
  if (options.consume !== false)
    await db`insert into fiscal_override_events(request_id,kind,actor_profile_id,reason,operation_id) values(${r.id},'consumed',${actor.profileId},${r.reason},${uuid(p.operationId)})`;
  return { overrideId: r.id };
}
/** F-511 effective-dated policy editor. @param {any} db @param {any} actor @param {any} p */
export async function saveRule(db, actor, p) {
  actor = await currentActor(db, actor);
  await requireCapability({ db, actor }, "admin.manage", uuid(p.orgUnitId));
  const roles = p.approverRoles;
  if (
    !Array.isArray(roles) ||
    !roles.length ||
    roles.some(
      (r) =>
        !ROLES.includes(r) ||
        ["sales", "viewer", "analyst", "operations", "admin"].includes(r),
    )
  )
    refuse("Choose authorized approval roles");
  const min = integer(p.minCentavos),
    max = integer(p.maxCentavos),
    limit = integer(p.selfLimitCentavos);
  if (max < min) refuse("Value band is inverted");
  const from = instant(p.effectiveFrom),
    to = p.effectiveTo ? instant(p.effectiveTo) : null;
  if (to && to <= from) refuse("Policy end must follow start");
  await db`select pg_advisory_xact_lock(hashtext(${p.orgUnitId + ":" + p.kind + ":" + p.role + ":" + p.channel}))`;
  if (p.replacesId) {
    const [old] =
      await db`select * from fiscal_authority_rules where id=${uuid(p.replacesId)} for update`;
    if (
      !old ||
      old.org_unit_id !== p.orgUnitId ||
      new Date(old.effective_from) >= from ||
      from < new Date()
    )
      refuse("Replace a policy prospectively in the same branch");
    await db`update fiscal_authority_rules set effective_to=${from},updated_at=now() where id=${old.id}`;
  }
  const overlaps =
    await db`select id from fiscal_authority_rules where org_unit_id=${p.orgUnitId} and kind=${choice(p.kind, OVERRIDE_KINDS)} and role=${choice(p.role, [...ROLES])} and channel=${text(p.channel, 50, true)} and min_centavos<=${String(max)} and max_centavos>=${String(min)} and effective_from<coalesce(${to}::timestamptz,'infinity'::timestamptz) and coalesce(effective_to,'infinity'::timestamptz)>${from}`;
  if (overlaps.length)
    refuse("Authority bands and effective periods must not overlap");
  const [sample] =
    await db`select exists(select 1 from sample_data_rows where table_name='org_units' and row_id=${p.orgUnitId}) as marked`;
  const [r] =
    await db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,effective_to,sample)
    values(${p.orgUnitId},${p.kind},${p.role},${p.channel},${String(min)},${String(max)},${String(limit)},${roles},${p.offlineAllowed === true},${from},${to},${sample.marked}) returning id`;
  if (sample.marked)
    await db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-fiscal-sample','fiscal_authority_rules',${r.id},${"fiscal_authority_rules:" + r.id}) on conflict(batch,key) do nothing`;
  return { id: r.id };
}
