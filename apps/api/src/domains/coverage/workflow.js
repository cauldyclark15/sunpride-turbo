import { requireCapability } from "../../core/capabilities.js";
import {
  access,
  audit,
  bounded,
  civil,
  DAY,
  dto,
  employeeAt,
  fail,
  loadPlan,
  localDate,
  manilaDate,
  monthBounds,
  monthDates,
  ORG,
  outletAt,
  planRows,
  PLAN_ROW_LIMIT,
  required,
  uuid,
} from "./model.js";
import { approvalCapacity } from "./approval.js";

/** @param {any} v @returns {string} */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object" && !(v instanceof Date))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
/** @param {any} v */
export const digest = (v) =>
  new Bun.CryptoHasher("sha256").update(canonical(v)).digest("hex");
/** @param {any} p */
function draft(p) {
  if (p.status !== "draft") fail("Only draft plans can change");
}
/** @param {any} n @param {string} label @param {number} [min] */
function integer(n, label, min = 0) {
  if (!Number.isSafeInteger(n) || n < min || n > 100000)
    fail(`Invalid ${label}`);
  return n;
}
/** @param {any} a */
function texts(a = []) {
  if (
    !Array.isArray(a) ||
    a.length > 50 ||
    a.some((v) => typeof v !== "string" || v.length > 500)
  )
    fail("Invalid objectives or intents");
  return a;
}
/**
 * The assignee must serve the outlet: on its route, or (routeless) its territory.
 * Checked on add so the planner learns at once, not at approval (WEB-118).
 * @param {any} db @param {any} p @param {any} o @param {number} instant
 */
export async function assigneeCovers(db, p, o, instant) {
  const at = new Date(instant);
  const rows = o.routeId
    ? await db`select 1 from route_salespeople where route_id=${o.routeId} and profile_id=${p.assignee_profile_id} and deleted_at is null and effective_from<=${at} and (effective_to is null or effective_to>${at}) limit 1`
    : await db`select 1 from territory_salespeople where territory_id=${o.territoryId} and profile_id=${p.assignee_profile_id} and deleted_at is null and effective_from<=${at} and (effective_to is null or effective_to>${at}) limit 1`;
  if (!rows.length)
    fail(
      o.routeId
        ? "Outlet is on a route the assignee does not serve"
        : "Outlet is in a territory the assignee does not serve",
    );
}
/** @param {any} ctx @param {any} p @param {any[]} outlets */
async function saveOutlets(ctx, p, outlets) {
  draft(p);
  const db = ctx.db;
  if (!Array.isArray(outlets)) fail("Plan outlets must be an array");
  bounded(outlets, "Plan outlets", PLAN_ROW_LIMIT);
  if (outlets.some((o) => !o || typeof o !== "object" || Array.isArray(o)))
    fail("Invalid outlet row");
  if (new Set(outlets.map((o) => o.outletId)).size !== outlets.length)
    fail("Duplicate plan outlet");
  const instant = Math.max(+new Date(p.effective_from), ctx.now);
  for (const o of outlets) {
    await outletAt(ctx, o.outletId, ctx.now, "mcp.plan");
    const live = await outletAt(ctx, o.outletId, instant, "mcp.plan");
    if (
      live.outlet.status !== "active" ||
      live.assignment?.territory_id !== o.territoryId ||
      (live.assignment?.route_id ?? null) !== (o.routeId ?? null)
    )
      fail("Outlet assignment changed; use its effective territory and route");
    await assigneeCovers(db, p, o, instant);
    if (!["weekly", "biweekly", "monthly", "custom"].includes(o.frequency))
      fail("Invalid frequency");
    integer(o.priority ?? 0, "priority");
    integer(o.expectedDurationMinutes, "duration", 1);
    if (o.expectedDurationMinutes > 1440) fail("Invalid duration");
    if (o.sequence != null) integer(o.sequence, "sequence", 1);
    if (
      o.weekOrdinal != null &&
      (!Number.isInteger(o.weekOrdinal) ||
        o.weekOrdinal < 1 ||
        o.weekOrdinal > 5)
    )
      fail("Invalid week ordinal");
    if (
      !Array.isArray(o.preferredWeekdays) ||
      new Set(o.preferredWeekdays).size !== o.preferredWeekdays.length ||
      o.preferredWeekdays.some(
        /** @param {number} n */ (n) => !Number.isInteger(n) || n < 0 || n > 6,
      )
    )
      fail("Invalid weekdays");
    if (!Array.isArray(o.customLocalDates) || o.customLocalDates.length > 31)
      fail("Invalid custom dates");
    for (const d of [
      ...o.customLocalDates,
      ...(o.anchorLocalDate ? [o.anchorLocalDate] : []),
    ])
      if (
        localDate(d) < monthBounds(p.local_month).from ||
        localDate(d) >= monthBounds(p.local_month).to
      )
        fail("Outlet date outside month");
    texts(o.requiredObjectives);
  }
  await db`delete from coverage_plan_outlets where plan_id=${p.id}`;
  for (const o of outlets)
    await db`insert into coverage_plan_outlets (plan_id,outlet_id,route_id,territory_id,frequency,anchor_local_date,week_ordinal,preferred_weekdays,custom_local_dates,sequence,priority,expected_duration_minutes,required_objectives,visit_window,content_revision,updated_by)
  values (${p.id},${o.outletId},${o.routeId ?? null},${o.territoryId},${o.frequency},${o.anchorLocalDate ?? null},${o.weekOrdinal ?? null},${db.array(o.preferredWeekdays, "SMALLINT")},${db.array(o.customLocalDates, "DATE")},${o.sequence ?? null},${o.priority ?? 0},${o.expectedDurationMinutes},${db.array(o.requiredObjectives ?? [], "TEXT")},${o.visitWindow ?? null},${p.content_revision + 1},${ctx.actor.subject})`;
  // A removed outlet takes its dated visits with it; otherwise approval refuses
  // the plan for slots the planner no longer shows (WEB-118).
  const kept = outlets.map((o) => o.outletId);
  await db`delete from coverage_plan_slots where plan_id=${p.id} and kind='outlet_visit' and not (outlet_id = any(${db.array(kept, "UUID")}))`;
  await db`delete from coverage_plan_territories where coverage_plan_id=${p.id}`;
  let ordinal = 0;
  for (const id of new Set(outlets.map((o) => o.territoryId)))
    await db`insert into coverage_plan_territories(coverage_plan_id,ordinal,territory_id) values (${p.id},${ordinal++},${id})`;
}
/** @param {any} ctx @param {any} p @param {any[]} slots */
async function saveSlots(ctx, p, slots) {
  draft(p);
  if (!Array.isArray(slots)) fail("Plan slots must be an array");
  bounded(slots, "Plan slots", PLAN_ROW_LIMIT);
  if (slots.some((s) => !s || typeof s !== "object" || Array.isArray(s)))
    fail("Invalid slot row");
  const db = ctx.db;
  if (new Set(slots.map((s) => s.slotKey)).size !== slots.length)
    fail("Duplicate slot keys");
  for (const s of slots) {
    required(s.slotKey, "Slot key");
    integer(s.sequence, "sequence", 1);
    integer(s.expectedDurationMinutes, "duration");
    if (s.expectedDurationMinutes > 1440) fail("Invalid duration");
    if (
      s.namedTruckRef != null &&
      (typeof s.namedTruckRef !== "string" || s.namedTruckRef.length > 500)
    )
      fail("Invalid named truck");
    if (s.outletId != null) uuid(s.outletId);
    texts(s.requiredObjectives);
    texts(s.intents);
    const at = localDate(s.serviceDate);
    if (at < +new Date(p.effective_from) || at >= +new Date(p.effective_to))
      fail("Slot outside plan period");
    if (
      !["outlet_visit", "non_visit"].includes(s.kind) ||
      (s.kind === "outlet_visit") !== !!s.outletId
    )
      fail("Invalid slot kind/outlet combination");
    if (s.outletId) await outletAt(ctx, s.outletId, ctx.now, "mcp.plan");
    else required(s.activityKind, "Activity");
    if (s.routeId != null) uuid(s.routeId);
  }
  // Draft rows have never been published; signed rows are never edited.
  await db`delete from coverage_plan_slots where plan_id=${p.id}`;
  for (const s of slots)
    await db`insert into coverage_plan_slots(slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,route_id,activity_kind,named_truck_ref,required_objectives,intents,sequence,expected_duration_minutes,content_revision,updated_by)
  values (${s.slotKey},${p.id},${p.assignee_profile_id},${s.serviceDate},${s.kind},${s.outletId ?? null},${s.routeId ?? null},${s.activityKind ?? null},${s.namedTruckRef ?? null},${db.array(s.requiredObjectives ?? [], "TEXT")},${db.array(s.intents ?? [], "TEXT")},${s.sequence},${s.expectedDurationMinutes},${p.content_revision + 1},${ctx.actor.subject})`;
}
/** @param {any} ctx @param {any} p @param {any} s @param {string} [cap] */
export async function snapshotSlot(ctx, p, s, cap = "mcp.approve") {
  const db = ctx.db,
    date = civil(s).serviceDate,
    at = localDate(date),
    instant = new Date(at);
  if (at < localDate(manilaDate(ctx.now)))
    fail("Cannot approve elapsed service date");
  const employee = await employeeAt(
    db,
    p.assignee_profile_id,
    at,
    `Assignee not assigned on ${date}`,
  );
  await requireCapability(ctx, cap, employee.org_unit_id);
  if (employee.org_unit_id !== p.org_unit_id)
    fail(`Assignee unit changed on ${date}; revise plan`);
  if (s.kind === "non_visit") {
    const [position] = employee.position_id
      ? await db`select code from positions where id=${employee.position_id}`
      : [];
    if (
      position?.code === "DS" &&
      /work[ -]?with/i.test(s.activity_kind ?? "") &&
      !s.named_truck_ref?.trim()
    )
      fail("Distributor Specialist Work-With requires named truck");
    return null;
  }
  await outletAt(ctx, s.outlet_id, ctx.now, cap);
  const {
    outlet: o,
    assignment: a,
    owner,
    orgUnitId,
  } = await outletAt(ctx, s.outlet_id, at, cap);
  if (o.status !== "active" || !a)
    fail(`Outlet not active or assigned on ${date}`);
  if ((s.route_id ?? null) !== (a.route_id ?? null))
    fail("Slot route differs from outlet assignment");
  const [territory] =
    await db`select * from territories where id=${a.territory_id} and deleted_at is null and status='active' and effective_from<=${instant} and (effective_to is null or effective_to>${instant})`;
  if (!territory || !owner) fail("Territory inactive on service date");
  const [tp] =
    await db`select * from territory_salespeople where territory_id=${a.territory_id} and profile_id=${p.assignee_profile_id} and deleted_at is null and effective_from<=${instant} and (effective_to is null or effective_to>${instant})`;
  let route, rt, rp;
  if (s.route_id) {
    [route] =
      await db`select * from routes where id=${s.route_id} and deleted_at is null and status='active' and effective_from<=${instant} and (effective_to is null or effective_to>${instant})`;
    [rt] =
      await db`select * from route_territories where route_id=${s.route_id} and territory_id=${a.territory_id} and deleted_at is null and effective_from<=${instant} and (effective_to is null or effective_to>${instant})`;
    [rp] =
      await db`select * from route_salespeople where route_id=${s.route_id} and profile_id=${p.assignee_profile_id} and deleted_at is null and effective_from<=${instant} and (effective_to is null or effective_to>${instant})`;
    if (!route || !rt || !rp)
      fail("Route not active or assigned to assignee on service date");
  } else if (!tp) fail("Territory not assigned to assignee on service date");
  const [link] =
    await db`select l.*,c.active,c.name,c.code from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${o.id} and l.deleted_at is null and l.effective_from<=${instant} and (l.effective_to is null or l.effective_to>${instant})`;
  if (link && !link.active) fail("Inactive customer link");
  return {
    outletId: o.id,
    outletCode: o.code,
    outletName: o.name,
    territoryId: territory.id,
    territoryCode: territory.code,
    routeId: route?.id ?? null,
    routeCode: route?.code ?? null,
    customerId: link?.customer_id ?? null,
    customerName: link?.name ?? null,
    customerCode: link?.code ?? null,
    outletCustomerLinkId: link?.id ?? null,
    outletAssignmentId: a.id,
    territoryOwnershipId: owner.id,
    territorySalespersonId: tp?.id ?? null,
    routeTerritoryId: rt?.id ?? null,
    routeSalespersonId: rp?.id ?? null,
    employeeAssignmentId: employee.id,
    orgUnitId,
    sequence: s.sequence,
    activityKind: s.activity_kind ?? "outlet_visit",
    approvedAssigneeProfileId: p.assignee_profile_id,
  };
}
/** @param {any} db @param {string} positionId @param {number} at */
export async function routinesAt(db, positionId, at) {
  if (!positionId) return [];
  const rows =
    await db`select * from position_routine_templates where position_id=${positionId} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by weekday`;
  for (const r of rows)
    r.activities =
      await db`select * from position_routine_template_activities where position_routine_template_id=${r.id} order by ordinal`;
  return rows;
}
/** @param {any} ctx @param {any} body */
async function create(ctx, body) {
  const db = ctx.db,
    { from: monthFrom, to } = monthBounds(body.localMonth),
    today = localDate(manilaDate(ctx.now));
  if (to <= ctx.now) fail("Cannot create a past-month plan");
  const from = body.effectiveFromDate
    ? localDate(body.effectiveFromDate)
    : Math.max(monthFrom, today);
  if (from < today || from < monthFrom || from >= to)
    fail("Revision cannot be backdated or outside month");
  const a = await employeeAt(
    db,
    body.assigneeProfileId,
    Math.max(from, ctx.now),
  );
  const current = await employeeAt(db, body.assigneeProfileId, ctx.now);
  const actor = await requireCapability(ctx, "mcp.plan", current.org_unit_id);
  await requireCapability(ctx, "mcp.plan", a.org_unit_id);
  if (actor.role === "sales" && actor.profileId !== body.assigneeProfileId)
    fail("Sales may create only own plan");
  await db`select pg_advisory_xact_lock(hashtextextended(${`coverage:person:${body.assigneeProfileId}:${body.localMonth}`},0))`;
  const [v] =
    await db`select coalesce(max(version),0)+1 as version from coverage_plans where assignee_profile_id=${body.assigneeProfileId} and local_month=${body.localMonth}`;
  const [p] =
    await db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,based_on_plan_id,revision_reason,prepared_by,prepared_at,content_revision,created_by,updated_by)
  values (${ORG},${body.assigneeProfileId},${body.localMonth},${v.version},'monthly',${a.org_unit_id},${new Date(from)},${new Date(to)},${new Date(from)},${new Date(to)},'draft',${body.basedOnPlanId ?? null},${body.reason ?? null},${actor.subject},${new Date(ctx.now)},1,${actor.subject},${actor.subject}) returning *`;
  await db`insert into coverage_assignments(plan_id,assignee_profile_id,org_unit_id,is_primary,effective_from,effective_to,actor_subject,reason) values (${p.id},${p.assignee_profile_id},${p.org_unit_id},true,${p.effective_from},${p.effective_to},${actor.subject},'Plan created')`;
  await audit(ctx, p, "plan.created", {}, { status: "draft" });
  return p;
}
/** Called within command transaction. @param {any} ctx @param {string} action @param {any} b */
export async function workflow(ctx, action, b) {
  const db = ctx.db;
  if (action === "create") return dto(await create(ctx, b));
  const p = await loadPlan(db, b.planId, true);
  await access(
    ctx,
    p,
    ["approve", "returnPlan", "activate"].includes(action)
      ? "mcp.approve"
      : "mcp.plan",
  );
  if (action === "createRevision") {
    if (!["approved", "active"].includes(p.status))
      fail("Revision requires approved or active plan");
    required(b.reason, "Revision reason");
    const next = await create(ctx, {
      ...b,
      localMonth: p.local_month,
      assigneeProfileId: p.assignee_profile_id,
      basedOnPlanId: p.id,
    });
    const old = await planRows(db, p.id);
    await saveOutlets(
      ctx,
      next,
      old.outlets.map((o) => {
        const d = dto(o);
        d.customLocalDates = o.custom_local_dates.map(
          /** @param {any} d */ (d) =>
            typeof d === "string"
              ? d.slice(0, 10)
              : d.toISOString().slice(0, 10),
        );
        return d;
      }),
    );
    await saveSlots(
      ctx,
      next,
      old.slots
        .map(civil)
        .filter(
          (s) => localDate(s.serviceDate) >= +new Date(next.effective_from),
        ),
    );
    return dto(next);
  }
  if (
    p.pjp_source &&
    ["saveOutlets", "saveSlots", "setAssignment", "applyToDraft"].includes(
      action,
    )
  )
    fail(
      "Generated journey plans are immutable; revise the template and simulate again",
    );
  if (action === "saveOutlets") await saveOutlets(ctx, p, b.outlets);
  else if (action === "saveSlots") await saveSlots(ctx, p, b.slots);
  else if (action === "setAssignment") {
    draft(p);
    required(b.reason, "Assignment reason");
    const from = Number(b.effectiveFrom),
      to = Number(b.effectiveTo),
      bounds = monthBounds(p.local_month);
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < localDate(manilaDate(ctx.now)) ||
      from < bounds.from ||
      to > bounds.to ||
      from >= to ||
      localDate(manilaDate(from)) !== from ||
      localDate(manilaDate(to)) !== to
    )
      fail("Invalid prospective Manila assignment interval");
    const a = await employeeAt(
      db,
      p.assignee_profile_id,
      Math.max(from, ctx.now),
    );
    if (a.org_unit_id !== p.org_unit_id)
      fail("Assignee unit changed; create a new scoped plan");
    await db`update coverage_plans set effective_from=${new Date(from)},effective_to=${new Date(to)} where id=${p.id}`;
    const moved =
      await db`update coverage_assignments set effective_from=${new Date(from)},effective_to=${new Date(to)},reason=${b.reason},actor_subject=${ctx.actor.subject} where plan_id=${p.id} returning id`;
    // WEB-118: a plan that lost (or never had) its primary assignment gets one here, never a false "saved".
    if (!moved.length)
      await db`insert into coverage_assignments(plan_id,assignee_profile_id,org_unit_id,is_primary,effective_from,effective_to,actor_subject,reason) values (${p.id},${p.assignee_profile_id},${p.org_unit_id},true,${new Date(from)},${new Date(to)},${ctx.actor.subject},${b.reason})`;
  } else if (action === "applyToDraft") {
    draft(p);
    const a = await employeeAt(
      db,
      p.assignee_profile_id,
      Math.max(+new Date(p.effective_from), ctx.now),
    );
    const templates = await routinesAt(
      db,
      a.position_id,
      Math.max(+new Date(p.effective_from), ctx.now),
    );
    const rows = await planRows(db, p.id);
    const slots = rows.slots
      .filter((s) => !s.slot_key.startsWith("routine:"))
      .map(civil);
    for (const date of monthDates(p.local_month)) {
      if (
        localDate(date) <
          Math.max(
            +new Date(p.effective_from),
            localDate(manilaDate(ctx.now)),
          ) ||
        localDate(date) >= +new Date(p.effective_to)
      )
        continue;
      const r = templates.find(
        /** @param {any} t */ (t) =>
          t.weekday === new Date(`${date}T00:00:00Z`).getUTCDay(),
      );
      for (const activity of r?.activities ?? [])
        slots.push({
          slotKey: `routine:${date}:${activity.sequence}`,
          serviceDate: date,
          kind: "non_visit",
          activityKind: r.day_kind === "day_off" ? "day_off" : activity.name,
          sequence: activity.sequence,
          expectedDurationMinutes: 0,
          requiredObjectives: [],
          intents: [],
        });
    }
    await saveSlots(ctx, p, slots);
    await db`update coverage_plans set content_revision=content_revision+1 where id=${p.id}`;
    await audit(ctx, p, "routines.applied", {}, { slots: slots.length });
    return {
      created:
        slots.length -
        rows.slots.filter((s) => !s.slot_key.startsWith("routine:")).length,
      warning: templates.length
        ? null
        : "No weekly routine for position; no routine inferred",
    };
  } else if (action === "submit") {
    draft(p);
    const rows = await planRows(db, p.id);
    if (!rows.assignments.length) fail("Primary coverage assignment required");
    if (!rows.slots.length) fail("Plan needs dated slots before submitting");
    await db`update coverage_plans set status='submitted',submitted_by=${ctx.actor.subject},submitted_at=${new Date(ctx.now)} where id=${p.id}`;
  } else if (action === "returnPlan") {
    if (p.status !== "submitted") fail("Only submitted plans can be returned");
    await approvalCapacity(ctx, p);
    required(b.reason, "Return reason");
    await db`update coverage_plans set status='draft',submitted_by=null,submitted_at=null,revision_reason=${b.reason.trim()} where id=${p.id}`;
  } else if (action === "approve") {
    if (p.status !== "submitted") fail("Only submitted plans can be approved");
    const capacity = await approvalCapacity(ctx, p);
    await db`select pg_advisory_xact_lock(hashtextextended('coverage:master-lock',0))`;
    if (p.pjp_source) {
      const { validatePjpPublication } = await import("./pjp.js");
      await validatePjpPublication(ctx, p);
    }
    const rows = await planRows(db, p.id);
    if (!rows.slots.length) fail("Plan needs dated slots before approval");
    const [assignment] = rows.assignments;
    if (
      rows.assignments.length !== 1 ||
      !assignment.is_primary ||
      assignment.assignee_profile_id !== p.assignee_profile_id ||
      assignment.org_unit_id !== p.org_unit_id ||
      +new Date(assignment.effective_from) !== +new Date(p.effective_from) ||
      +new Date(assignment.effective_to) !== +new Date(p.effective_to)
    )
      fail("Invalid primary plan assignment");
    const overlaps =
      await db`select * from coverage_plans where id<>${p.id} and assignee_profile_id=${p.assignee_profile_id} and status in ('approved','active') and effective_from<${p.effective_to} and coalesce(active_through,effective_to)>${p.effective_from}`;
    if (
      overlaps.some(
        /** @param {any} x */ (x) =>
          x.id !== p.based_on_plan_id ||
          +new Date(x.effective_from) >= +new Date(p.effective_from),
      )
    )
      fail(
        "Overlapping approved coverage requires named successor after predecessor",
      );
    const sequences = new Set();
    const snapshots = [];
    for (const o of rows.outlets) {
      await outletAt(ctx, o.outlet_id, ctx.now, "mcp.approve");
      if (o.frequency === "custom" && !o.custom_local_dates.length)
        fail("Custom cadence has no dates");
      for (const date of o.custom_local_dates) {
        const at = localDate(
          typeof date === "string"
            ? date.slice(0, 10)
            : date.toISOString().slice(0, 10),
        );
        if (at < +new Date(p.effective_from) || at >= +new Date(p.effective_to))
          fail("Cadence date outside plan");
      }
    }
    for (const s of rows.slots) {
      const date = civil(s).serviceDate,
        at = localDate(date);
      if (at < +new Date(p.effective_from) || at >= +new Date(p.effective_to))
        fail("Slot outside plan period");
      if (s.kind === "outlet_visit") {
        const key = `${date}:${s.sequence}`;
        if (sequences.has(key)) fail("Duplicate sequence on service date");
        sequences.add(key);
        if (!rows.outlets.some((o) => o.outlet_id === s.outlet_id))
          fail("Visit outlet missing from plan roster");
      }
      snapshots.push({
        ...civil(s),
        approvedSnapshot: await snapshotSlot(ctx, p, s),
      });
    }
    const signed = {
      plan: {
        id: p.id,
        version: p.version,
        assignee: p.assignee_profile_id,
        month: p.local_month,
        organization: p.organization_id,
        unit: p.org_unit_id,
        effectiveFrom: +new Date(p.effective_from),
        effectiveTo: +new Date(p.effective_to),
        requestedFrom: +new Date(p.requested_from),
        requestedTo: +new Date(p.requested_to),
        basedOn: p.based_on_plan_id,
        reason: p.revision_reason,
        preparedBy: p.prepared_by,
      },
      ...(p.pjp_source ? { pjpSource: p.pjp_source } : {}),
      assignments: dto(rows.assignments),
      outlets: dto(rows.outlets),
      slots: snapshots,
    };
    const hash = digest(signed),
      signature = `${p.id}:${p.version}:${ctx.actor.subject}:${ctx.now}:${hash}`;
    for (const s of snapshots)
      if (s.approvedSnapshot)
        await db`update coverage_plan_slots set approved_snapshot=${s.approvedSnapshot} where id=${s._id}`;
    await db`update coverage_plans set status='approved',approved_by=${ctx.actor.subject},approved_at=${new Date(ctx.now)},approver_profile_id=${ctx.actor.profileId},approval_capacity=${capacity.capacity},approved_on_behalf_of_profile_id=${capacity.onBehalfOf},content_hash=${hash},approval_signature=${signature},signed_content=${signed} where id=${p.id}`;
  } else fail("Unknown coverage command");
  await db`update coverage_plans set content_revision=content_revision+1,updated_by=${ctx.actor.subject} where id=${p.id}`;
  const updated = await loadPlan(db, p.id);
  await audit(
    ctx,
    p,
    `plan.${action}`,
    { status: p.status, revision: p.content_revision },
    { status: updated.status, revision: updated.content_revision },
    b.reason ?? null,
    // WEB-118: the approve event carries the signature so History can show "Signed version".
    action === "approve" ? updated.approval_signature : null,
  );
  return dto(updated);
}
