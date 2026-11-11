import { ApiError } from "../../core/errors.js";
import { roleHas, requireCapability } from "../../core/capabilities.js";
import { hooks } from "../../core/hooks.js";
import {
  access,
  bounded,
  civil,
  dto,
  employeeAt,
  fail,
  loadPlan,
  localDate,
  manilaDate,
  monthBounds,
  monthDates,
  outletAt,
  page,
  planRows,
  PLAN_ROW_LIMIT,
  visiblePeople,
} from "./model.js";
import { approvalView } from "./approval.js";
import { deadlinePlan, deadlineState, mcpDeadlines } from "./deadlines.js";
import { routinesAt, snapshotSlot } from "./workflow.js";
import { verifySignature } from "./activation.js";
import { eligibleOutlets, routeProjection } from "./roster.js";
/** @param {any} ctx @param {string} month */
export async function summary(ctx, month) {
  monthBounds(month);
  const db = ctx.db,
    people = await visiblePeople(ctx),
    deadlines = mcpDeadlines(month);
  const priorMonth = manilaDate(monthBounds(month).from - 86400000).slice(0, 7);
  const rows = [];
  let priorReady = 0;
  for (const person of people) {
    if (!person.needs_mcp) continue;
    const plans =
      await db`select * from coverage_plans where assignee_profile_id=${person.id} and local_month=${month} and deleted_at is null order by version desc`;
    const latest = plans.find(
      /** @param {any} p */ (p) => p.status !== "superseded",
    );
    const readyPlan =
      plans.find(/** @param {any} p */ (p) => p.status === "active") ??
      plans.find(/** @param {any} p */ (p) => p.status === "approved");
    const display = readyPlan ?? latest;
    const original = deadlinePlan(plans);
    const timing = deadlineState(deadlines, original, ctx.now);
    const previous =
      await db`select id from coverage_plans where assignee_profile_id=${person.id} and local_month=${priorMonth} and status in ('approved','active','superseded') and deleted_at is null limit 1`;
    priorReady += previous.length ? 1 : 0;
    const submitted = plans.filter(
      /** @param {any} p */ (p) => p.status === "submitted",
    );
    const waiting = [];
    for (const p of submitted) {
      const v = await approvalView(ctx, p);
      if (v.viewerCapacity) waiting.push(p.id);
    }
    rows.push({
      profileId: person.id,
      name: person.name,
      orgUnitId: person.current_unit_id,
      planId: display?.id,
      version: display?.version,
      planStatus: display?.status,
      status: display?.status ?? "not_started",
      ...timing,
      awaitsMyApproval: waiting.length > 0,
      approvalPlanId: waiting[0],
      action: {
        label: waiting.length
          ? "Review plan"
          : latest
            ? latest.id !== display?.id && roleHas(ctx.actor.role, "mcp.plan")
              ? "Edit revision"
              : "Open plan"
            : roleHas(ctx.actor.role, "mcp.plan")
              ? "Start plan"
              : "No plan yet",
        planId: waiting[0] ?? latest?.id,
        profileId: person.id,
      },
    });
  }
  const counts = {
    not_started: 0,
    draft: 0,
    submitted: 0,
    approved: 0,
    active: 0,
  };
  for (const row of rows)
    if (row.status in counts) /** @type {any} */ (counts)[row.status]++;
  const late = rows.filter((r) =>
    ["overdue", "approval_overdue"].includes(r.state),
  );
  const trend = [];
  for (let i = 3; i >= 0; i--) {
    const first = new Date(`${month}-01T00:00:00Z`);
    first.setUTCMonth(first.getUTCMonth() - i);
    const m = first.toISOString().slice(0, 7);
    let ready = 0;
    for (const person of people.filter((p) => p.needs_mcp)) {
      const [r] =
        await db`select count(*) as n from coverage_plans where assignee_profile_id=${person.id} and local_month=${m} and status in ('approved','active','superseded') and deleted_at is null`;
      if (Number(r.n) > 0) ready++;
    }
    trend.push({ month: m, ready, target: rows.length });
  }
  return {
    month,
    deadlines,
    asOf: ctx.now,
    counts,
    lateCount: late.length,
    awaitingMine: rows.filter((r) => r.awaitsMyApproval).length,
    target: rows.length,
    ready: counts.approved + counts.active,
    priorReady,
    priorMonth,
    trend,
    rows: rows.sort(
      (a, b) =>
        Number(b.awaitsMyApproval) - Number(a.awaitsMyApproval) ||
        Number(["overdue", "approval_overdue"].includes(b.state)) -
          Number(["overdue", "approval_overdue"].includes(a.state)) ||
        a.name.localeCompare(b.name),
    ),
  };
}
/** @param {any} ctx @param {any} p */
async function scopedRows(ctx, p) {
  await access(ctx, p);
  const rows = await planRows(ctx.db, p.id);
  for (const id of new Set([
    ...rows.outlets.map((o) => o.outlet_id),
    ...rows.slots.filter((s) => s.outlet_id).map((s) => s.outlet_id),
  ]))
    await outletAt(ctx, id, ctx.now);
  return rows;
}
/** Plain-words reason a signed plan's approval cannot be trusted, else null.
 * @param {any} p */
export function signatureProblem(p) {
  if (!["approved", "active", "superseded"].includes(p.status)) return null;
  try {
    verifySignature(p);
    return null;
  } catch {
    return "This plan's approval record does not match its content. It is shown as saved, read-only, and no visits are generated from it. Prepare a revision and send it for approval again.";
  }
}
/** @param {any} ctx @param {any} p */
export async function projection(ctx, p) {
  const db = ctx.db,
    { outlets, slots } = await scopedRows(ctx, p);
  // A broken approval record must not hide the plan: show live rows instead
  // and let detail explain the problem (WEB-115).
  const signed =
    ["approved", "active", "superseded"].includes(p.status) &&
    !signatureProblem(p);
  const visits =
    await db`select * from planned_visits where plan_id=${p.id} order by service_date,id`;
  const rows = [];
  if (signed && slots.length !== p.signed_content.slots.length)
    fail("Signed slot set does not match plan");
  for (const slot of slots) {
    const s = signed
      ? p.signed_content.slots.find(
          /** @param {any} row */ (row) => row._id === slot.id,
        )
      : civil(slot);
    if (!s) fail("Signed slot set does not match plan");
    const v = visits.find(
        /** @param {any} x */ (x) => x.plan_slot_id === slot.id,
      ),
      snap = signed
        ? p.signed_content.slots.find(
            /** @param {any} x */ (x) => x._id === slot.id,
          )?.approvedSnapshot
        : null;
    if (signed && slot.kind === "outlet_visit" && !snap)
      fail("Approved outlet snapshot missing");
    const live =
      !snap && slot.outlet_id
        ? await outletAt(ctx, slot.outlet_id, localDate(s.serviceDate))
        : null;
    const roster = outlets.find((o) => o.outlet_id === slot.outlet_id);
    const routeId = snap?.routeId ?? slot.route_id ?? roster?.route_id;
    const [route] =
      !snap && routeId
        ? await db`select * from routes where id=${routeId}`
        : [];
    const territoryId =
      snap?.territoryId ??
      live?.assignment?.territory_id ??
      roster?.territory_id;
    const [territory] =
      !snap && territoryId
        ? await db`select * from territories where id=${territoryId}`
        : [];
    rows.push({
      slotKey: s.slotKey,
      serviceDate: s.serviceDate,
      kind: s.kind,
      outletId: snap?.outletId ?? s.outletId,
      outletCode: snap?.outletCode ?? live?.outlet.code,
      name: snap?.outletName ?? live?.outlet.name ?? s.activityKind,
      territoryId,
      territoryCode: snap?.territoryCode ?? territory?.code,
      routeId,
      routeCode: snap?.routeCode ?? route?.code,
      sequence: s.sequence,
      planStatus: p.status,
      visitStatus: v?.status,
      durationMinutes: s.expectedDurationMinutes,
      generated: !!v,
    });
  }
  return rows;
}
/** @param {any} ctx @param {any} p */
export async function reviewStandard(ctx, p) {
  const db = ctx.db,
    rows = await projection(ctx, p),
    a = await employeeAt(
      db,
      p.assignee_profile_id,
      Math.max(+new Date(p.effective_from), ctx.now),
    );
  const [standard] = a.position_id
    ? await db`select * from position_standards where position_id=${a.position_id} and deleted_at is null and effective_from<=${new Date(Math.max(+new Date(p.effective_from), ctx.now))} and (effective_to is null or effective_to>${new Date(Math.max(+new Date(p.effective_from), ctx.now))})`
    : [];
  const days = monthDates(p.local_month).filter(
    (d) =>
      localDate(d) >= +new Date(p.effective_from) &&
      localDate(d) < +new Date(p.effective_to),
  );
  const daily = days.map((date) => ({
    date,
    calls: rows.filter(
      (r) => r.serviceDate === date && r.kind === "outlet_visit",
    ).length,
    target: standard?.selling_weekdays.includes(
      new Date(`${date}T00:00:00Z`).getUTCDay(),
    )
      ? (standard.daily_calls_target ?? null)
      : null,
  }));
  const roster = await planRows(db, p.id);
  const frequencyGaps = [];
  for (const o of roster.outlets) {
    const count = rows.filter((r) => r.outletId === o.outlet_id).length;
    const expected =
      o.frequency === "custom"
        ? o.custom_local_dates.length
        : o.frequency === "monthly"
          ? 1
          : o.frequency === "biweekly"
            ? 2
            : Math.ceil(days.length / 7);
    if (count < expected) {
      const [outlet] =
        await db`select name from outlets where id=${o.outlet_id}`;
      frequencyGaps.push({
        outletId: o.outlet_id,
        name: outlet.name,
        expected,
        planned: count,
      });
    }
  }
  const routes = [
    ...new Set(
      rows
        .filter((r) => r.kind === "outlet_visit")
        .map((r) => r.routeCode ?? "No route"),
    ),
  ].map((code) => ({
    code,
    stores: new Set(
      rows
        .filter((r) => (r.routeCode ?? "No route") === code)
        .map((r) => r.outletId),
    ).size,
  }));
  const actual =
    await db`select v.planned_visit_id,v.state,v.productivity from visit_executions v join planned_visits p on p.id=v.planned_visit_id where p.plan_id=${p.id} and v.deleted_at is null`;
  return {
    daily,
    frequencyGaps,
    routes,
    standardSource: standard?.source_ref ?? null,
    planned: rows.filter((r) => r.kind === "outlet_visit").length,
    visited: new Set(
      actual
        .filter(
          /** @param {any} r */ (r) =>
            r.state !== "planned" &&
            r.state !== "missed" &&
            r.state !== "skipped",
        )
        .map(/** @param {any} r */ (r) => r.planned_visit_id),
    ).size,
    productive: new Set(
      actual
        .filter(/** @param {any} r */ (r) => r.productivity === "verified")
        .map(/** @param {any} r */ (r) => r.planned_visit_id),
    ).size,
  };
}
/** @param {any} ctx @param {string} action @param {any} b @returns {Promise<any>} */
export async function read(ctx, action, b) {
  const db = ctx.db;
  if (action === "permissions") {
    const actor = await requireCapability(ctx, "mcp.read");
    return {
      role: actor.role,
      capabilities: [...actor.capabilities],
      scopeUnitIds: ["super_admin", "analyst"].includes(actor.role)
        ? (await db`select id from org_units where deleted_at is null`).map(
            /** @param {any} r */ (r) => r.id,
          )
        : await hooks.scopeUnitIds(db, actor),
    };
  }
  if (action === "profile") {
    const actor = await requireCapability(ctx, "mcp.read");
    const [p] = await db`select * from profiles where id=${actor.profileId}`;
    return { ...dto(p), authSubject: actor.subject };
  }
  if (action.startsWith("lookup/")) {
    await requireCapability(ctx, "mcp.read");
    if (action === "lookup/outlet") {
      const current = await outletAt(ctx, b.outletId, ctx.now);
      const live = await outletAt(ctx, b.outletId, b.asOf ?? ctx.now);
      const [link] =
        await db`select l.customer_id,c.name as customer_name,c.code as customer_code from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${b.outletId} and l.deleted_at is null and l.effective_from<=${new Date(b.asOf ?? ctx.now)} and (l.effective_to is null or l.effective_to>${new Date(b.asOf ?? ctx.now)})`;
      return {
        outlet: dto(current.outlet),
        assignment: dto(live.assignment),
        customerLink: dto(link),
      };
    }
    const at = new Date(b.asOf ?? ctx.now);
    if (action === "lookup/territories") {
      const rows =
        await db`select t.*,o.org_unit_id from territories t join territory_ownerships o on o.territory_id=t.id where t.deleted_at is null and o.deleted_at is null and t.status='active' and o.effective_from<=${new Date(ctx.now)} and (o.effective_to is null or o.effective_to>${new Date(ctx.now)}) order by t.code`;
      const visible = [];
      for (const r of rows) {
        try {
          await requireCapability(ctx, "mcp.read", r.org_unit_id);
          visible.push(dto(r));
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 403) throw e;
        }
      }
      return page(visible, b.paginationOpts);
    }
    if (action === "lookup/routes" || action === "lookup/route") {
      const candidates =
        action === "lookup/route"
          ? await db`select r.* from routes r where r.id=${b.routeId} and r.deleted_at is null`
          : await db`select r.* from routes r join route_territories rt on rt.route_id=r.id where rt.territory_id=${b.territoryId} and rt.deleted_at is null and rt.effective_from<=${at} and (rt.effective_to is null or rt.effective_to>${at}) and r.deleted_at is null and r.status='active' order by r.code`;
      const visible = [];
      for (const r of candidates) {
        const [owner] =
          await db`select o.org_unit_id from route_territories rt join territory_ownerships o on o.territory_id=rt.territory_id where rt.route_id=${r.id} and rt.deleted_at is null and o.deleted_at is null and rt.effective_from<=${new Date(ctx.now)} and (rt.effective_to is null or rt.effective_to>${new Date(ctx.now)}) and o.effective_from<=${new Date(ctx.now)} and (o.effective_to is null or o.effective_to>${new Date(ctx.now)})`;
        if (!owner) continue;
        await requireCapability(ctx, "mcp.read", owner.org_unit_id);
        visible.push(dto(r));
      }
      return action === "lookup/route"
        ? { route: visible[0] }
        : page(visible, b.paginationOpts);
    }
    const candidates =
      action === "lookup/roster"
        ? await db`select o.* from outlets o join outlet_assignments a on a.outlet_id=o.id where a.territory_id=${b.territoryId} and a.deleted_at is null and a.effective_from<=${at} and (a.effective_to is null or a.effective_to>${at}) and o.deleted_at is null order by o.code`
        : await db`select * from outlets where deleted_at is null and status='active' order by code`;
    const visible = [];
    for (const o of candidates) {
      try {
        await outletAt(ctx, o.id, ctx.now);
        const live = await outletAt(ctx, o.id, +at);
        visible.push(
          action === "lookup/roster"
            ? dto({ ...live.assignment, outlet_id: o.id })
            : dto(o),
        );
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    }
    return action === "lookup/roster"
      ? bounded(visible, "Eligible outlets", PLAN_ROW_LIMIT)
      : page(visible, b.paginationOpts);
  }
  if (action === "summary")
    return summary(
      ctx,
      b.month ?? b.localMonth ?? manilaDate(ctx.now).slice(0, 7),
    );
  if (action === "calendar/status") {
    const s = await summary(ctx, b.localMonth);
    return { ...page(s.rows, b.paginationOpts), deadlines: s.deadlines };
  }
  if (action === "people")
    return page(
      (await visiblePeople(ctx)).map((p) => ({
        ...dto(p),
        orgUnitId: p.current_unit_id,
      })),
      b.paginationOpts,
    );
  if (
    action === "plans/list" ||
    action === "discovery/list" ||
    action === "activation/plannedForMonth"
  ) {
    const month = b.localMonth;
    monthBounds(month);
    const people = await visiblePeople(ctx),
      ids = people.map((p) => p.id);
    if (b.assigneeProfileId && !ids.includes(b.assigneeProfileId))
      throw new ApiError(
        "out_of_scope",
        403,
        "Person outside your current scope",
      );
    if (!ids.length)
      return action === "discovery/list" ? page([], b.paginationOpts) : [];
    const plans = bounded(
      await db`select * from coverage_plans where assignee_profile_id=any(${db.array(b.assigneeProfileId ? [b.assigneeProfileId] : ids, "UUID")}) and local_month=${month} and deleted_at is null order by version desc`,
    );
    const visible = [];
    for (const p of plans) {
      await access(ctx, p);
      if (!b.status || b.status === p.status) visible.push(p);
    }
    if (action === "plans/list") return dto(visible);
    if (action === "activation/plannedForMonth") {
      const result = [];
      for (const p of visible) {
        await scopedRows(ctx, p);
        result.push(
          ...(await db`select * from planned_visits where plan_id=${p.id} order by service_date,id`),
        );
      }
      return result.map(civil);
    }
    return page(
      visible.map((p) => ({
        planId: p.id,
        assigneeProfileId: p.assignee_profile_id,
        assigneeName:
          people.find((x) => x.id === p.assignee_profile_id)?.name ??
          "Former user",
        localMonth: p.local_month,
        version: p.version,
        status: p.status,
      })),
      b.paginationOpts,
    );
  }
  if (action === "away/list") {
    await requireCapability(ctx, "mcp.read");
    const a = await employeeAt(db, b.profileId, ctx.now);
    await requireCapability(ctx, "mcp.read", a.org_unit_id);
    return dto(
      await db`select * from supervisor_away_periods where profile_id=${b.profileId} and effective_to>${new Date(ctx.now)} order by effective_from limit 500`,
    );
  }
  if (action === "views/workload" && !b.planId) {
    const s = await summary(ctx, b.localMonth);
    const result = [];
    for (const r of s.rows.filter((r) => r.planId)) {
      const v = await read(ctx, action, {
        ...b,
        planId: r.planId,
        paginationOpts: { numItems: 100, cursor: null },
      });
      result.push(...v.page);
    }
    return page(result, b.paginationOpts);
  }
  const p = await loadPlan(db, b.planId, true);
  const rows = await scopedRows(ctx, p);
  if (action === "plans/detail") {
    const a = await employeeAt(
      db,
      p.assignee_profile_id,
      Math.max(+new Date(p.effective_from), ctx.now),
    );
    const [standard] = a.position_id
      ? await db`select * from position_standards where position_id=${a.position_id} and deleted_at is null and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`
      : [];
    const review = await reviewStandard(ctx, p);
    const territories =
      await db`select territory_id from coverage_plan_territories where coverage_plan_id=${p.id} order by ordinal`;
    const problem = signatureProblem(p);
    return {
      notices: problem ? [problem] : [],
      signatureValid: !problem,
      warnings: review.daily
        .filter((d) => d.target != null && d.calls < d.target)
        .map(
          (d) =>
            `${d.date}: ${d.calls} planned stores; position standard ${d.target}/day`,
        ),
      plan: {
        ...dto(p),
        territoryIds: territories.map(
          /** @param {any} t */ (t) => t.territory_id,
        ),
      },
      outlets: rows.outlets.map((o) => ({
        ...dto(o),
        customLocalDates: o.custom_local_dates.map(
          /** @param {any} d */ (d) =>
            typeof d === "string"
              ? d.slice(0, 10)
              : d.toISOString().slice(0, 10),
        ),
      })),
      slots: rows.slots.map(civil),
      assignments: dto(rows.assignments),
      dailyCallsTarget: standard?.daily_calls_target ?? null,
      standardSource: standard?.source_ref ?? null,
      review,
    };
  }
  if (action === "review") return reviewStandard(ctx, p);
  if (action === "calendar/approvalView") return approvalView(ctx, p);
  if (action === "routines/listForPosition") {
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
    return {
      templates: dto(templates),
      warning: templates.length
        ? null
        : "No weekly routine for position; no routine inferred",
    };
  }
  if (action === "history/list")
    return page(
      dto(
        await db`select * from coverage_audit_events where plan_id=${p.id} order by created_at,id`,
      ),
      b.paginationOpts,
    );
  if (action === "discovery/attribution") {
    const name = async (/** @type {string} */ subject) => {
      if (!subject) return undefined;
      const [r] =
        await db`select name from profiles where user_id::text=${subject} or auth_subject=${subject}`;
      return r?.name ?? "Former user";
    };
    const events =
      await db`select id,actor_subject from coverage_audit_events where plan_id=${p.id}`;
    const eventsActorNames = {};
    for (const e of events)
      /** @type {any} */ (eventsActorNames)[e.id] = await name(e.actor_subject);
    const [returned] =
      await db`select reason from coverage_audit_events where plan_id=${p.id} and action='plan.returnPlan' order by created_at desc,id desc limit 1`;
    return {
      latestReturnReason: returned?.reason,
      preparedByName: await name(p.prepared_by),
      submittedByName: await name(p.submitted_by),
      approvedByName: await name(p.approved_by),
      eventsActorNames,
    };
  }
  const projected = await projection(ctx, p);
  const filtered = projected.filter(
    (r) =>
      (!b.territoryId || r.territoryId === b.territoryId) &&
      (!b.routeId || r.routeId === b.routeId) &&
      (!b.visitStatus || r.visitStatus === b.visitStatus),
  );
  if (action === "views/calendar") return page(filtered, b.paginationOpts);
  if (action === "exports/schedule") {
    const attribution = await read(ctx, "discovery/attribution", b);
    const [assignee] =
      await db`select name from profiles where id=${p.assignee_profile_id}`;
    return {
      ...page(filtered, b.paginationOpts),
      planHeader: {
        planId: p.id,
        localMonth: p.local_month,
        version: p.version,
        status: p.status,
        assigneeName: assignee.name,
        preparedByName: attribution.preparedByName,
        preparedAt: +new Date(p.prepared_at),
        submittedByName: attribution.submittedByName,
        submittedAt: p.submitted_at ? +new Date(p.submitted_at) : undefined,
        approvedByName: attribution.approvedByName,
        approvedAt: p.approved_at ? +new Date(p.approved_at) : undefined,
        signedHashPrefix: p.content_hash?.slice(0, 12),
        contentRevision: p.content_revision,
      },
    };
  }
  if (action === "views/filterOptions") {
    const territories = [],
      routes = [];
    for (const id of new Set(
      projected.map((r) => r.territoryId).filter(Boolean),
    )) {
      const [r] = await db`select id,code,name from territories where id=${id}`;
      if (r) territories.push(r);
    }
    for (const id of new Set(projected.map((r) => r.routeId).filter(Boolean))) {
      const [r] = await db`select id,code,name from routes where id=${id}`;
      if (r) routes.push(r);
    }
    return { territories, routes };
  }
  if (action === "exceptions/forPlan") {
    if (["approved", "active", "superseded"].includes(p.status))
      return {
        ...page([], b.paginationOpts),
        blockingCount: 0,
        advisoryCount: 0,
        policySource: "Signed historical plan",
      };
    /** @type {any[]} */ const exceptions = [];
    const points = new Map();
    for (const o of rows.outlets) {
      const live = await outletAt(
        ctx,
        o.outlet_id,
        Math.max(+new Date(p.effective_from), ctx.now),
      );
      const [pin] =
        await db`select * from outlet_pins where outlet_id=${o.outlet_id} and status='verified' and deleted_at is null and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`;
      const add = (
        /** @type {string} */ code,
        /** @type {string} */ severity,
        /** @type {string} */ message,
      ) =>
        exceptions.push({
          code,
          severity,
          message,
          remediation: "Review the outlet setup before approval",
          signedHistorical: ["approved", "active", "superseded"].includes(
            p.status,
          ),
          outletId: o.outlet_id,
          outletCode: live.outlet.code,
          outletName: live.outlet.name,
          relatedOutletIds: [],
        });
      if (o.frequency === "custom" && !o.custom_local_dates.length)
        add("invalid_cadence", "blocking", "Custom cadence has no dates");
      for (const date of o.custom_local_dates) {
        const at = localDate(
          typeof date === "string"
            ? date.slice(0, 10)
            : date.toISOString().slice(0, 10),
        );
        if (at < +new Date(p.effective_from) || at >= +new Date(p.effective_to))
          add("invalid_cadence", "blocking", "Cadence date outside plan");
      }
      if (!pin) add("missing_gps", "advisory", "No verified GPS pin");
      else {
        const key = `${pin.latitude.toFixed(5)},${pin.longitude.toFixed(5)}`;
        if (points.has(key))
          add(
            "duplicate_location",
            "advisory",
            "Another store shares this pin",
          );
        points.set(key, o.outlet_id);
      }
      if (live.outlet.status !== "active")
        add("inactive_outlet", "blocking", "Outlet is inactive");
      if (!o.route_id) add("territory_only", "advisory", "Outlet has no route");
      if (
        live.assignment?.territory_id !== o.territory_id ||
        (live.assignment?.route_id ?? null) !== (o.route_id ?? null)
      )
        add(
          "conflicting_assignment",
          "blocking",
          "Outlet assignment changed; refresh roster",
        );
    }
    for (const slot of rows.slots) {
      try {
        await snapshotSlot(ctx, p, slot, "mcp.read");
      } catch (e) {
        if (!(e instanceof ApiError) || e.status === 403) throw e;
        exceptions.push({
          code: "conflicting_assignment",
          severity: "blocking",
          message: e.message,
          remediation: "Revise this dated slot before approval",
          outletId: slot.outlet_id,
          serviceDate: civil(slot).serviceDate,
          signedHistorical: false,
        });
      }
    }
    bounded(exceptions, "Plan exceptions");
    return {
      ...page(exceptions, b.paginationOpts),
      policySource: "Provisional Group 06 policy; pending client sign-off",
      blockingCount: exceptions.filter((e) => e.severity === "blocking").length,
      advisoryCount: exceptions.filter((e) => e.severity === "advisory").length,
    };
  }
  if (action === "map/forPlan") {
    const pins = [];
    const eligible = await eligibleOutlets(ctx, p);
    const candidates = new Set([
      ...filtered.map((r) => r.outletId).filter(Boolean),
      ...eligible
        .filter(
          (live) =>
            (!b.territoryId ||
              live.assignment.territory_id === b.territoryId) &&
            (!b.routeId || live.assignment.route_id === b.routeId),
        )
        .map((live) => live.outlet.id),
    ]);
    for (const id of candidates) {
      const live = await outletAt(ctx, id, ctx.now);
      const [pin] =
        await db`select * from outlet_pins where outlet_id=${id} and status='verified' and deleted_at is null and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`;
      pins.push({
        outletId: id,
        outletCode: live.outlet.code,
        outletName: live.outlet.name,
        pinStatus: pin ? "verified" : "unmapped",
        latitude: pin?.latitude,
        longitude: pin?.longitude,
        sequence: filtered.find((r) => r.outletId === id)?.sequence,
        inPlan:
          rows.outlets.some((o) => o.outlet_id === id) ||
          filtered.some((r) => r.outletId === id),
        assigned: !!live.assignment,
      });
    }
    return page(pins, b.paginationOpts);
  }
  if (action === "views/byRoute")
    return page(
      await routeProjection(ctx, p, projected, rows.outlets),
      b.paginationOpts,
    );
  if (action === "views/workload") {
    const review = await reviewStandard(ctx, p);
    const [person] =
      await db`select name from profiles where id=${p.assignee_profile_id}`;
    const days = review.daily.filter((d) => d.calls > 0);
    const target = review.daily.find((d) => d.target != null)?.target;
    return page(
      [
        {
          assigneeProfileId: p.assignee_profile_id,
          assigneeName: person.name,
          planId: p.id,
          version: p.version,
          planStatus: p.status,
          selection: "Selected version",
          routeCodes: review.routes.map((r) => r.code),
          visitCount: review.planned,
          workingDays: days.map((d) => d.date),
          durationMinutes: projected.reduce((n, r) => n + r.durationMinutes, 0),
          dailyCallsTarget: target,
          variance:
            target == null ? undefined : review.planned - target * days.length,
        },
      ],
      b.paginationOpts,
    );
  }
  fail("Unknown coverage read");
}
