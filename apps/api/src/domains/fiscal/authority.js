import { requireCapability, ROLES, roleHas } from "../../core/capabilities.js";
import {
  canonicalJson,
  sha256Hex,
  randomToken,
  safeEqual,
} from "../../core/util.js";
import { currentFinancialActor as currentActor } from "./actors.js";
import { actorFor } from "../../core/context.js";
import { uuid, text, choice, integer, refuse } from "../van/model.js";
import { instant } from "./series.js";
import { ApiError } from "../../core/errors.js";
import {
  offlineApprovalGrant,
  offlineApprovalKey,
  verifyOfflineApprovalGrant,
} from "./offline-grants.js";
import { authorize as distributorAccess } from "../distributors/model.js";
export const OVERRIDE_KINDS = ["price", "credit", "stock", "discount", "void"];
/** Hold current profile authority through the financial transaction, including provider awaits.
 * @param {any} db @param {any} actor */
async function holdAuthority(db, actor) {
  const [p] =
    await db`select role,status,org_unit_id,deleted_at from profiles where id=${actor.profileId} for share`;
  if (
    !p ||
    p.status !== "active" ||
    p.deleted_at ||
    p.role !== actor.role ||
    p.org_unit_id !== actor.orgUnitId
  )
    refuse("Authority changed; refresh before this transaction");
}
/** @param {any} db @param {any} actor @param {any} input */
async function liveRequestRule(db, actor, input) {
  try {
    return await authorityRule(db, actor, input);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status !== 401 &&
      error.status !== 403
    )
      throw new ApiError("authority_changed", 409, error.message);
    throw error;
  }
}
/** F-404/F-511 scoped party permission; distributor roles still get ZERO global core capabilities.
 * @param {any} db @param {any} actor @param {string} unit @param {string|null} [kind] */
async function requesterAccess(db, actor, unit, kind = null) {
  if (actor.role !== "distributor")
    return requireCapability(
      { db, actor },
      roleHas(actor.role, "order.create") ? "order.create" : "order.encode",
      uuid(unit),
    );
  if (kind && !["credit", "price", "discount"].includes(kind))
    refuse("Partner authority does not permit this transaction kind");
  const parties =
    await db`select d.id from distributors d join distributor_users u on u.distributor_id=d.id where d.org_unit_id=${uuid(unit)} and d.device_org_unit_id=${actor.orgUnitId} and d.status='accredited' and d.effective_from<=now() and (d.effective_to is null or d.effective_to>now()) and u.profile_id=${actor.profileId} and u.grants @> ARRAY['order']::text[] and u.effective_from<=now() and (u.effective_to is null or u.effective_to>now()) for share of d,u`;
  if (!parties.length)
    refuse("Active distributor order permission is required");
  await distributorAccess({ db, actor }, parties[0].id, "order");
}
/** F-110/F-511: one scoped, effective matrix for native previews; transaction enforcement stays here.
 * @param {any} db @param {any} actor @param {string} orgUnitId @param {Record<string,string|undefined>} env */
export async function authorityContext(db, actor, orgUnitId, env) {
  actor = await currentActor(db, actor);
  await requesterAccess(db, actor, orgUnitId);
  const rules =
    await db`select * from fiscal_authority_rules where org_unit_id=${orgUnitId} and role=${actor.role} and effective_from<=now() and (effective_to is null or effective_to>now()) order by kind,channel,min_centavos limit 201`;
  if (rules.length > 200)
    refuse("Authority matrix is too large; narrow the active rules");
  return {
    profileId: actor.profileId,
    orgUnitId,
    role: actor.role,
    verification: offlineApprovalKey(env),
    rules: rules.map((/** @type {any} */ r) => ({
      id: r.id,
      kind: r.kind,
      channel: r.channel,
      minMinor: String(r.min_centavos),
      maxMinor: String(r.max_centavos),
      selfLimitMinor: String(r.self_limit_centavos),
      offlineAllowed: r.offline_allowed,
      effectiveFrom: new Date(r.effective_from).getTime(),
      effectiveTo: r.effective_to ? new Date(r.effective_to).getTime() : null,
      sample: r.sample,
    })),
  };
}
/** F-110/F-124: requester can collect a verified approval; no second approval engine or secret key.
 * @param {any} db @param {any} actor @param {string} id @param {Record<string,string|undefined>} env */
export async function readOverride(db, actor, id, env) {
  actor = await currentActor(db, actor);
  const [r] =
    await db`select * from fiscal_override_requests where id=${uuid(id)} and requester_id=${actor.profileId}`;
  if (!r) refuse("Override request was not found");
  const rule = await liveRequestRule(db, actor, {
    orgUnitId: r.org_unit_id,
    kind: r.kind,
    channel: r.channel,
    amountCentavos: String(r.amount_centavos),
  });
  if (rule.id !== r.rule_id)
    throw new ApiError(
      "authority_changed",
      409,
      "Discount authority changed; sync before requesting again",
    );
  if (new Date(r.expires_at).getTime() <= Date.now())
    throw new ApiError(
      "approval_expired",
      409,
      "This approval expired; request it again",
    );
  const events =
    await db`select * from fiscal_override_events where request_id=${r.id}`;
  const status = events.some((/** @type {any} */ e) => e.kind === "consumed")
    ? "consumed"
    : events.some((/** @type {any} */ e) => e.kind === "rejected")
      ? "rejected"
      : r.requires_second
        ? "pending"
        : "within_own_limit";
  const approval = events.find((/** @type {any} */ e) => e.kind === "approved");
  if (!approval || status === "consumed" || status === "rejected")
    return { id: r.id, status, grant: null };
  const [profile] =
    await db`select user_id from profiles where id=${approval.actor_profile_id}`;
  const approver = profile
    ? await currentActor(db, await actorFor(db, profile.user_id))
    : null;
  if (
    !approver ||
    approver.profileId === actor.profileId ||
    !rule.approver_roles.includes(approver.role)
  )
    throw new ApiError(
      "approval_withdrawn",
      409,
      "The approver is no longer authorized",
    );
  await requireCapability(
    { db, actor: approver },
    "order.approve",
    r.org_unit_id,
  );
  return {
    id: r.id,
    status: "approved",
    grant: offlineApprovalGrant(
      env,
      r,
      approver.profileId,
      rule.offline_allowed && approval.code_hash ? "offline" : "live",
    ),
  };
}
/** F-124/F-511. No ambiguous or absent rule can grant authority. @param {any} db @param {any} actor @param {any} p */
export async function authorityRule(db, actor, p) {
  await requesterAccess(db, actor, p.orgUnitId, p.kind);
  const amount = integer(p.amountCentavos);
  const rules =
    await db`select * from fiscal_authority_rules where org_unit_id=${p.orgUnitId} and kind=${choice(p.kind, OVERRIDE_KINDS)} and role=${actor.role} and channel in (${text(p.channel, 50, true)},'*') and min_centavos<=${String(amount)} and max_centavos>=${String(amount)} and effective_from<=now() and (effective_to is null or effective_to>now()) order by (channel='*') for share`;
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
  actor = await currentActor(db, actor);
  if (
    p.expectedRequesterId !== undefined &&
    p.expectedRequesterId !== actor.profileId
  )
    refuse("The approval account changed");
  const rule = await liveRequestRule(db, actor, p),
    id = uuid(p.id);
  const reason = text(p.reason, 300, true);
  if (
    !p.facts ||
    typeof p.facts !== "object" ||
    Array.isArray(p.facts) ||
    canonicalJson(p.facts).length > 100000
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
  const second =
    p.forceSecond === true ||
    integer(p.amountCentavos) > BigInt(rule.self_limit_centavos);
  await db`insert into fiscal_override_requests(id,rule_id,org_unit_id,requester_id,kind,channel,amount_centavos,facts,facts_hash,reason,requires_second,expires_at)
   values(${id},${rule.id},${p.orgUnitId},${actor.profileId},${p.kind},${p.channel},${p.amountCentavos},${p.facts},${factsHash},${reason},${second},${new Date(Date.now() + 86400000)})`;
  return { id, requiresSecond: second };
}
/** @param {any} db @param {any} actor @param {any} p @param {Record<string,string|undefined>} [env] */
export async function decideOverride(db, actor, p, env) {
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
  return {
    id: r.id,
    decision: kind,
    offlineCode: code,
    ...(code && env
      ? { offlineGrant: offlineApprovalGrant(env, r, actor.profileId) }
      : {}),
  };
}
/** F-511 point-of-transaction enforcement. Only exact approved facts may be consumed, once.
 * @param {any} db @param {any} actor @param {any} p @param {Record<string,string|undefined>} [env] */
export async function enforceAuthority(db, actor, p, env = process.env) {
  actor = await currentActor(db, actor);
  await holdAuthority(db, actor);
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
    (p.reason !== undefined && text(p.reason, 300, true) !== r.reason) ||
    new Date(r.expires_at).getTime() <= Date.now()
  )
    refuse("Request an override for these exact transaction facts");
  const events =
    await db`select * from fiscal_override_events where request_id=${r.id}`;
  const used = events.find((/** @type {any} */ e) => e.kind === "consumed");

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
    await holdAuthority(db, approver);
    await requireCapability(
      { db, actor: approver },
      "order.approve",
      r.org_unit_id,
    );
    const portable =
      typeof p.offlineCode === "string" &&
      p.offlineCode.startsWith("SP-APPROVAL1.")
        ? verifyOfflineApprovalGrant(env, p.offlineCode)
        : null;
    if (
      portable &&
      (portable.requestId !== r.id ||
        portable.ruleId !== r.rule_id ||
        portable.factsHash !== r.facts_hash ||
        portable.reasonHash !== sha256Hex(r.reason) ||
        portable.requesterId !== actor.profileId ||
        portable.approverId !== approval.actor_profile_id ||
        portable.orgUnitId !== r.org_unit_id ||
        portable.kind !== r.kind ||
        portable.channel !== r.channel ||
        portable.amountCentavos !== String(r.amount_centavos) ||
        portable.expiresAt > new Date(r.expires_at).getTime())
    )
      refuse("Offline approval does not match this transaction");
    if (
      p.offlineCode &&
      ((portable?.mode !== "live" &&
        (!rule.offline_allowed || !approval.code_hash)) ||
        (!portable && !safeEqual(sha256Hex(p.offlineCode), approval.code_hash)))
    )
      refuse("Offline authorization code is invalid");
  }
  if (used) {
    if (used.operation_id !== p.operationId)
      refuse("Override was already consumed");
    return { overrideId: r.id };
  }
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
