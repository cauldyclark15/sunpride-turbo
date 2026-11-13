import { tx } from "@sunpride/db/client";
import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import { ApiError, conflict, forbidden, invalid } from "../../core/errors.js";
import { writeAudit } from "../org/audit.js";
import {
  accessOutlet,
  employeeAt,
  uuid,
  text,
  manilaDate,
  date,
} from "../visits/shared.js";
import { currentDeviceActor, tripFor, outletFor } from "../van/access.js";
import { audit as vanAudit } from "../van/facts.js";
import { scopeFilterForActor } from "../org/scope.js";
import { damagePhoto } from "../van/media.js";
import {
  advance,
  beginCall,
  closeCall,
  configuration,
  definitionAt,
  definitionDto,
  ownedCall,
  PROFILE_VAN,
  profileAt,
  validateSteps,
} from "./engine.js";

/** F-107: prospective publication serializes version allocation and closes just the prior interval.
 * @param {any} ctx @param {'definition'|'policy'|'reason'} kind */
export async function publishVersion(ctx, kind) {
  await requireCapability(ctx, "admin.manage");
  await requireNationalScope(ctx, ["admin"]); // Global channel policies must not be changed by an area-only editor.
  const p = ctx.body,
    from = Number(p.effectiveFrom);
  if (
    !Number.isSafeInteger(from) ||
    from < ctx.now ||
    from > ctx.now + 366 * 86400000
  )
    throw invalid("Choose a future effective date");
  const code =
    kind === "reason" ? text(p.code, 64) : text(p.channelProfile, 64);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code))
    throw invalid("Invalid profile or reason code");
  if (kind === "definition") validateSteps(p.steps);
  if (kind === "policy")
    for (const [
      key,
      min,
      max,
    ] of /** @type {Array<[string,number,number]>} */ ([
      ["radiusMeters", 1, 500],
      ["maxAccuracyMeters", 1, 100],
      ["maxFixAgeMs", 1000, 300000],
      ["minDwellMs", 0, 14400000],
    ]))
      if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max)
        throw invalid(`Invalid ${key}`);
  const result = await tx(ctx.db, async (db) => {
    await db`select pg_advisory_xact_lock(hashtext(${`callflow-publish:${kind}:${code}:${p.outletClass ?? "*"}`}))`;
    const table =
      kind === "definition"
        ? "call_flow_definitions"
        : kind === "policy"
          ? "call_flow_policies"
          : "no_order_reasons";
    const key = kind === "reason" ? "code" : "channel_profile";
    // Identifiers are closed server constants; all supplied values are bound parameters.
    const rows = await db.unsafe(
      `select * from ${table} where ${key}=$1 ${kind === "policy" ? "and outlet_class=$2" : ""} order by effective_from desc`,
      kind === "policy" ? [code, p.outletClass ?? "*"] : [code],
    );
    if (
      rows.some((/** @type {any} */ r) => +new Date(r.effective_from) >= from)
    )
      throw conflict("Revise after the latest scheduled version");
    const prior = rows[0],
      version =
        Math.max(0, ...rows.map((/** @type {any} */ r) => r.version)) + 1;
    if (prior && (!prior.effective_to || +new Date(prior.effective_to) > from))
      await db.unsafe(
        `update ${table} set effective_to=$1,updated_at=now() where id=$2`,
        [new Date(from), prior.id],
      );
    let row;
    if (kind === "definition")
      [row] =
        await db`insert into call_flow_definitions(channel_profile,version,label,steps,effective_from,published_by)
      values (${code},${version},${text(p.label, 100)},${{ values: p.steps }}::jsonb->'values',${new Date(from)},${ctx.actor.subject}) returning *`;
    if (kind === "policy")
      [row] =
        await db`insert into call_flow_policies(channel_profile,outlet_class,version,radius_meters,max_accuracy_meters,max_fix_age_ms,min_dwell_ms,effective_from,published_by)
      values (${code},${text(p.outletClass ?? "*", 64)},${version},${p.radiusMeters},${p.maxAccuracyMeters},${p.maxFixAgeMs},${p.minDwellMs},${new Date(from)},${ctx.actor.subject}) returning *`;
    if (kind === "reason")
      [row] =
        await db`insert into no_order_reasons(code,label,version,effective_from,published_by)
      values (${code},${text(p.label, 100)},${version},${new Date(from)},${ctx.actor.subject}) returning *`;
    await writeAudit(db, {
      subject: ctx.actor.subject,
      action: `callflow.${kind}.published`,
      entityType: "callflow",
      entityId: row.id,
      details: { version, code, effectiveFrom: from },
    });
    // The existing field manifest protects complete snapshots; publishing tells clients to refresh.
    await ctx.recordChange?.(db, {
      entity: "field.manifest",
      entityId: row.id,
      scopeKey: "field:reference",
    });
    return { id: row.id, version };
  });
  await ctx.publish("callflow");
  return result;
}
/** @param {any} ctx */
export async function reviewRows(ctx) {
  await requireCapability(ctx, "visit.read");
  const { unitIds } = await scopeFilterForActor(ctx.db, ctx.actor),
    ids = unitIds?.length ? unitIds : ["00000000-0000-0000-0000-000000000000"];
  const rows =
    await ctx.db`select r.*,d.decision,p.name as person,o.name as outlet,c.source,c.duration_ms,c.planned_sequence
    from call_flow_reviews r join profiles p on p.id=r.profile_id join outlets o on o.id=r.outlet_id
    left join call_executions c on c.id=r.call_id left join call_flow_decisions d on d.review_id=r.id
    where (${unitIds === null} or r.org_unit_id in ${ctx.db(ids)}) and d.id is null
    and (${ctx.actor.role !== "sales"} or r.profile_id=${ctx.actor.profileId}) order by r.created_at,r.id limit 201`;
  if (rows.length > 200)
    throw invalid("Narrow the review scope; more than 200 pending calls");
  const items = [];
  for (const row of rows) {
    try {
      await accessOutlet(ctx, row.outlet_id, "visit.read");
      const person = await employeeAt(ctx.db, row.profile_id, ctx.now);
      await requireCapability(ctx, "visit.read", person.org_unit_id);
      items.push({
        id: row.id,
        // FLD-080: a van call Start/End with no fix files a born-consumed geofence review; name it for what it is.
        kind:
          row.call_id &&
          row.consumed_by === row.call_id &&
          row.reason.startsWith("Location unavailable")
            ? row.kind === "geofence_end"
              ? "location_unavailable_end"
              : "location_unavailable_start"
            : row.kind,
        person: row.person,
        outlet: row.outlet,
        reason: row.reason,
        source: row.source,
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        plannedSequence: row.planned_sequence,
        createdAt: +new Date(row.created_at),
        canDecide:
          row.profile_id !== ctx.actor.profileId &&
          roleHas(ctx.actor.role, "visit.locationException.approve"),
      });
    } catch (e) {
      if (/** @type {any} */ (e).status !== 403) throw e;
    }
  }
  return { items };
}
/** @param {any} ctx */
async function vanCall(ctx) {
  const { actor } = await currentDeviceActor(ctx.db, ctx.actor, ctx.device.id);
  const p = ctx.payload,
    trip = await tripFor(ctx.db, actor, uuid(p.tripId), "van.operate", true);
  if (
    trip.salesperson_profile_id !== actor.profileId ||
    (trip.started_device_id !== null &&
      trip.started_device_id !== ctx.device.id) ||
    trip.status !== "active" ||
    manilaDate(ctx.now) !==
      new Date(trip.service_date).toISOString().slice(0, 10) ||
    manilaDate(p.deviceTime) !== manilaDate(ctx.now)
  )
    ctx.reject("invalid_transition");
  if (ctx.op.opType === "call.start") {
    const outlet = await outletFor(ctx.db, actor, uuid(p.outletId));
    await ctx.db`select pg_advisory_xact_lock(hashtext(${`callflow:${actor.profileId}`}))`;
    const assignment =
      await ctx.db`select a.outlet_id,a.sequence from outlet_assignments a
      where a.route_id=${trip.route_id} and a.deleted_at is null and a.effective_from<=now()
      and (a.effective_to is null or a.effective_to>now()) order by a.sequence,a.outlet_id limit 501`;
    if (assignment.length > 500) throw invalid("Route exceeds 500 stops");
    const target = assignment.find(
      (/** @type {any} */ a) => a.outlet_id === outlet.id,
    );
    const done =
      await ctx.db`select outlet_id from call_executions where trip_id=${trip.id} and state='closed' and source<>'unplanned'`;
    const completed = new Set(done.map((/** @type {any} */ c) => c.outlet_id));
    const deviated =
      target &&
      assignment.some(
        (/** @type {any} */ a) =>
          a.sequence < target.sequence && !completed.has(a.outlet_id),
      );
    const call = await beginCall(
      { ...ctx, actor },
      {
        channelProfile: PROFILE_VAN,
        clientCallId: uuid(p.clientCallId),
        outlet,
        unitId: trip.org_unit_id,
        tripId: trip.id,
        serviceDate: manilaDate(ctx.now),
        planned: !!target,
        sequence: target?.sequence,
        deviated,
      },
    );
    if (!call) throw invalid("Publish a van call flow first");
    await auditTripOp(ctx, trip, actor, call.id);
    return { entityId: call.id };
  }
  const call = await ownedCall(ctx, { clientCallId: uuid(p.clientCallId) });
  if (!call || call.trip_id !== trip.id) ctx.reject("invalid_transition");
  await outletFor(ctx.db, actor, call.outlet_id);
  if (ctx.op.opType === "call.close") await closeCall(ctx, call);
  else {
    // Stock observation and notes are explicit manual adapters. Financial steps may only be completed by their own writers.
    if (!["stock_check", "note", "evidence"].includes(p.adapter))
      ctx.reject("unsupported_operation");
    if (p.adapter === "note") text(p.note, 2000);
    if (p.adapter === "stock_check") text(p.observation, 500);
    // Reuse VAN's subject/device/trip/digest-validated photo adapter; never accept a self-certified evidence flag.
    const entityId =
      p.adapter === "evidence"
        ? await damagePhoto(
            ctx.db,
            actor,
            ctx.device,
            trip,
            p.photoSha256,
            true,
          )
        : ctx.op.clientOpId;
    if (
      p.adapter === "evidence" &&
      (
        await ctx.db`select 1 from call_step_events where adapter='evidence' and entity_id=${entityId} and call_id<>${call.id}`
      ).length
    )
      ctx.reject("invalid_request");
    await advance(ctx, call, p.adapter, entityId);
  }
  await auditTripOp(ctx, trip, actor, call.id);
  return { entityId: call.id };
}
/** The phone's trip.close manifest lists every APPLIED trip operation. A repeated step is a semantic no-op in the engine
 * (no step event), so each accepted van call op owns its own operation-keyed audit row, written in the same transaction
 * as the op and only after every check above passed (a rejected/refused op rolls back and leaves nothing). The trip comes
 * from the trusted, already scope-checked trip row, never from the payload alone.
 * @param {any} ctx @param {any} trip @param {any} actor @param {string} callId */
async function auditTripOp(ctx, trip, actor, callId) {
  await vanAudit(ctx.db, trip, actor, ctx.op.opType, callId, {
    clientOpId: ctx.op.clientOpId,
  });
}
/** @param {any} ctx @param {any} trip @param {string} entityId */
export async function vanAdapter(ctx, trip, entityId) {
  if (
    !["sale.record", "return.record", "payment.record"].includes(ctx.op.opType)
  )
    return;
  const p = ctx.payload;
  let sourceOutlet = p.customer?.outletId ?? p.outletId;
  if (ctx.op.opType === "payment.record")
    sourceOutlet = (
      await ctx.db`select outlet_id from van_sales where id=${p.saleId} and trip_id=${trip.id}`
    )[0]?.outlet_id;
  if (!p.clientCallId) {
    const [outlet] = sourceOutlet
      ? await ctx.db`select id,channel,classification from outlets where id=${sourceOutlet}`
      : [];
    const profile = outlet
      ? await profileAt(ctx.db, ctx.app, outlet, p.deviceTime)
      : PROFILE_VAN;
    if (await definitionAt(ctx.db, profile, p.deviceTime))
      ctx.reject("invalid_transition");
    return;
  }
  const call =
    ctx.payload.clientCallId &&
    (await ownedCall(ctx, { clientCallId: uuid(ctx.payload.clientCallId) }));
  if (!call || call.trip_id !== trip.id) ctx.reject("invalid_transition");
  const outlet = sourceOutlet;
  if (outlet && outlet !== call.outlet_id) ctx.reject("out_of_scope");
  if (ctx.op.opType === "sale.record") {
    await advance(ctx, call, "order_build", entityId);
    // A single atomic checkout owns these facts. Optional/conditional steps absent in a configuration are not invented.
    for (const adapter of ["discount", "invoice", "payment"])
      if (
        call.definition_snapshot.steps.some(
          (/** @type {any} */ s) => s.adapter === adapter,
        )
      )
        await advance(ctx, call, adapter, entityId);
  } else
    await advance(
      ctx,
      call,
      ctx.op.opType === "return.record" ? "return_pickup" : "payment",
      entityId,
    );
}
/** F-301 F-310 F-407: publish a channel/class profile selection without changing either app.
 * @param {any} ctx @param {any} installCtx */
async function publishBinding(ctx, installCtx) {
  await requireCapability(ctx, "admin.manage");
  await requireNationalScope(ctx, ["admin"]);
  const p = ctx.body,
    from = Number(p.effectiveFrom),
    app = text(p.app, 32),
    channel = text(p.channelCode ?? "*", 64),
    outletClass = text(p.outletClass ?? "*", 64),
    profile = text(p.channelProfile, 64);
  if (
    !["field-android", "van-android", "field-ios"].includes(app) ||
    !Number.isSafeInteger(from) ||
    from < ctx.now ||
    from > ctx.now + 366 * 86400000
  )
    throw invalid("Choose an app and a future effective date");
  const result = await tx(ctx.db, async (db) => {
    await db`select pg_advisory_xact_lock(hashtext(${`callflow-binding:${app}:${channel}:${outletClass}`}))`;
    if (!(await definitionAt(db, profile, from)))
      throw invalid("Publish the selected profile before assigning it");
    const rows =
      await db`select * from call_flow_channel_bindings where app=${app} and channel_code=${channel} and outlet_class=${outletClass} order by effective_from desc`;
    if (
      rows.some((/** @type {any} */ r) => +new Date(r.effective_from) >= from)
    )
      throw conflict("A later binding is already scheduled");
    const prior = rows[0],
      version =
        Math.max(0, ...rows.map((/** @type {any} */ r) => r.version)) + 1;
    if (prior && (!prior.effective_to || +new Date(prior.effective_to) > from))
      await db`update call_flow_channel_bindings set effective_to=${new Date(from)},updated_at=now() where id=${prior.id}`;
    const [row] =
      await db`insert into call_flow_channel_bindings(app,channel_code,outlet_class,channel_profile,version,effective_from,published_by)
      values (${app},${channel},${outletClass},${profile},${version},${new Date(from)},${ctx.actor.subject}) returning id`;
    await writeAudit(db, {
      subject: ctx.actor.subject,
      action: "callflow.binding.published",
      entityType: "callflow",
      entityId: row.id,
      details: {
        app,
        channel,
        outletClass,
        profile,
        version,
        effectiveFrom: from,
      },
    });
    await installCtx.recordChange(db, {
      entity: "field.manifest",
      entityId: row.id,
      scopeKey: "field:reference",
    });
    return { id: row.id, version };
  });
  await ctx.publish("callflow");
  return result;
}
/** @param {any} router @param {any} installCtx */
export function install(router, installCtx) {
  installCtx.registerTopic("callflow", (/** @type {any} */ actor) =>
    roleHas(actor.role, "visit.read"),
  );
  for (const kind of ["definition", "policy", "reason"])
    router.post(`/api/v1/callflow/${kind}/publish`, (/** @type {any} */ ctx) =>
      publishVersion(
        { ...ctx, recordChange: installCtx.recordChange },
        /** @type {any} */ (kind),
      ),
    );
  router.post("/api/v1/callflow/binding/publish", (/** @type {any} */ ctx) =>
    publishBinding(ctx, installCtx),
  );
  router.get("/api/v1/callflow/admin", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "admin.manage");
    const definitions =
      await ctx.db`select * from call_flow_definitions order by channel_profile,version desc limit 201`;
    const policies =
      await ctx.db`select * from call_flow_policies order by channel_profile,outlet_class,version desc limit 201`;
    const reasons =
      await ctx.db`select * from no_order_reasons order by code,version desc limit 201`;
    const bindings =
      await ctx.db`select * from call_flow_channel_bindings order by app,channel_code,outlet_class,version desc limit 201`;
    if ([definitions, policies, reasons, bindings].some((r) => r.length > 200))
      throw invalid("More than 200 versions; narrow the configuration history");
    return {
      definitions: definitions.map(definitionDto),
      policies,
      reasons,
      bindings,
    };
  });
  router.get("/api/v1/callflow/report", async (/** @type {any} */ ctx) => {
    await requireCapability(ctx, "visit.read");
    const to = date(ctx.url.searchParams.get("to") ?? manilaDate(ctx.now)),
      from = date(
        ctx.url.searchParams.get("from") ?? manilaDate(ctx.now - 6 * 86400000),
      );
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      from > to ||
      Date.parse(to) - Date.parse(from) > 31 * 86400000
    )
      throw invalid("Choose a period of up to 31 days");
    const { unitIds } = await scopeFilterForActor(ctx.db, ctx.actor),
      units = unitIds?.length
        ? unitIds
        : ["00000000-0000-0000-0000-000000000000"];
    const rows =
      await ctx.db`select c.*,p.name as person,o.name as outlet from call_executions c join profiles p on p.id=c.profile_id
      join employee_assignments e on e.profile_id=p.id and e.deleted_at is null and e.effective_from<=now() and (e.effective_to is null or e.effective_to>now())
      join outlets o on o.id=c.outlet_id left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
      left join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now())
      where c.service_date between ${from}::date and ${to}::date and p.status='active' and p.deleted_at is null and o.deleted_at is null
      and (${ctx.actor.role !== "sales"} or c.profile_id=${ctx.actor.profileId})
      and (${unitIds === null} or (c.org_unit_id in ${ctx.db(units)} and e.org_unit_id in ${ctx.db(units)} and (case when a.id is null then o.custodian_org_unit_id else own.org_unit_id end) in ${ctx.db(units)}))
      order by c.service_date desc,c.started_at desc,c.id limit 2001`;
    if (rows.length > 2000)
      throw invalid(
        "More than 2,000 calls. Choose a shorter period or a smaller scope.",
      );
    const counts = { planned: 0, deviated: 0, unplanned: 0 };
    const items = rows.map((/** @type {any} */ c) => {
      counts[/** @type {keyof typeof counts} */ (c.source)]++;
      return {
        callId: c.id,
        person: c.person,
        outlet: c.outlet,
        serviceDate: new Date(c.service_date).toISOString().slice(0, 10),
        source: c.source,
        state: c.state,
        reason: c.deviation_reason ?? c.unplanned_reason,
        zeroSaleReason: c.zero_sale_reason?.label ?? null,
        durationMs: c.duration_ms === null ? null : Number(c.duration_ms),
        shortCallReason: c.short_call_reason,
      };
    });
    return { from, to, counts, items };
  });
  router.get("/api/v1/callflow/reviews", reviewRows);
  router.post(
    "/api/v1/callflow/reviews/decide",
    async (/** @type {any} */ ctx) => {
      const result = await tx(ctx.db, async (db) => {
        const c = { ...ctx, db },
          p = ctx.body;
        const [r] =
          await db`select * from call_flow_reviews where id=${uuid(p.reviewId)} for update`;
        if (!r) throw forbidden("Call review unavailable");
        await requireCapability(
          c,
          "visit.locationException.approve",
          r.org_unit_id,
        );
        await accessOutlet(c, r.outlet_id, "visit.locationException.approve");
        const employee = await employeeAt(db, r.profile_id, ctx.now);
        await requireCapability(
          c,
          "visit.locationException.approve",
          employee.org_unit_id,
        );
        if (r.profile_id === ctx.actor.profileId)
          throw forbidden("You cannot approve your own call");
        if (!["approve", "reject"].includes(p.decision)) throw invalid();
        if (
          (await db`select 1 from call_flow_decisions where review_id=${r.id}`)
            .length
        )
          throw conflict("Already decided");
        const [d] =
          await db`insert into call_flow_decisions(review_id,decision,reason,actor_profile_id,actor_subject)
        values (${r.id},${p.decision},${text(p.reason, 500)},${ctx.actor.profileId},${ctx.actor.subject}) returning id`;
        await writeAudit(db, {
          subject: ctx.actor.subject,
          action: "callflow.review.decided",
          entityType: "callflow",
          entityId: r.id,
          details: { decision: p.decision },
        });
        return { id: d.id, decision: p.decision };
      });
      await ctx.publish("callflow");
      return result;
    },
  );
  // FLD-176: a supervisor can close a call that is stuck open on the server (e.g. its End was refused) so the
  // person's next Start is not refused call_open. Like the day boundary it never invents an End, outcome or
  // no-order reason: the call is marked interrupted, a supervisor boundary event is appended, and it is audited.
  router.post(
    "/api/v1/callflow/calls/close-stuck",
    async (/** @type {any} */ ctx) => {
      const result = await tx(ctx.db, async (db) => {
        const c = { ...ctx, db },
          p = ctx.body ?? {};
        const reason = text(p.reason, 500);
        const [call] =
          await db`select * from call_executions where id=${uuid(p.callId)} for update`;
        if (!call) throw forbidden("Call unavailable");
        await requireCapability(
          c,
          "visit.locationException.approve",
          call.org_unit_id,
        );
        await accessOutlet(
          c,
          call.outlet_id,
          "visit.locationException.approve",
        );
        if (call.profile_id === ctx.actor.profileId)
          throw forbidden("You cannot close your own call");
        if (call.state !== "open") throw conflict("This call is already closed");
        await db`update call_executions set state='interrupted',interrupted_at=${new Date(ctx.now)} where id=${call.id}`;
        await db`insert into call_step_events(call_id,step_key,adapter,operation_key,entity_id,facts,device_time,actor_subject)
          values (${call.id},'supervisor_close','supervisor_close',${crypto.randomUUID()},${call.id},${{ source: "supervisor", checkoutReceived: false, reason }},${new Date(ctx.now)},${ctx.actor.subject})`;
        await writeAudit(db, {
          subject: ctx.actor.subject,
          action: "callflow.call.closed_by_supervisor",
          entityType: "callflow",
          entityId: call.id,
          details: { reason, profileId: call.profile_id, outletId: call.outlet_id },
        });
        return { id: call.id, state: "interrupted" };
      });
      await ctx.publish("callflow");
      return result;
    },
  );
  router.post(
    "/api/v1/callflow/geofence/request",
    async (/** @type {any} */ ctx) => {
      const result = await tx(ctx.db, async (db) => {
        const c = { ...ctx, db },
          p = ctx.body;
        const { outlet, owner } = await accessOutlet(
          c,
          uuid(p.outletId),
          "visit.record",
        );
        const [device] =
          await db`select * from registered_devices where id=${uuid(p.deviceId)} and profile_id=${ctx.actor.profileId}
        and status='active' and bound_subject=${ctx.actor.subject} and org_unit_id=${ctx.actor.orgUnitId} for share`;
        if (!device || !["field-android", "van-android"].includes(device.app))
          throw forbidden("Use your registered phone");
        if (!["geofence_start", "geofence_end"].includes(p.kind))
          throw invalid();
        let config;
        if (p.kind === "geofence_end") {
          const [call] =
            await db`select policy_snapshot from call_executions where profile_id=${ctx.actor.profileId} and device_id=${device.id} and outlet_id=${outlet.id} and state='open' for share`;
          if (!call)
            throw invalid(
              "Sync the open call before requesting checkout approval",
            );
          config = call.policy_snapshot;
        } else
          config = await configuration(
            db,
            await profileAt(
              db,
              device.app,
              outlet,
              ctx.now,
              ctx.actor.profileId,
            ),
            outlet,
            ctx.now,
          );
        if (!config) throw invalid("No configured call flow");
        const [r] =
          await db`insert into call_flow_reviews(profile_id,device_id,org_unit_id,outlet_id,kind,policy_id,reason,expires_at)
        values (${ctx.actor.profileId},${device.id},${owner},${outlet.id},${p.kind},${config.policy.id},${text(p.reason, 500)},${new Date(ctx.now + 3600000)}) returning id`;
        return { id: r.id };
      });
      await ctx.publish("callflow");
      return result;
    },
  );
  for (const op of ["call.start", "call.step", "call.close"])
    installCtx.registerOp(op, async (/** @type {any} */ ctx) => {
      try {
        return await vanCall(ctx);
      } catch (error) {
        if (error instanceof ApiError && [400, 409, 422].includes(error.status))
          return ctx.reject("invalid_request");
        throw error;
      }
    });
}
