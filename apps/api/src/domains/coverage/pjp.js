import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import {
  access,
  bounded,
  dto,
  employeeAt,
  fail,
  localDate,
  loadPlan,
  manilaDate,
  outletAt,
  required,
  uuid,
  visiblePeople,
} from "./model.js";
import { digest, snapshotSlot, workflow } from "./workflow.js";
import { schedulePjp } from "./pjp-schedule.js";

/** @param {any} n @param {number} min @param {number} max */
function integer(n, min, max) {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    fail(`Enter a whole number from ${min} to ${max}`);
  return n;
}
/** @param {any} ctx @param {string} id @param {string} cap */
async function templateFor(ctx, id, cap) {
  const [t] = await ctx.db`select * from pjp_templates where id=${uuid(id)}`;
  if (!t) throw new ApiError("not_found", 404, "Journey plan not found");
  await access(ctx, t, cap);
  return t;
}
/** F-201: input projection is included in the simulation hash to refuse stale publication.
 * @param {any} ctx @param {any} t @param {string} month
 */
export async function simulatePjp(ctx, t, month) {
  const db = ctx.db;
  await access(ctx, t, "mcp.plan");
  const outlets = [];
  for (const stop of t.stops) {
    await outletAt(ctx, stop.outletId, ctx.now, "mcp.plan");
    const at = Math.max(
      +new Date(t.effective_from),
      localDate(month + "-01"),
      ctx.now,
    );
    const live = await outletAt(ctx, stop.outletId, at, "mcp.plan");
    if (
      live.outlet.status !== "active" ||
      live.outlet.enrolment_status === "provisional" ||
      live.outlet.enrolment_status === "rejected" ||
      !live.assignment?.route_id
    )
      fail("Only validated, routed active outlets belong in a journey plan");
    const [route] =
      await db`select name from routes where id=${live.assignment.route_id} and deleted_at is null`;
    const [pin] =
      await db`select latitude,longitude from outlet_pins where outlet_id=${stop.outletId} and status='verified' and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
    // SEAM(MASTERS): current outlets.classification is the existing taxonomy key.
    // Replace this read with the effective-dated class resolver when integrated.
    outlets.push({
      ...live.outlet,
      route_id: live.assignment.route_id,
      territory_id: live.assignment.territory_id,
      sequence: live.assignment.sequence,
      route_name: route?.name,
      latitude: pin?.latitude ?? null,
      longitude: pin?.longitude ?? null,
    });
  }
  const policies =
    await db`select * from outlet_class_visit_policies where org_unit_id=${t.org_unit_id} order by class_key,effective_from`;
  const result = schedulePjp(t, outlets, policies, month);
  if (!result.slots.length) fail("No visits in the selected period");
  // The existing signed-plan checker also validates future employee, route,
  // territory, pin and current scope, before a simulation is accepted.
  const fake = {
    assignee_profile_id: t.assignee_profile_id,
    org_unit_id: t.org_unit_id,
  };
  const snapshots = [];
  for (const s of result.slots)
    snapshots.push(
      await snapshotSlot(
        ctx,
        fake,
        {
          ...s,
          service_date: s.serviceDate,
          outlet_id: s.outletId,
          route_id: s.routeId,
          required_objectives: s.requiredObjectives,
        },
        "mcp.plan",
      ),
    );
  const previous =
    await db`select count(*)::int as visits,coalesce(sum(s.expected_duration_minutes),0)::int as minutes from coverage_plan_slots s join coverage_plans p on p.id=s.plan_id where p.assignee_profile_id=${t.assignee_profile_id} and p.local_month=${month} and p.status in ('active','approved') and s.deleted_at is null and s.kind='outlet_visit'`;
  return {
    hash: digest({ template: t, outlets, policies, result, snapshots }),
    result: {
      ...result,
      policySnapshots: policies,
      previous: {
        visits: previous[0].visits,
        serviceMinutes: previous[0].minutes,
      },
    },
  };
}
/** @param {any} ctx @param {any} b */
async function savePolicy(ctx, b) {
  const db = ctx.db;
  await requireCapability(ctx, "masterdata.manage", uuid(b.orgUnitId));
  const from = localDate(b.fromDate),
    to = b.toDate ? localDate(b.toDate) : null;
  if (from < localDate(manilaDate(ctx.now)) || (to != null && to <= from))
    fail("Policy must start today or later, with a later end");
  if (![1, 2, 4].includes(b.intervalWeeks))
    fail("Choose a one, two or four week frequency");
  if (
    !Array.isArray(b.objectives) ||
    b.objectives.length > 30 ||
    b.objectives.some(
      (/** @type {any} */ s) =>
        typeof s !== "string" || !s.trim() || s.length > 500,
    )
  )
    fail("Objectives must be short text, at most 30");
  await db`select pg_advisory_xact_lock(hashtextextended('coverage:master-lock',0))`;
  await db`select pg_advisory_xact_lock(hashtextextended(${`pjp:policy:${b.orgUnitId}:${b.classKey}`},0))`;
  if (b.replacesPolicyId) {
    const [old] =
      await db`select * from outlet_class_visit_policies where id=${uuid(b.replacesPolicyId)} for update`;
    if (
      !old ||
      old.org_unit_id !== b.orgUnitId ||
      old.class_key !== b.classKey ||
      +new Date(old.effective_from) >= from ||
      (old.effective_to && +new Date(old.effective_to) < from)
    )
      fail("Choose the previous policy in this class and a later start date");
    await db`update outlet_class_visit_policies set effective_to=${new Date(from)},updated_at=${new Date(ctx.now)} where id=${old.id}`;
  }
  const overlap =
    await db`select id from outlet_class_visit_policies where org_unit_id=${b.orgUnitId} and class_key=${b.classKey} and (effective_to is null or effective_to>${new Date(from)}) and (${to == null} or effective_from<${to == null ? null : new Date(to)})`;
  if (overlap.length)
    fail(
      "A policy already covers this interval; select it as the policy to replace",
    );
  const [p] =
    await db`insert into outlet_class_visit_policies(org_unit_id,class_key,label,interval_weeks,service_minutes,objectives,effective_from,effective_to,source_ref,created_by) values (${b.orgUnitId},${required(b.classKey, "Outlet class")},${required(b.label, "Policy name")},${b.intervalWeeks},${integer(b.serviceMinutes, 1, 480)},${db.array(b.objectives, "TEXT")},${new Date(from)},${to == null ? null : new Date(to)},${required(b.sourceRef, "Source or sample marker")},${ctx.actor.profileId}) returning *`;
  return dto(p);
}
/** @param {any} ctx @param {any} b */
async function saveTemplate(ctx, b) {
  const db = ctx.db;
  const a = await employeeAt(db, uuid(b.assigneeProfileId), ctx.now);
  await access(
    ctx,
    { ...a, assignee_profile_id: b.assigneeProfileId },
    "mcp.plan",
  );
  const from = localDate(b.fromDate),
    to = localDate(b.toDate),
    anchor = localDate(b.anchorDate);
  if (
    from < localDate(manilaDate(ctx.now)) ||
    to <= from ||
    to - from > 366 * 86400000
  )
    fail("Template must be prospective and at most one year");
  if (new Date(anchor + 28800000).getUTCDay() !== 1)
    fail("Cycle anchor must be a Monday");
  if (
    !Array.isArray(b.sellingWeekdays) ||
    !b.sellingWeekdays.length ||
    b.sellingWeekdays.length > 7 ||
    new Set(b.sellingWeekdays).size !== b.sellingWeekdays.length
  )
    fail("Choose distinct selling weekdays");
  for (const n of b.sellingWeekdays) integer(n, 0, 6);
  if (!Array.isArray(b.stops) || !b.stops.length)
    fail("Choose the outlets for the beat cycle");
  bounded(b.stops);
  const stops = [];
  for (const stop of b.stops) {
    uuid(stop.outletId);
    await outletAt(ctx, stop.outletId, ctx.now, "mcp.plan");
    stops.push({
      outletId: stop.outletId,
      ...(stop.weekday == null ? {} : { weekday: integer(stop.weekday, 0, 6) }),
      ...(stop.phaseWeek == null
        ? {}
        : { phaseWeek: integer(stop.phaseWeek, 0, 3) }),
    });
  }
  if (new Set(stops.map((s) => s.outletId)).size !== stops.length)
    fail("Duplicate outlet in beat cycle");
  await db`select pg_advisory_xact_lock(hashtextextended(${`pjp:${b.assigneeProfileId}`},0))`;
  const [v] =
    await db`select coalesce(max(version),0)+1 as n from pjp_templates where assignee_profile_id=${b.assigneeProfileId}`;
  const [t] =
    await db`insert into pjp_templates(org_unit_id,assignee_profile_id,name,version,anchor_date,effective_from,effective_to,capacity_minutes,travel_minutes,selling_weekdays,stops,created_by) values (${a.org_unit_id},${b.assigneeProfileId},${required(b.name, "Template name")},${v.n},${b.anchorDate},${new Date(from)},${new Date(to)},${integer(b.capacityMinutes, 1, 1440)},${integer(b.travelMinutes, 0, 240)},${db.array(b.sellingWeekdays, "SMALLINT")},${stops},${ctx.actor.profileId}) returning *`;
  return dto(t);
}
/** Stored and current scope both apply to discovery after a person moves.
 * @param {any} ctx @param {any[]} rows */
async function visiblePlans(ctx, rows) {
  const result = [];
  for (const row of rows) {
    try {
      await access(ctx, row);
      result.push(row);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
    }
  }
  return result;
}
/** @param {any} ctx @param {any} b */
export async function pjpRead(ctx, b) {
  const people = await visiblePeople(ctx),
    ids = people.map((/** @type {any} */ p) => p.id);
  const templates = await visiblePlans(
    ctx,
    ids.length
      ? bounded(
          await ctx.db`select t.*,p.name as assignee_name from pjp_templates t join profiles p on p.id=t.assignee_profile_id where t.assignee_profile_id in ${ctx.db(ids)} order by t.created_at desc limit 501`,
        )
      : [],
  );
  const units = [
    ...new Set(people.map((/** @type {any} */ p) => p.current_unit_id)),
  ];
  const policies = units.length
    ? bounded(
        await ctx.db`select * from outlet_class_visit_policies where org_unit_id in ${ctx.db(units)} order by class_key,effective_from limit 501`,
      )
    : [];
  const publications = templates.length
    ? bounded(
        await ctx.db`select x.*,p.status,p.version,p.local_month,p.content_hash from pjp_publications x join coverage_plans p on p.id=x.plan_id where x.template_id in ${ctx.db(templates.map((/** @type {any} */ t) => t.id))} order by x.created_at desc limit 501`,
      )
    : [];
  const existingPlans = await visiblePlans(
    ctx,
    ids.length
      ? bounded(
          await ctx.db`select id,assignee_profile_id,org_unit_id,local_month,version,effective_from,status from coverage_plans where assignee_profile_id in ${ctx.db(ids)} and status in ('approved','active') and deleted_at is null order by local_month desc,version desc limit 501`,
        )
      : [],
  );
  return {
    existingPlans: dto(existingPlans),
    people: dto(people),
    templates: dto(templates),
    policies: dto(policies),
    publications: dto(publications),
  };
}
/** F-201/F-202: all writes use the existing idempotency ledger and signed workflow.
 * @param {any} ctx @param {any} platform @param {string} action @param {any} b
 */
export async function pjpCommand(ctx, platform, action, b) {
  const key = required(b.idempotencyKey, "Idempotency key"),
    hash = digest({ action, b });
  const response = await tx(ctx.db, async (db) => {
    const [p] =
      await db`select * from profiles where id=${ctx.actor?.profileId ?? null} and user_id=${ctx.actor?.userId ?? null} and status='active' and deleted_at is null for share`;
    if (!p)
      throw new ApiError("forbidden", 403, "Your access is no longer active");
    const c = {
      ...ctx,
      db,
      actor: { ...ctx.actor, role: p.role, orgUnitId: p.org_unit_id },
    };
    const cap =
      action === "policy"
        ? "masterdata.manage"
        : action === "publish"
          ? "mcp.approve"
          : "mcp.plan";
    await requireCapability(c, cap);
    const t = b.templateId ? await templateFor(c, b.templateId, cap) : null;
    if (b.orgUnitId) await requireCapability(c, cap, uuid(b.orgUnitId));
    if (b.assigneeProfileId) {
      const a = await employeeAt(db, uuid(b.assigneeProfileId), ctx.now);
      await access(c, { ...a, assignee_profile_id: b.assigneeProfileId }, cap);
    }
    if (b.planId) await access(c, await loadPlan(db, b.planId), cap);
    await db`select pg_advisory_xact_lock(hashtextextended(${`pjp:command:${p.id}:${key}`},0))`;
    const [old] =
      await db`select * from coverage_commands where actor_id=${p.id} and command_key=${key}`;
    if (old) {
      if (old.payload_hash !== hash)
        throw new ApiError(
          "idempotency_conflict",
          409,
          "Command key was used with different content",
        );
      return old.response;
    }
    let result;
    if (action === "policy") result = await savePolicy(c, b);
    else if (action === "template") result = await saveTemplate(c, b);
    else if (action === "simulate") {
      if (!t) fail("Select a journey plan");
      const simulation = await simulatePjp(c, t, b.month);
      const [s] =
        await db`insert into pjp_simulations(template_id,local_month,input_hash,result,created_by) values (${t.id},${b.month},${simulation.hash},${simulation.result},${p.id}) returning id`;
      result = { simulationId: s.id, ...simulation };
    } else if (action === "generate") {
      if (!t) fail("Select a journey plan");
      // Serialize against ordinary coverage approval/master edits too.
      await db`select pg_advisory_xact_lock(hashtextextended('coverage:master-lock',0))`;
      const [s] =
        await db`select * from pjp_simulations where id=${uuid(b.simulationId)} and template_id=${t.id}`;
      if (!s || s.created_by !== p.id)
        fail("Simulate this journey plan before generating");
      const simulation = await simulatePjp(c, t, s.local_month);
      if (simulation.hash !== s.input_hash)
        fail("Plan inputs changed; simulate again");
      if (simulation.result.overloadedDays.length)
        fail("Balance overloaded days before publication");
      const r = simulation.result;
      if (b.basedOnPlanId) {
        const prior = await loadPlan(db, b.basedOnPlanId);
        await access(c, prior, "mcp.plan");
        if (
          prior.assignee_profile_id !== t.assignee_profile_id ||
          prior.local_month !== s.local_month ||
          !["approved", "active"].includes(prior.status) ||
          +new Date(prior.effective_from) >= localDate(r.fromDate)
        )
          fail("Choose an earlier signed plan for this rep and month");
      }
      const created = await workflow(c, "create", {
        assigneeProfileId: t.assignee_profile_id,
        localMonth: s.local_month,
        effectiveFromDate: r.fromDate,
        basedOnPlanId: b.basedOnPlanId ?? null,
        reason: b.reason ?? "Generated permanent journey plan",
      });
      await workflow(c, "setAssignment", {
        planId: created._id,
        effectiveFrom: localDate(r.fromDate),
        effectiveTo: localDate(r.toDate),
        reason: "Permanent journey plan interval",
      });
      await workflow(c, "saveOutlets", {
        planId: created._id,
        outlets: r.outlets,
      });
      await workflow(c, "saveSlots", { planId: created._id, slots: r.slots });
      const source = {
        templateId: t.id,
        templateVersion: t.version,
        simulationId: s.id,
        inputHash: s.input_hash,
        anchorDate: t.anchor_date,
        assignments: r.assignments,
        policySnapshots: r.policySnapshots,
        policyIds: [
          ...new Set(r.slots.map((/** @type {any} */ s) => s.policyId)),
        ],
        travelMinutes: r.travelMinutes,
        capacityMinutes: t.capacity_minutes,
      };
      await db`update coverage_plans set pjp_source=${source} where id=${created._id}`;
      result = await workflow(c, "submit", { planId: created._id });
      await db`insert into pjp_publications(template_id,simulation_id,plan_id) values (${t.id},${s.id},${created._id})`;
      await platform.recordChange(db, {
        entity: "coverage_plans",
        entityId: created._id,
        scopeKey: t.org_unit_id,
      });
    } else if (action === "publish") {
      const plan = await loadPlan(db, b.planId, true);
      if (!plan.pjp_source)
        fail("Use the existing approval action for manual plans");
      result = await workflow(c, "approve", { planId: plan.id });
      await platform.recordChange(db, {
        entity: "coverage_plans",
        entityId: plan.id,
        scopeKey: plan.org_unit_id,
      });
    } else fail("Unknown journey planning action");
    await db`insert into coverage_commands(actor_id,command_key,payload_hash,response) values (${p.id},${key},${hash},${result})`;
    const unit = t?.org_unit_id ?? b.orgUnitId ?? p.org_unit_id;
    if (unit)
      await db`insert into pjp_events(org_unit_id,actor_id,kind,entity_id,detail) values (${unit},${p.id},${action},${result._id ?? result.simulationId ?? p.id},${{ templateId: t?.id ?? null, month: b.month ?? null }})`;
    return result;
  });
  await ctx.publish("coverage");
  return response;
}
/** Used by every coverage approval entry, including the original manual endpoint.
 * @param {any} ctx @param {any} plan */
export async function validatePjpPublication(ctx, plan) {
  const current = await simulatePjp(
    ctx,
    await templateFor(ctx, plan.pjp_source.templateId, "mcp.approve"),
    plan.local_month,
  );
  if (current.hash !== plan.pjp_source.inputHash)
    fail("Plan inputs changed; create a new simulation and plan");
}
/** @param {any} router @param {any} platform */
export function installPjp(router, platform) {
  router.get("/api/v1/coverage/pjp", (/** @type {any} */ c) =>
    tx(c.db, (db) => pjpRead({ ...c, db }, {})),
  );
  for (const action of [
    "policy",
    "template",
    "simulate",
    "generate",
    "publish",
  ])
    router.post(`/api/v1/coverage/pjp/${action}`, (/** @type {any} */ c) =>
      pjpCommand(c, platform, action, c.body ?? {}),
    );
}
