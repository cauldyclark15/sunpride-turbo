import { requireCapability } from "../../core/capabilities.js";
import { canonicalJson } from "../../core/util.js";
import {
  beginCall,
  closeCall,
  definitionAt,
  fieldAdapter,
  ownedCall,
  PROFILE_FIELD,
  profileAt,
} from "../callflow/engine.js";
import { rulesAt, missingKinds, ACTIVITY_KINDS } from "./rules.js";
import { recordLocation } from "./location.js";
import { validateAccountCapture } from "./capture.js";
import { recordEntries } from "../fieldreports/call-sheets.js";
import { isProductive, RULE_VERSION } from "./productive.js";
import {
  ORGANIZATION,
  DAY,
  OPEN,
  INTENTS,
  reject,
  uuid,
  text,
  date,
  manilaDate,
  ms,
  validTime,
  accessOutlet,
  employeeAt,
  ownedVisit,
  event,
  changed,
  touchVisit,
  product,
} from "./shared.js";

/** @param {any} ctx */
export async function checkIn(ctx) {
  const p = ctx.payload;
  if (!["field-android", "field-ios"].includes(ctx.app))
    reject("unsupported_operation");
  uuid(p.clientVisitId);
  uuid(p.outletId);
  date(p.serviceDate);
  validTime(p.deviceTime, ctx.now);
  if (
    p.serviceDate !== manilaDate(p.deviceTime) ||
    p.serviceDate > manilaDate(ctx.now) ||
    p.serviceDate < manilaDate(ctx.now - 7 * DAY)
  )
    reject("wrong_date");
  if (
    !Array.isArray(p.intents) ||
    p.intents.some((/** @type {any} */ i) => !INTENTS.includes(i)) ||
    new Set(p.intents).size !== p.intents.length
  )
    reject();
  await requireCapability(ctx, "visit.record", ctx.actor.orgUnitId);
  const employee = await employeeAt(ctx.db, ctx.actor.profileId, ctx.now);
  const { outlet, owner } = await accessOutlet(ctx, p.outletId, "visit.record");
  if (
    outlet.status !== "active" ||
    owner !== employee.org_unit_id ||
    owner !== ctx.actor.orgUnitId
  )
    reject("out_of_scope");
  // Serializes two distinct check-in op IDs as well as dependent writes on this person's day.
  await ctx.db`select pg_advisory_xact_lock(hashtext(${`visits:${ctx.actor.profileId}`}))`;
  const assignments =
    await ctx.db`select a.* from outlet_assignments a join territory_salespeople s on s.territory_id=a.territory_id
    join territories t on t.id=a.territory_id
    where a.outlet_id=${p.outletId} and s.profile_id=${ctx.actor.profileId} and t.status='active'
    and a.deleted_at is null and s.deleted_at is null and t.deleted_at is null
    and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
    and s.effective_from<=${new Date(ctx.now)} and (s.effective_to is null or s.effective_to>${new Date(ctx.now)})`;
  if (assignments.length !== 1) reject("out_of_scope");
  const assignment = assignments[0];
  if (assignment.route_id) {
    const route =
      await ctx.db`select 1 from routes where id=${assignment.route_id} and status='active' and deleted_at is null and effective_from<=${new Date(ctx.now)}`;
    if (!route.length) reject("out_of_scope");
  }
  const calls =
    await ctx.db`select * from visit_executions where assignee_profile_id=${ctx.actor.profileId} and service_date=${p.serviceDate} and deleted_at is null`;
  if (calls.length >= 200) reject();
  if (calls.some((/** @type {any} */ v) => OPEN.includes(v.state)))
    reject("call_open");
  const same =
    await ctx.db`select 1 from visit_executions where organization_id=${ORGANIZATION} and client_visit_id=${p.clientVisitId}`;
  if (same.length) reject("idempotency_conflict");
  let planned = null;
  let deviated = false;
  if (p.plannedVisitId != null) {
    const [row] =
      await ctx.db`select v.*, s.sequence, s.approved_snapshot as slot_snapshot, s.service_date as slot_date,
      s.assignee_profile_id as slot_assignee, c.status as plan_status, c.version as actual_version, c.org_unit_id,
      c.approval_signature,c.assignee_profile_id as plan_assignee,c.active_through
      from planned_visits v join coverage_plan_slots s on s.id=v.plan_slot_id join coverage_plans c on c.id=v.plan_id
      where v.id=${uuid(p.plannedVisitId)} and v.deleted_at is null and s.deleted_at is null and c.deleted_at is null`;
    if (
      !row ||
      row.status !== "planned" ||
      row.replaced_by_visit_id ||
      row.assignee_profile_id !== ctx.actor.profileId ||
      row.outlet_id !== p.outletId ||
      dateString(row.service_date) !== p.serviceDate ||
      dateString(row.slot_date) !== p.serviceDate ||
      row.slot_assignee !== ctx.actor.profileId ||
      row.plan_status !== "active" ||
      !row.approval_signature ||
      row.plan_version !== row.actual_version ||
      row.plan_assignee !== ctx.actor.profileId ||
      row.org_unit_id !== owner ||
      (row.active_through && ms(row.active_through) <= ctx.now) ||
      canonicalJson(row.approved_snapshot) !==
        canonicalJson(row.slot_snapshot) ||
      row.approved_snapshot.outletId !== p.outletId ||
      row.approved_snapshot.orgUnitId !== owner ||
      row.approved_snapshot.approvedAssigneeProfileId !== ctx.actor.profileId ||
      canonicalJson(p.intents) !== canonicalJson(row.intents)
    )
      reject("invalid_plan");
    const serviceEmployee = await employeeAt(
      ctx.db,
      ctx.actor.profileId,
      Date.parse(`${p.serviceDate}T00:00:00+08:00`),
    );
    if (serviceEmployee.id !== row.approved_snapshot.employeeAssignmentId)
      reject("invalid_plan");
    if (
      calls.some(
        (/** @type {any} */ c) => c.planned_visit_id === p.plannedVisitId,
      )
    )
      reject("idempotency_conflict");
    const earlier =
      await ctx.db`select v.id from planned_visits v join coverage_plan_slots s on s.id=v.plan_slot_id
      where v.assignee_profile_id=${ctx.actor.profileId} and v.service_date=${p.serviceDate} and v.status='planned' and v.deleted_at is null
      and v.replaced_by_visit_id is null and s.sequence<${row.sequence}
      and not exists(select 1 from visit_executions e where e.planned_visit_id=v.id and e.deleted_at is null
        and e.state in ('checked-out','completed','skipped','rescheduled','missed')) limit 1`;
    deviated = earlier.length > 0;
    if (
      deviated &&
      (!p.sequenceReason?.trim() ||
        !(await definitionAt(
          ctx.db,
          await profileAt(ctx.db, ctx.app, outlet, p.deviceTime),
          p.deviceTime,
        )))
    )
      reject("mcp_order");
    planned = row;
  } else text(p.unplannedReason, 500);
  const links =
    await ctx.db`select customer_id from outlet_customer_links where outlet_id=${p.outletId} and deleted_at is null
    and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`;
  if (links.length > 1) reject();
  const rules = await rulesAt(ctx.db, p.deviceTime);
  const [visit] =
    await ctx.db`insert into visit_executions (organization_id,client_visit_id,planned_visit_id,plan_id,slot_id,plan_version,
    assignee_profile_id,outlet_id,org_unit_id,route_id,customer_id,service_date,source,intents,state,unplanned_reason,productivity,rule_version,
    last_server_time,checked_in_at,started_at,recording_device_id,activity_rules_snapshot)
    values (${ORGANIZATION},${p.clientVisitId},${p.plannedVisitId ?? null},${planned?.plan_id ?? null},${planned?.plan_slot_id ?? null},${planned?.plan_version ?? null},
      ${ctx.actor.profileId},${p.outletId},${owner},${assignment.route_id},${links[0]?.customer_id ?? null},${p.serviceDate},${planned ? "planned" : "unplanned"},
      array(select jsonb_array_elements_text(${{ values: p.intents }}::jsonb->'values')),'checked-in',${planned ? null : text(p.unplannedReason, 500)},'pending',${RULE_VERSION},${new Date(ctx.now)},${new Date(ctx.now)},${new Date(p.deviceTime)},${ctx.device.id},${{ rules }}::jsonb->'rules') returning *`;
  await beginCall(ctx, {
    channelProfile: PROFILE_FIELD,
    clientCallId: p.clientVisitId,
    outlet,
    unitId: owner,
    visitId: visit.id,
    serviceDate: p.serviceDate,
    planned: !!planned,
    plannedVisitId: p.plannedVisitId,
    sequence: planned?.sequence,
    deviated,
  });
  await recordLocation(ctx, visit, "check_in", p.location, p.deviceTime);
  await touchVisit(ctx, visit);
  const eventId = await event(
    ctx,
    visit,
    "visit",
    visit.id,
    "visit.checked_in",
    { after: "checked-in" },
  );
  await changed(ctx, visit);
  return { entityId: visit.id, eventIds: [eventId] };
}
/** @param {any} value */
export const dateString = (value) => new Date(value).toISOString().slice(0, 10);
/** @param {any} ctx @param {any} a */
async function validateActivity(ctx, a) {
  if (!a || !ACTIVITY_KINDS.includes(a.kind)) reject();
  if (a.kind === "note") text(a.text, 2000);
  if (a.kind === "merchandising") {
    if (
      !["compliant", "needs_action", "not_present"].includes(a.displayCondition)
    )
      reject();
    if (a.actionTaken !== undefined) text(a.actionTaken, 500);
  }
  if (a.kind === "promotion") {
    text(a.programRef);
    if (!["executed", "not_executed", "not_applicable"].includes(a.finding))
      reject();
  }
  if (["inventory_check", "price_check"].includes(a.kind))
    await product(ctx.db, a.productId);
  if (a.kind === "inventory_check") {
    if (
      !["present", "absent", "unknown"].includes(a.icoFinding) ||
      (a.observedQuantity !== undefined &&
        (!Number.isFinite(a.observedQuantity) ||
          a.observedQuantity < 0 ||
          a.observedQuantity > 1e9))
    )
      reject();
    if (a.uomId) {
      const rows =
        await ctx.db`select 1 from units_of_measure where id=${uuid(a.uomId)}`;
      if (!rows.length) reject();
    }
  }
  if (
    a.kind === "price_check" &&
    (!Number.isSafeInteger(a.observedPriceMinor) ||
      a.observedPriceMinor < 0 ||
      !/^[A-Z]{3}$/.test(a.currency) ||
      (a.compliant !== undefined && typeof a.compliant !== "boolean"))
  )
    reject();
  if (a.kind === "call_sheet" || a.kind === "order_intent") {
    if (
      !Array.isArray(a.lines) ||
      a.lines.length < 1 ||
      a.lines.length > 100 ||
      new Set(a.lines.map((/** @type {any} */ l) => l.productId)).size !==
        a.lines.length
    )
      reject();
    for (const line of a.lines) {
      await product(ctx.db, line.productId);
      if (a.kind === "call_sheet") {
        const keys = [
          "order",
          "beginningInventory",
          "take",
          "delivered",
          "offtake",
          "endInventory",
        ];
        for (const key of keys)
          if (
            line[key] !== null &&
            (!Number.isSafeInteger(line[key]) ||
              line[key] < 0 ||
              line[key] > 1000000)
          )
            reject();
        if (keys.every((key) => line[key] === null)) reject();
      } else if (
        typeof line.uom !== "string" ||
        line.uom.trim() !== line.uom ||
        line.uom.length < 1 ||
        line.uom.length > 20 ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 99999
      )
        reject();
    }
    if (a.kind === "order_intent") {
      uuid(a.clientOrderId);
      if (a.note !== undefined) text(a.note, 500);
    }
  }
}
/** @param {any} ctx */
export async function activity(ctx) {
  const p = ctx.payload;
  validTime(p.deviceTime, ctx.now);
  const visit = await ownedVisit(ctx, p.visitId);
  await validateActivity(ctx, p.activity);
  // F-310: an execution-only profile cannot smuggle a commercial order through a bonus activity.
  if (p.activity.kind === "order_intent") {
    const call = await ownedCall(ctx, { visitId: visit.id });
    if (call?.definition_snapshot.channelProfile === "merchandiser")
      reject("unsupported_operation");
  }
  await validateAccountCapture(ctx, visit, p.activity);
  if (p.activity.kind === "order_intent") {
    if (p.deviceTime < ms(visit.started_at)) reject();
    const prior =
      await ctx.db`select 1 from visit_activities where activity_kind='order_intent' and activity->>'clientOrderId'=${p.activity.clientOrderId}`;
    if (prior.length) reject("idempotency_conflict");
  }
  const [{ n }] =
    await ctx.db`select count(*)::int as n from visit_activities where visit_id=${visit.id}`;
  if (n >= 500) reject();
  const [row] =
    await ctx.db`insert into visit_activities (organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time)
    values (${ORGANIZATION},${visit.org_unit_id},${visit.id},${ctx.actor.profileId},${visit.outlet_id},${p.activity.kind},${p.activity},${new Date(p.deviceTime)},${new Date(ctx.now)}) returning id`;
  if (p.activity.kind === "call_sheet") {
    await recordEntries(
      ctx,
      { activityId: row.id },
      {
        recordChange: (/** @type {any} */ _db, /** @type {any} */ change) =>
          ctx.change(
            change.entity,
            change.entityId,
            change.scopeKey,
            change.op,
          ),
      },
    );
    ctx.publish("call_sheets");
  }
  await fieldAdapter(ctx, visit.id, p.activity.kind, row.id);
  await ctx.db`update visit_executions set state='in-progress' where id=${visit.id}`;
  await touchVisit(ctx, visit);
  const eventId = await event(
    ctx,
    visit,
    "activity",
    row.id,
    `activity.${p.activity.kind}`,
    { after: p.activity.kind },
  );
  await ctx.change("activity", row.id, visit.org_unit_id);
  await changed(ctx, visit);
  return { entityId: row.id, eventIds: [eventId] };
}
/** @param {any} ctx */
export async function checkOut(ctx) {
  const p = ctx.payload;
  validTime(p.deviceTime, ctx.now);
  const visit = await ownedVisit(ctx, p.visitId);
  if (
    !["completed", "nonproductive"].includes(p.outcome) ||
    p.deviceTime < ms(visit.started_at)
  )
    reject("invalid_transition");
  if (p.outcome === "nonproductive" || p.reasonCode) text(p.reasonCode);
  const rows =
    await ctx.db`select activity_kind from visit_activities where visit_id=${visit.id} and deleted_at is null order by server_time,id limit 501`;
  if (rows.length > 500) reject();
  const rules =
    visit.activity_rules_snapshot ??
    (await rulesAt(ctx.db, ms(visit.started_at)));
  const missing =
    p.outcome === "completed"
      ? missingKinds(
          rules,
          visit.intents,
          rows.map((/** @type {any} */ r) => r.activity_kind),
        )
      : [];
  const [{ n }] =
    await ctx.db`select count(*)::int as n from field_collections where visit_id=${visit.id} and status='recorded' and deleted_at is null`;
  const person = await employeeAt(
    ctx.db,
    ctx.actor.profileId,
    ms(visit.started_at),
  );
  const [standard] = person.position_id
    ? await ctx.db`select productive_call_rule from position_standards where position_id=${person.position_id} and deleted_at is null
    and effective_from<=${visit.started_at} and (effective_to is null or effective_to>${visit.started_at})`
    : [];
  const evaluated = isProductive(
    {
      inRoutePlan: !!visit.planned_visit_id,
      state: "checked-out",
      activityKinds: rows.map((/** @type {any} */ r) => r.activity_kind),
      collectionCount: n,
      reasonCode: p.reasonCode,
    },
    { productiveCallRule: standard?.productive_call_rule },
  );
  // Productive evidence is distinct from location/per-diem certification: verified is not inferred from outcome.
  const productivity =
    p.outcome === "nonproductive" || !evaluated.productive
      ? "nonproductive"
      : "pending";
  await closeCall(ctx, await ownedCall(ctx, { visitId: visit.id }));
  await recordLocation(ctx, visit, "check_out", p.location, p.deviceTime);
  await ctx.db`update visit_executions set state='checked-out',outcome=${p.outcome},reason_code=${p.reasonCode ?? null},
    activity_rule_version=${rules
      .filter((/** @type {any} */ r) => visit.intents.includes(r.intent))
      .map((/** @type {any} */ r) => `${r.intent}=${r.version}`)
      .join(",")},
    missing_activities=array(select jsonb_array_elements_text(${{ values: missing }}::jsonb->'values')),checked_out_at=${new Date(ctx.now)},ended_at=${new Date(p.deviceTime)},call_duration_ms=${p.deviceTime - ms(visit.started_at)},productivity=${productivity} where id=${visit.id}`;
  await touchVisit(ctx, visit);
  const eventId = await event(
    ctx,
    visit,
    "visit",
    visit.id,
    "visit.checked_out",
    { before: visit.state, after: "checked-out" },
  );
  await changed(ctx, visit);
  return { entityId: visit.id, eventIds: [eventId] };
}
/** Additive collection contract; no current native form sends it yet. @param {any} ctx */
export async function collection(ctx) {
  const p = ctx.payload;
  validTime(p.deviceTime, ctx.now);
  const visit = await ownedVisit(ctx, p.visitId);
  if (
    !visit.customer_id ||
    !Number.isSafeInteger(p.amountMinor) ||
    p.amountMinor <= 0 ||
    p.currency !== "PHP" ||
    !["cash", "cheque", "bank_transfer", "ewallet"].includes(p.method)
  )
    reject();
  if (
    p.deviceTime < ms(visit.started_at) ||
    manilaDate(p.deviceTime) !== dateString(visit.service_date)
  )
    reject("wrong_date");
  const [{ n }] =
    await ctx.db`select count(*)::int as n from field_collections where visit_id=${visit.id}`;
  if (n >= 500) reject();
  const reference = text(p.reference);
  const [row] =
    await ctx.db`insert into field_collections (organization_id,org_unit_id,customer_id,outlet_id,visit_id,assignee_profile_id,amount_minor,currency,method,reference,status,device_time,server_time)
    values (${ORGANIZATION},${visit.org_unit_id},${visit.customer_id},${visit.outlet_id},${visit.id},${ctx.actor.profileId},${p.amountMinor},'PHP',${p.method},${reference},'recorded',${new Date(p.deviceTime)},${new Date(ctx.now)}) returning id`;
  await touchVisit(ctx, visit);
  const eventId = await event(
    ctx,
    visit,
    "collection",
    row.id,
    "collection.recorded",
    { after: "recorded" },
  );
  await fieldAdapter(ctx, visit.id, "collection", row.id);
  await ctx.change("collection", row.id, visit.org_unit_id);
  await changed(ctx, visit, "collection");
  return { entityId: row.id, eventIds: [eventId] };
}
/** @param {any} ctx */
export async function completeTask(ctx) {
  const p = ctx.payload;
  validTime(p.deviceTime, ctx.now);
  const visit = await ownedVisit(ctx, p.visitId);
  const [task] =
    await ctx.db`select * from field_tasks where id=${uuid(p.taskId)} for update`;
  if (
    !task ||
    task.organization_id !== ORGANIZATION ||
    task.org_unit_id !== visit.org_unit_id ||
    task.assignee_profile_id !== ctx.actor.profileId ||
    (task.outlet_id && task.outlet_id !== visit.outlet_id) ||
    (task.plan_id && task.plan_id !== visit.plan_id) ||
    (task.visit_id && task.visit_id !== visit.id) ||
    ms(task.effective_from) > p.deviceTime ||
    (task.effective_to && ms(task.effective_to) <= p.deviceTime)
  )
    reject("out_of_scope");
  if (task.status !== "open") reject("invalid_transition");
  const ids = p.evidenceIds ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 20 ||
    new Set(ids).size !== ids.length
  )
    reject();
  for (const [ordinal, id] of ids.entries()) {
    const [file] =
      await ctx.db`select 1 from field_evidence_files where id=${uuid(id)} and visit_id=${visit.id} and owner_profile_id=${ctx.actor.profileId} and status<>'rejected'`;
    if (!file) reject("evidence_pending_review");
    await ctx.db`insert into field_task_evidence (field_task_id,ordinal,evidence_file_id) values (${task.id},${ordinal},${id})`;
  }
  await ctx.db`update field_tasks set status='completed',completed_at=${new Date(ctx.now)},visit_id=${visit.id} where id=${task.id}`;
  const eventId = await event(ctx, visit, "task", task.id, "task.completed", {
    after: "completed",
  });
  await touchVisit(ctx, visit);
  await ctx.change("task", task.id, visit.org_unit_id);
  await changed(ctx, visit);
  return { entityId: task.id, eventIds: [eventId] };
}
