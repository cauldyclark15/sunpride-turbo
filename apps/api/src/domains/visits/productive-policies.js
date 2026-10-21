import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { hooks } from "../../core/hooks.js";
import { canonicalJson } from "../../core/util.js";
import {
  employeeAt,
  localDate,
  required,
  uuid,
  dto,
  fail,
} from "../coverage/model.js";
import {
  DEFAULT_PRODUCTIVE_RULE,
  PRODUCTIVE_CODES,
  RULE_VERSION,
} from "./productive.js";

/** F-208: published definitions are immutable; replacement closes only applicability.
 * @param {any} v */
export const productiveHash = (v) =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(v)).digest("hex");
/** @param {any} value */
export function productiveDefinition(value) {
  if (
    !value ||
    !["any_listed_activity", "truck_seller"].includes(value.rule) ||
    !["any", "all"].includes(value.matchMode) ||
    value.requiresPlanned !== true ||
    !Array.isArray(value.allowedCodes) ||
    !value.allowedCodes.length ||
    value.allowedCodes.length > PRODUCTIVE_CODES.length ||
    new Set(value.allowedCodes).size !== value.allowedCodes.length ||
    value.allowedCodes.some(
      (/** @type {any} */ c) => !PRODUCTIVE_CODES.includes(c),
    )
  )
    fail("Choose an explicit productive-call rule and qualifying activities");
  return {
    rule: value.rule,
    matchMode: value.matchMode,
    requiresPlanned: true,
    allowedCodes: [...value.allowedCodes].sort(),
  };
}
/** @param {any} p */
function assertStoredPolicy(p) {
  const d = p.definition;
  productiveDefinition(d);
  if (
    productiveHash(d) !== p.content_hash ||
    d.orgUnitId !== p.org_unit_id ||
    d.positionId !== p.position_id ||
    d.channelKey !== p.channel_key ||
    d.definitionKey !== p.definition_key ||
    d.version !== p.version ||
    d.label !== p.label ||
    d.sourceRef !== p.source_ref ||
    d.effectiveFrom !== +new Date(p.effective_from) ||
    (d.effectiveTo !== null &&
      (!p.effective_to || +new Date(p.effective_to) > d.effectiveTo))
  )
    fail("Published productive-call definition changed");
}
/** Resolve at the captured call instant, not sync time or today's position standard.
 * A publication made after an offline call cannot rewrite that call's definition.
 * @param {any} db @param {string} profileId @param {number} at */
export async function snapshotProductivePolicy(
  db,
  profileId,
  at,
  /** @type {any} */ scopedPerson = null,
) {
  const person = scopedPerson ?? (await employeeAt(db, profileId, at));
  // SEAM(MASTERS): dated channel history is not available here. Apply unit/position
  // history only; never guess a past call's channel from today's profile.
  const rows =
    await db`select p.*,a.name as approver from productive_call_policies p join profiles a on a.id=p.approved_by where p.org_unit_id=${person.org_unit_id} and p.status='published' and p.effective_from<=${new Date(at)} and (p.effective_to is null or p.effective_to>${new Date(at)}) and p.approved_at<=${new Date(at)} and (p.position_id is null or p.position_id=${person.position_id}) limit 2`;
  if (rows.some((/** @type {any} */ p) => p.channel_key !== null))
    fail(
      "Channel-specific definitions need the effective master-history adapter",
    );
  if (rows.length > 1)
    fail("Productive-call applicability is ambiguous; contact the office");
  if (rows.length) {
    const p = rows[0];
    assertStoredPolicy(p);
    return {
      ...p.definition,
      policyId: p.id,
      definitionKey: p.definition_key,
      version: p.version,
      label: p.label,
      contentHash: p.content_hash,
      source: "published",
      sourceRef: p.source_ref,
      approvedBy: p.approver,
      approvedAt: +new Date(p.approved_at),
      effectiveFrom: +new Date(p.effective_from),
      effectiveTo: p.effective_to ? +new Date(p.effective_to) : null,
    };
  }
  const standards = person.position_id
    ? await db`select productive_call_rule from position_standards where position_id=${person.position_id} and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) limit 2`
    : [];
  if (standards.length > 1) fail("Position standards overlap at this call");
  return {
    policyId: null,
    version: RULE_VERSION,
    label: "Provisional beta activity definition — not a published agreement",
    source: "provisional",
    rule: standards[0]?.productive_call_rule ?? DEFAULT_PRODUCTIVE_RULE,
    matchMode: "any",
    requiresPlanned: true,
    allowedCodes: [...PRODUCTIVE_CODES],
    approvedBy: null,
    approvedAt: null,
  };
}
/** @param {any} ctx */
export async function productivePolicies(ctx) {
  await requireCapability(ctx, "visit.read");
  const units = await hooks.scopeUnitIds(ctx.db, ctx.actor);
  const rows = units.length
    ? await ctx.db`select p.*,a.name prepared_by_name,b.name approved_by_name,u.name unit_name,pos.label position_label from productive_call_policies p join profiles a on a.id=p.prepared_by left join profiles b on b.id=p.approved_by join org_units u on u.id=p.org_unit_id left join positions pos on pos.id=p.position_id where p.org_unit_id in ${ctx.db(units)} order by p.created_at desc,p.id limit 501`
    : [];
  if (rows.length > 500)
    fail("Over 500 policy versions; narrow this office scope");
  const positions = units.length
    ? await ctx.db`select id,label from positions where active=true and organization_id in (select organization_id from org_units where id in ${ctx.db(units)}) order by label limit 501`
    : [];
  if (positions.length > 500)
    fail("Over 500 positions; narrow the registry before authoring");
  return {
    policies: rows.map(dto),
    units: units.length
      ? await ctx.db`select id,name from org_units where id in ${ctx.db(units)} order by name`
      : [],
    positions,
    codes: PRODUCTIVE_CODES,
    canAuthor: roleHas(ctx.actor.role, "masterdata.manage"),
    canApprove: roleHas(ctx.actor.role, "mcp.approve"),
  };
}
/** @param {any} ctx @param {any} platform @param {string} action @param {any} body */
export async function productivePolicyCommand(ctx, platform, action, body) {
  const key = required(body?.idempotencyKey, "Idempotency key"),
    requestHash = productiveHash({ action, body });
  const result = await tx(ctx.db, async (db) => {
    const [live] =
      await db`select * from profiles where id=${ctx.actor?.profileId ?? null} and user_id=${ctx.actor?.userId ?? null} and status='active' and deleted_at is null for share`;
    if (!live)
      throw new ApiError("forbidden", 403, "Your access is no longer active");
    const c = {
      ...ctx,
      db,
      actor: { ...ctx.actor, role: live.role, orgUnitId: live.org_unit_id },
    };
    const [existing] =
      action === "publish"
        ? await db`select * from productive_call_policies where id=${uuid(body.policyId)}`
        : [];
    if (action === "publish" && !existing) fail("Policy version not found");
    const unitId =
      action === "publish" ? existing.org_unit_id : uuid(body.orgUnitId);
    await requireCapability(
      c,
      action === "publish" ? "mcp.approve" : "masterdata.manage",
      unitId,
    );
    await db`select pg_advisory_xact_lock(hashtextextended(${"productive-policy:" + unitId},0))`;
    await db`select pg_advisory_xact_lock(hashtextextended(${"productive-command:" + live.id + ":" + key},0))`;
    const [prior] =
      await db`select * from productive_policy_commands where actor_id=${live.id} and request_key=${key}`;
    if (prior) {
      if (prior.request_hash !== requestHash)
        fail("Idempotency key was used for different policy content");
      return prior.result;
    }
    let p;
    if (action === "draft") {
      const ruleDefinition = productiveDefinition(body.definition),
        from = localDate(required(body.fromDate, "Effective from")),
        to = body.toDate == null ? null : localDate(body.toDate);
      if (from < ctx.now || (to !== null && to <= from))
        fail("Use a prospective effective period");
      const positionId = body.positionId == null ? null : uuid(body.positionId),
        channel = null;
      if (body.channelKey != null)
        fail(
          "Use unit and position applicability until the effective channel-history adapter is installed",
        );
      if (
        positionId &&
        !(
          await db`select 1 from positions where id=${positionId} and active=true and organization_id=(select organization_id from org_units where id=${unitId})`
        ).length
      )
        fail("Choose an active position");
      const predecessor =
        body.replacesPolicyId == null ? null : uuid(body.replacesPolicyId);
      const [base] = predecessor
        ? await db`select * from productive_call_policies where id=${predecessor} for update`
        : [];
      if (
        body.replacesPolicyId &&
        (!base ||
          base.status !== "published" ||
          base.org_unit_id !== unitId ||
          base.position_id !== positionId ||
          base.channel_key !== channel ||
          +new Date(base.effective_from) >= from)
      )
        fail(
          "Replacement must keep the applicability and start after its published predecessor",
        );
      const definitionKey = base?.definition_key ?? crypto.randomUUID();
      const [{ v }] =
        await db`select coalesce(max(version),0)::int+1 as v from productive_call_policies where definition_key=${definitionKey}`;
      const label = required(body.label, "Definition label"),
        sourceRef = required(body.sourceRef, "Agreement/source reference");
      const definition = {
        ...ruleDefinition,
        label,
        sourceRef,
        definitionKey,
        version: v,
        orgUnitId: unitId,
        positionId,
        channelKey: channel,
        effectiveFrom: from,
        effectiveTo: to,
      };
      [p] =
        await db`insert into productive_call_policies(definition_key,version,org_unit_id,position_id,channel_key,label,definition,content_hash,effective_from,effective_to,replaces_policy_id,source_ref,prepared_by) values (${definitionKey},${v},${unitId},${positionId},${channel},${label},${definition},${productiveHash(definition)},${new Date(from)},${to === null ? null : new Date(to)},${base?.id ?? null},${sourceRef},${live.id}) returning *`;
    } else if (action === "publish") {
      [p] =
        await db`select * from productive_call_policies where id=${existing.id} for update`;
      if (p.status !== "draft" || p.prepared_by === live.id)
        fail("A different approver must publish a draft definition");
      if (+new Date(p.effective_from) < ctx.now)
        fail("Create a new prospective definition");
      assertStoredPolicy(p);
      if (p.replaces_policy_id) {
        const [old] =
          await db`select * from productive_call_policies where id=${p.replaces_policy_id} for update`;
        if (
          old.status !== "published" ||
          +new Date(old.effective_from) >= +new Date(p.effective_from) ||
          old.org_unit_id !== unitId ||
          old.position_id !== p.position_id ||
          old.channel_key !== p.channel_key ||
          (old.effective_to &&
            +new Date(old.effective_to) < +new Date(p.effective_from))
        )
          fail("The predecessor changed; create another policy version");
        await db`update productive_call_policies set effective_to=${p.effective_from} where id=${old.id}`;
      }
      const overlaps =
        await db`select 1 from productive_call_policies where status='published' and org_unit_id=${unitId} and (position_id is null or ${p.position_id}::uuid is null or position_id=${p.position_id}) and (channel_key is null or ${p.channel_key}::text is null or channel_key=${p.channel_key}) and effective_from<coalesce(${p.effective_to}::timestamptz,'infinity'::timestamptz) and (effective_to is null or effective_to>${p.effective_from}) limit 1`;
      if (overlaps.length)
        fail("Another published definition applies in this period");
      [p] =
        await db`update productive_call_policies set status='published',approved_by=${live.id},approved_at=${new Date(ctx.now)} where id=${p.id} returning *`;
    } else fail("Unknown productive-policy action");
    const response = dto(p);
    await db`insert into productive_policy_events(policy_id,actor_id,kind,detail) values (${p.id},${live.id},${action},${{ version: p.version, contentHash: p.content_hash }})`;
    await db`insert into productive_policy_commands(actor_id,request_key,request_hash,result) values (${live.id},${key},${requestHash},${response})`;
    await platform.recordChange(db, {
      entity: "productive_policy",
      entityId: p.id,
      scopeKey: unitId,
    });
    return response;
  });
  await platform.publish("coverage");
  return result;
}
/** @param {any} router @param {any} platform */
export function installProductivePolicies(router, platform) {
  router.get("/api/v1/coverage/productive-policies", (/** @type {any} */ ctx) =>
    tx(ctx.db, (db) => productivePolicies({ ...ctx, db })),
  );
  for (const action of ["draft", "publish"])
    router.post(
      `/api/v1/coverage/productive-policies/${action}`,
      (/** @type {any} */ ctx) =>
        productivePolicyCommand(ctx, platform, action, ctx.body ?? {}),
    );
}
