import { requireAvailability } from "../availability/callflow.js";
import { DSR_ACCESS } from "../distributors/dsr-context.js";
import { OpRejected } from "../../core/sync.js";
import { invalid } from "../../core/errors.js";
import { canonicalJson, isUuid } from "../../core/util.js";
import { haversine } from "../visits/location.js";

const refuse = (/** @type {string} */ code = "invalid_transition") => {
  throw new OpRejected(code);
};
export const PROFILE_FIELD = "field_selling";
export const PROFILE_VAN = "van_selling";
/** F-301 F-310 F-407: stable taxonomy keys select a configured profile in either native shell.
 * Channel-specific outranks class-only, then wildcard; no title/role strings enter this decision.
 * @param {any[]} bindings @param {any} outlet @param {string} fallback */
export function selectProfile(bindings, outlet, fallback) {
  const matches = bindings.filter(
    (b) =>
      ["*", outlet.channel].includes(b.channel_code) &&
      ["*", outlet.classification].includes(b.outlet_class),
  );
  matches.sort(
    (a, b) =>
      Number(b.channel_code !== "*") * 2 +
      Number(b.outlet_class !== "*") -
      (Number(a.channel_code !== "*") * 2 + Number(a.outlet_class !== "*")),
  );
  return matches[0]?.channel_profile ?? fallback;
}
/** @param {any} db @param {string} app @param {number} at */
async function bindingsAt(db, app, at) {
  const rows =
    await db`select * from call_flow_channel_bindings where app=${app} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) limit 201`;
  if (rows.length > 200) throw invalid("Too many channel call-flow bindings");
  return rows;
}
/** @param {any} db @param {string} app @param {any} outlet @param {number} at @param {string|null} [profileId] */
export async function profileAt(db, app, outlet, at, profileId = null) {
  if (profileId && app === "field-android") {
    const [dsr] =
      await db`select m.id from distributor_users m join distributors d on d.id=m.distributor_id
      join profiles p on p.id=m.profile_id where m.profile_id=${profileId} and p.role='sales' and p.status='active' and p.deleted_at is null
      and d.partner_kind='distributor' and d.status='accredited' and 'dsr'=any(m.grants)
      and m.effective_from<=now() and (m.effective_to is null or m.effective_to>now())
      and m.effective_from<=${new Date(at)} and (m.effective_to is null or m.effective_to>${new Date(at)})`;
    if (dsr) return "distributor_rep";
  }
  return selectProfile(
    await bindingsAt(db, app, at),
    outlet,
    app === "van-android" ? PROFILE_VAN : PROFILE_FIELD,
  );
}
/** @param {any} db @param {string} app @param {number} at */
export async function hasConfiguredFlowsForApp(db, app, at) {
  return (
    !!(await definitionAt(
      db,
      app === "van-android" ? PROFILE_VAN : PROFILE_FIELD,
      at,
    )) || (await bindingsAt(db, app, at)).length > 0
  );
}
/** @param {any} db @param {string} app @param {any[]} outlets @param {number} at @param {any} binding */
export async function configurationsForApp(db, app, outlets, at, binding) {
  const bindings = await bindingsAt(db, app, at),
    groups = new Map();
  for (const outlet of outlets) {
    const profile = binding?.profileId
      ? await profileAt(db, app, outlet, at, binding.profileId)
      : selectProfile(
          bindings,
          outlet,
          app === "van-android" ? PROFILE_VAN : PROFILE_FIELD,
        );
    const group = groups.get(profile) ?? [];
    group.push(outlet);
    groups.set(profile, group);
  }
  const result = new Map();
  for (const [profile, group] of groups)
    for (const [id, config] of await configurations(
      db,
      profile,
      group,
      at,
      binding,
    ))
      result.set(id, config);
  return result;
}
export const CONDITIONS = ["always", "has_order", "no_order"];
/** F-107: closed grammar, not executable expressions. Future channels add adapter names, not engines.
 * @param {any} steps */
export function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 40)
    throw invalid("Use between two and forty call steps");
  const keys = new Set(),
    adapters = new Set();
  for (const s of steps) {
    if (
      !s ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(s.key) ||
      keys.has(s.key) ||
      adapters.has(s.adapter) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(s.adapter) ||
      typeof s.label !== "string" ||
      !s.label.trim() ||
      s.label.length > 100 ||
      typeof s.required !== "boolean" ||
      !CONDITIONS.includes(s.condition)
    )
      throw invalid("Invalid call step");
    keys.add(s.key);
    adapters.add(s.adapter);
  }
  if (
    steps[0].adapter !== "check_in" ||
    !steps[0].required ||
    steps[0].condition !== "always" ||
    steps.at(-1).adapter !== "check_out" ||
    !steps.at(-1).required ||
    steps.at(-1).condition !== "always" ||
    steps
      .slice(1, -1)
      .some((s) => ["check_in", "check_out"].includes(s.adapter))
  )
    throw invalid("A call must start with check-in and end with check-out");
  return steps;
}
/** @param {any} db @param {string} profile @param {number} at */
export async function definitionAt(db, profile, at) {
  const rows =
    await db`select * from call_flow_definitions where channel_profile=${profile}
    and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  if (rows.length > 1) throw invalid("Overlapping call definitions");
  return rows[0] ?? null;
}
/** @param {any} row */
export const definitionDto = (row) =>
  row && {
    id: row.id,
    channelProfile: row.channel_profile,
    version: row.version,
    label: row.label,
    steps: row.steps,
    effectiveFrom: +new Date(row.effective_from),
    effectiveTo: row.effective_to ? +new Date(row.effective_to) : null,
    source: row.source,
  };
/** @param {any} row */
export const policyDto = (row) =>
  row && {
    id: row.id,
    version: row.version,
    radiusMeters: row.radius_meters,
    maxAccuracyMeters: row.max_accuracy_meters,
    maxFixAgeMs: row.max_fix_age_ms,
    minDwellMs: row.min_dwell_ms,
    outletClass: row.outlet_class,
  };
/** F-106 F-207: most-specific class wins; missing setup refuses, never silently disables safety.
 * @param {any} db @param {string} profile @param {any} outlet @param {number} at @param {any} [binding] */
export async function configuration(db, profile, outlet, at, binding = null) {
  return (
    (await configurations(db, profile, [outlet], at, binding)).get(outlet.id) ??
    null
  );
}
/** F-006: bounded bulk loading keeps the cheap-phone bootstrap independent of outlet count.
 * @param {any} db @param {string} profile @param {any[]} outlets @param {number} at @param {any} [binding] */
export async function configurations(db, profile, outlets, at, binding = null) {
  const def = await definitionAt(db, profile, at);
  const result = new Map();
  if (!def || !outlets.length) return result;
  if (outlets.length > 600)
    throw invalid("Too many outlets for a call-flow snapshot");
  const ids = outlets.map((o) => o.id);
  const policies =
    await db`select * from call_flow_policies where channel_profile=${profile} and effective_from<=${new Date(at)}
    and (effective_to is null or effective_to>${new Date(at)}) limit 201`;
  const pins =
    await db`select id,outlet_id,latitude,longitude from outlet_pins where outlet_id in ${db(ids)} and status='verified'
    and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  const reasons =
    await db`select id,code,label,version from no_order_reasons where effective_from<=${new Date(at)}
    and (effective_to is null or effective_to>${new Date(at)}) order by code limit 201`;
  if (policies.length > 200 || reasons.length > 200)
    throw invalid("Too many active call policies or reasons");
  const grants = binding
    ? await db`select r.id,r.outlet_id,r.policy_id,r.kind,extract(epoch from d.created_at)*1000 as "approvedAt",extract(epoch from r.expires_at)*1000 as "expiresAt"
    from call_flow_reviews r join call_flow_decisions d on d.review_id=r.id where r.profile_id=${binding.profileId} and r.device_id=${binding.deviceId}
    and r.outlet_id in ${db(ids)} and r.consumed_by is null and d.decision='approve' and d.actor_profile_id<>r.profile_id
    and r.expires_at>${new Date(at)} and r.kind in ('geofence_start','geofence_end') order by d.created_at desc limit 12001`
    : [];
  if (grants.length > 12000)
    throw invalid("Too many pending geofence approvals");
  for (const outlet of outlets) {
    const policy =
      policies.find(
        (/** @type {any} */ p) =>
          p.outlet_class === (outlet.classification ?? "*"),
      ) ?? policies.find((/** @type {any} */ p) => p.outlet_class === "*");
    if (!policy)
      throw invalid(
        "Set a radius and dwell policy before using this call flow",
      );
    const matches = pins.filter(
      (/** @type {any} */ p) => p.outlet_id === outlet.id,
    );
    result.set(outlet.id, {
      definition: definitionDto(def),
      policy: policyDto(policy),
      pin: matches.length === 1 ? matches[0] : null,
      reasons,
      geofenceApprovals: grants
        .filter((/** @type {any} */ g) => g.outlet_id === outlet.id)
        .map((/** @type {any} */ g) => ({
          id: g.id,
          policyId: g.policy_id,
          kind: g.kind,
          approvedAt: Number(g.approvedAt),
          expiresAt: Number(g.expiresAt),
        })),
    });
  }
  return result;
}
/** SEAM(INTEGRITY): the integrity lane may add an authoritative blocked flag; OS mock flags are already mandatory.
 * @param {any} ctx @param {any} fix */
export function integrityBlocked(ctx, fix) {
  return (
    ctx.device?.integrity_blocked === true ||
    fix?.mockSignal !== false ||
    fix?.integrityBlocked === true
  );
}
/** Pure F-106 validator shared semantically with the single native Kotlin engine. Offline age is measured at capture, not upload.
 * @param {any} config @param {any} fix @param {number} at @param {boolean} [blocked] */
export function locationResult(config, fix, at, blocked = false) {
  if (
    !config?.pin ||
    !fix ||
    blocked ||
    fix.mockSignal !== false ||
    !Number.isFinite(fix.latitude) ||
    Math.abs(fix.latitude) > 90 ||
    !Number.isFinite(fix.longitude) ||
    Math.abs(fix.longitude) > 180 ||
    !Number.isFinite(fix.accuracyMeters) ||
    fix.accuracyMeters < 0 ||
    fix.accuracyMeters > config.policy.maxAccuracyMeters ||
    !["gps", "network", "fused"].includes(fix.provider) ||
    !Number.isSafeInteger(fix.fixTime) ||
    Math.abs(at - fix.fixTime) > config.policy.maxFixAgeMs
  )
    return "unreliable";
  return haversine(fix, config.pin) > config.policy.radiusMeters
    ? "outside_radius"
    : "within_radius";
}
/** FLD-080 owner decision: why a phone sent no fix at all (location off, permission off, no signal). */
const UNAVAILABLE = /** @type {Record<string,string>} */ ({
  location_off: "phone location turned off",
  permission_off: "location permission off",
  no_signal: "no signal",
});
/** The supervisor-review text for a Start/End recorded without any location fix.
 * @param {any} code */
export function unavailableReason(code) {
  return `Location unavailable · supervisor will review: ${UNAVAILABLE[code] ?? "no location fix"}`;
}
/** FLD-080: NO fix at all is not a refusal; a mock, weak, stale or outside-radius fix still is (F-106).
 * @param {any} ctx @param {any} fix */
export function locationMissing(ctx, fix) {
  return fix == null && ctx.device?.integrity_blocked !== true;
}
/** @param {any} ctx @param {any} config @param {string} outletId @param {string} kind @param {any} fix @param {number} at */
async function gateLocation(ctx, config, outletId, kind, fix, at) {
  if (!config?.pin) refuse("evidence_pending_review");
  if (locationMissing(ctx, fix)) return null;
  const result = locationResult(config, fix, at, integrityBlocked(ctx, fix));
  if (result === "within_radius") return null;
  if (result !== "outside_radius" || !isUuid(ctx.payload.geofenceApprovalId))
    refuse("evidence_pending_review");
  const [grant] =
    await ctx.db`select r.* from call_flow_reviews r join call_flow_decisions d on d.review_id=r.id
    where r.id=${ctx.payload.geofenceApprovalId} and r.kind=${kind} and r.profile_id=${ctx.actor.profileId}
    and r.device_id=${ctx.device.id} and r.outlet_id=${outletId} and r.policy_id=${config.policy.id}
    and d.decision='approve' and d.actor_profile_id<>r.profile_id and r.consumed_by is null
    and r.created_at<=${new Date(at)} and d.created_at<=${new Date(at)} and r.expires_at>${new Date(at)} for update of r`;
  if (!grant) refuse("evidence_pending_review");
  return grant.id;
}
/** @param {any} ctx @param {any} call @param {string} kind @param {string} reason */
export async function review(ctx, call, kind, reason) {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
    refuse();
  await ctx.db`insert into call_flow_reviews (profile_id,device_id,org_unit_id,outlet_id,call_id,kind,policy_id,reason)
    values (${call.profile_id},${call.device_id},${call.org_unit_id},${call.outlet_id},${call.id},${kind},${call.policy_snapshot.policy.id},${reason.trim()})`;
}
/** FLD-080: a call with no visit (van) files its own "Location unavailable" review; a field visit's review is its
 * visit_location_evidence row (result 'unavailable', pending review). It is born consumed, so it can never be
 * reused as an outside-radius approval.
 * @param {any} ctx @param {any} call @param {string} kind @param {any} fix */
async function reviewMissingLocation(ctx, call, kind, fix) {
  if (call.visit_id || !locationMissing(ctx, fix)) return;
  await ctx.db`insert into call_flow_reviews (profile_id,device_id,org_unit_id,outlet_id,call_id,kind,policy_id,reason,consumed_by)
    values (${call.profile_id},${call.device_id},${call.org_unit_id},${call.outlet_id},${call.id},${kind},${call.policy_snapshot.policy.id},
    ${unavailableReason(ctx.payload.locationUnavailable)},${call.id})`;
}
/** @param {any} ctx @param {any} input */
export async function beginCall(ctx, input) {
  const config = await configuration(
    ctx.db,
    ctx[DSR_ACCESS]
      ? "distributor_rep"
      : await profileAt(
          ctx.db,
          ctx.app,
          input.outlet,
          ctx.payload.deviceTime,
          ctx.actor.profileId,
        ),
    input.outlet,
    ctx.payload.deviceTime,
  );
  if (!config) return null;
  if (ctx.payload.flowDefinitionId !== config.definition.id)
    refuse("invalid_plan");
  const at = ctx.payload.deviceTime;
  if (
    !Number.isSafeInteger(at) ||
    at > ctx.now + 60000 ||
    ctx.now - at > 7 * 86400000
  )
    refuse("wrong_date");
  await ctx.db`select pg_advisory_xact_lock(hashtext(${`callflow:${ctx.actor.profileId}`}))`;
  // Server housekeeping only: never fabricate an End, a no-order reason or dwell for yesterday.
  // The immutable old outbox is retained for reconciliation; it must not block every subsequent day/trip.
  const abandoned =
    await ctx.db`select c.* from call_executions c where c.profile_id=${ctx.actor.profileId} and c.state='open'
    and (c.service_date<${input.serviceDate}::date or exists(select 1 from van_trips t where t.id=c.trip_id and t.status in ('closed','cancelled'))) for update`;
  for (const previous of abandoned) {
    await ctx.db`update call_executions set state='interrupted',interrupted_at=${new Date(ctx.now)} where id=${previous.id}`;
    await ctx.db`insert into call_step_events(call_id,step_key,adapter,operation_key,entity_id,facts,device_time,actor_subject)
      values (${previous.id},'system_day_boundary','system_day_boundary',${ctx.op.clientOpId},${previous.id},${{ source: "day_boundary", checkoutReceived: false }},${new Date(ctx.now)},'system:callflow-boundary')`;
    await review(
      ctx,
      previous,
      "day_boundary",
      "No checkout received before the next working day or trip. Reconcile retained phone work; duration and outcome remain unknown.",
    );
  }
  const open =
    await ctx.db`select id from call_executions where profile_id=${ctx.actor.profileId} and state='open'`;
  if (open.length) refuse("call_open");
  const grant = await gateLocation(
    ctx,
    config,
    input.outlet.id,
    "geofence_start",
    ctx.payload.location,
    at,
  );
  if (
    input.deviated &&
    (typeof ctx.payload.sequenceReason !== "string" ||
      !ctx.payload.sequenceReason.trim() ||
      ctx.payload.sequenceReason.length > 500)
  )
    refuse("mcp_order");
  if (
    !input.planned &&
    (typeof ctx.payload.unplannedReason !== "string" ||
      !ctx.payload.unplannedReason.trim() ||
      ctx.payload.unplannedReason.length > 500)
  )
    refuse();
  const [call] =
    await ctx.db`insert into call_executions (client_call_id,profile_id,device_id,org_unit_id,outlet_id,visit_id,trip_id,
    service_date,definition_id,definition_snapshot,policy_snapshot,reasons_snapshot,planned_visit_id,planned_sequence,source,
    deviation_reason,unplanned_reason,started_at)
    values (${input.clientCallId},${ctx.actor.profileId},${ctx.device.id},${input.unitId},${input.outlet.id},${input.visitId ?? null},${input.tripId ?? null},
    ${input.serviceDate},${config.definition.id},${config.definition},${config},${{ values: config.reasons }}::jsonb->'values',${input.plannedVisitId ?? null},${input.sequence ?? null},
    ${input.deviated ? "deviated" : input.planned ? "planned" : "unplanned"},${ctx.payload.sequenceReason ?? null},${ctx.payload.unplannedReason ?? null},${new Date(at)}) returning *`;
  if (grant)
    await ctx.db`update call_flow_reviews set consumed_by=${call.id} where id=${grant}`;
  await advance(ctx, call, "check_in", input.visitId ?? call.id);
  await reviewMissingLocation(ctx, call, "geofence_start", ctx.payload.location);
  if (input.deviated)
    await review(ctx, call, "sequence", ctx.payload.sequenceReason);
  if (!input.planned)
    await review(ctx, call, "unplanned", ctx.payload.unplannedReason);
  ctx.publish("callflow");
  return call;
}
/** @param {any} ctx @param {{visitId?:string,clientCallId?:string}} key */
export async function ownedCall(ctx, key, allowClosed = false) {
  const [call] = key.visitId
    ? await ctx.db`select * from call_executions where visit_id=${key.visitId} for update`
    : await ctx.db`select * from call_executions where client_call_id=${key.clientCallId} and profile_id=${ctx.actor.profileId} and device_id=${ctx.device.id} for update`;
  if (
    call &&
    (call.profile_id !== ctx.actor.profileId ||
      call.device_id !== ctx.device.id ||
      call.org_unit_id !== ctx.actor.orgUnitId ||
      (!allowClosed && call.state !== "open"))
  )
    refuse("out_of_scope");
  return call ?? null;
}
/** @param {any} ctx @param {any} call */
export async function hasOrder(ctx, call) {
  if (call.visit_id) {
    // FLD-160: a distributor's order request is never captured as a Sunpride order; it always lands in the
    // office's review queue by design. That queued request IS the call's order, so End call is not refused
    // for want of a no-order reason. Employee orders that failed capture still do not count.
    const partner = !!ctx[DSR_ACCESS];
    const [r] =
      await ctx.db`select exists(select 1 from visit_activities a where a.visit_id=${call.visit_id} and a.activity_kind='order_intent' and a.deleted_at is null
      and jsonb_array_length(a.activity->'lines')>0
      and (${partner}::boolean or not exists(select 1 from order_intent_queue q where q.activity_id=a.id and q.status='review'))
      and not exists(select 1 from field_order_captures f join orders o on o.id=f.order_id where f.activity_id=a.id and o.status in ('draft','rejected','voided'))) as yes`;
    return r.yes;
  }
  const [r] =
    await ctx.db`select exists(select 1 from call_step_events e join van_sales s on s.id::text=e.entity_id
    where e.call_id=${call.id} and e.adapter='order_build' and not exists(select 1 from van_sale_voids v where v.sale_id=s.id)) as yes`;
  return r.yes;
}
/** @param {any} step @param {boolean} order */
const applies = (step, order) =>
  step.condition === "always" ||
  (step.condition === "has_order" ? order : !order);
/** F-107: an adapter is proof from the authoritative writer, not an arbitrary 'done' flag.
 * @param {any} ctx @param {any} call @param {string} adapter @param {string} entityId */
export async function advance(ctx, call, adapter, entityId) {
  if (!call) return;
  if (
    (ctx.payload.deviceTime ?? ctx.payload.capturedAt) <
    +new Date(call.started_at)
  )
    refuse("wrong_date");
  if (adapter === "availability")
    await requireAvailability(
      ctx.db,
      call.profile_id,
      call.outlet_id,
      call.client_call_id,
      ctx.payload.deviceTime ?? ctx.payload.capturedAt,
    );
  const steps = call.definition_snapshot.steps;
  const events =
    await ctx.db`select step_key,adapter from call_step_events where call_id=${call.id}`;
  const done = new Set(events.map((/** @type {any} */ e) => e.step_key));
  const order = adapter === "order_build" || (await hasOrder(ctx, call));
  const index = steps.findIndex(
    (/** @type {any} */ s) =>
      s.adapter === adapter && applies(s, order) && !done.has(s.key),
  );
  if (index < 0) {
    if (
      steps.some(
        (/** @type {any} */ s) => s.adapter === adapter && done.has(s.key),
      )
    )
      return;
    refuse();
  }
  if (
    steps
      .slice(0, index)
      .some(
        (/** @type {any} */ s) =>
          s.required && applies(s, order) && !done.has(s.key),
      )
  )
    refuse();
  // Required conditional steps are rechecked at close using final accepted order facts.
  await ctx.db`insert into call_step_events (call_id,step_key,adapter,operation_key,entity_id,facts,device_time,actor_subject)
    values (${call.id},${steps[index].key},${adapter},${ctx.op.clientOpId},${entityId},${{ observation: ctx.payload.observation ?? null, note: ctx.payload.note ?? null }},${new Date(ctx.payload.deviceTime ?? ctx.payload.capturedAt)},${ctx.actor.subject})`;
}
/** @param {any} ctx @param {any} call */
export async function closeCall(ctx, call) {
  if (!call) return;
  const p = ctx.payload,
    at = p.deviceTime,
    start = +new Date(call.started_at),
    config = call.policy_snapshot;
  if (!Number.isSafeInteger(at) || at < start || at > ctx.now + 60000)
    refuse("wrong_date");
  const grant = await gateLocation(
    ctx,
    config,
    call.outlet_id,
    "geofence_end",
    p.location,
    at,
  );
  const order = await hasOrder(ctx, call);
  const reason =
    !order &&
    call.reasons_snapshot.find(
      (/** @type {any} */ r) => r.code === p.zeroSaleReason,
    );
  if (!order && !reason) refuse();
  const duration = at - start,
    short = duration < config.policy.minDwellMs;
  if (
    short &&
    (typeof p.shortCallReason !== "string" ||
      !p.shortCallReason.trim() ||
      p.shortCallReason.length > 500)
  )
    refuse();
  await advance(ctx, call, "check_out", call.id);
  await reviewMissingLocation(ctx, call, "geofence_end", p.location);
  if (short) await review(ctx, call, "short_call", p.shortCallReason);
  if (grant)
    await ctx.db`update call_flow_reviews set consumed_by=${call.id} where id=${grant}`;
  await ctx.db`update call_executions set state='closed',ended_at=${new Date(at)},duration_ms=${duration},
    zero_sale_reason=${reason || null},short_call_reason=${short ? p.shortCallReason : null} where id=${call.id}`;
  ctx.publish("callflow");
}
/** @param {any} ctx @param {string} visitId @param {string} kind @param {string} entityId */
export async function fieldAdapter(ctx, visitId, kind, entityId) {
  const call = await ownedCall(ctx, { visitId }, kind === "photo");
  const adapter = /** @type {Record<string,string>} */ ({
    inventory_check: "stock_check",
    call_sheet: "stock_check",
    order_intent: "order_build",
    note: "note",
    photo: "evidence",
    merchandising: "availability",
    price_check: "price_check",
    promotion: "promotion",
    collection: "payment",
  })[kind];
  if (!call || !adapter) return;
  // Nonconfigured bonus activities stay available; required configured ones cannot be bypassed.
  if (
    call.definition_snapshot.steps.some(
      (/** @type {any} */ s) => s.adapter === adapter,
    )
  )
    await advance(ctx, call, adapter, entityId);
}
export { canonicalJson };
