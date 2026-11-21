import { isCompanyWide } from "../../core/capabilities.js";
import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { hooks } from "../../core/hooks.js";
import { subtree, markReadOnlySnapshot } from "../org/scope.js";
import {
  bounded,
  DAY,
  fail,
  localDate,
  manilaDate,
  uuid,
  visiblePeople,
} from "./model.js";

const LIMIT = 10000;
/** @param {any} value */
const date = (value) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
/** Only accepted, closed work earns completion. @param {any} v */
const completed = (v) =>
  ["completed", "checked-out"].includes(v.state) &&
  !["rejected", "pending_review"].includes(v.late_review_status);
/** Inclusive 7-day [from,to] windows covering from..to. @param {string} from @param {string} to */
export function windows(from, to) {
  const out = [];
  for (let at = localDate(from), end = localDate(to); at <= end; at += 7 * DAY)
    out.push([manilaDate(at), manilaDate(Math.min(at + 6 * DAY, end))]);
  return out;
}
/** @param {number} a @param {number} b */
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** @param {any[]} stops */
export function planActualTotals(stops) {
  const planned = stops.filter((s) => s.planned);
  const followed = planned.filter(
    (s) => s.visited && s.activities.every((/** @type {any} */ a) => a.done),
  ).length;
  return {
    planned: planned.length,
    visited: planned.filter((s) => s.visited).length,
    missed: planned.filter((s) => s.status === "Missed").length,
    outstanding: planned.filter((s) => s.status === "Not yet completed").length,
    unplanned: stops.filter((s) => !s.planned).length,
    actualVisits: stops.reduce((n, s) => n + s.completedVisits, 0),
    plannedActivities: planned.reduce((n, s) => n + s.activities.length, 0),
    doneActivities: planned.reduce(
      (n, s) =>
        n + s.activities.filter((/** @type {any} */ a) => a.done).length,
      0,
    ),
    followed,
    followedPct: pct(followed, planned.length),
    visitPct: pct(planned.filter((s) => s.visited).length, planned.length),
    plannedDays: new Set(planned.map((s) => `${s.profileId}:${s.date}`)).size,
    visitedDays: new Set(
      stops
        .filter((s) => s.completedVisits)
        .map((s) => `${s.profileId}:${s.date}`),
    ).size,
    plannedStores: new Set(planned.map((s) => s.outletId)).size,
    visitedStores: new Set(
      stops.filter((s) => s.completedVisits).map((s) => s.outletId),
    ).size,
  };
}

/** Bounded, complete source read; current person, source branch AND current store scope all apply.
 * Signed names/tasks and slot links remain authoritative, never a same-store/date guess.
 * @param {any} ctx @param {any} b */
export async function readPlanActual(ctx, b) {
  const actor = await requireCapability(ctx, "mcp.read");
  const today = manilaDate(ctx.now);
  const from = b.from ?? today.slice(0, 8) + "01",
    to = b.to ?? today;
  const start = localDate(from),
    end = localDate(to),
    length = (end - start) / DAY + 1;
  if (length < 1 || length > 93 || to > today)
    fail("Choose 1–93 days ending today or earlier");
  for (const k of ["profileId", "unitId", "territoryId", "groupId"])
    if (b[k]) uuid(b[k]);
  if (
    b.territoryType &&
    !["location", "customer_group"].includes(b.territoryType)
  )
    fail("Choose a territory type");
  const priorFrom = manilaDate(start - length * DAY),
    priorTo = manilaDate(start - DAY);
  const people = await visiblePeople(ctx);
  if (
    b.profileId &&
    !people.some((/** @type {any} */ p) => p.id === b.profileId)
  )
    throw new ApiError(
      "out_of_scope",
      403,
      "Salesman is outside your current scope",
    );
  const scope = isCompanyWide(actor.role)
    ? null
    : new Set(await hooks.scopeUnitIds(ctx.db, actor));
  const allowedUnit = (/** @type {string} */ id) =>
    !!id && (!scope || scope.has(id));
  let branchScope = null;
  if (b.unitId) {
    await requireCapability(ctx, "mcp.read", b.unitId);
    branchScope = new Set(await subtree(ctx.db, b.unitId, ctx.now));
  }
  const ids = people
    .filter((/** @type {any} */ p) => !b.profileId || p.id === b.profileId)
    .map((/** @type {any} */ p) => p.id);
  const db = ctx.db;
  // SP-0226: read week-sized windows so a full month for a whole branch is
  // complete. Each window keeps its own guard; the prior period is folded into
  // totals only and the per-store day detail is returned only on request.
  /** @type {any[]} */ const slots = [];
  /** @type {any[]} */ const visits = [];
  if (ids.length)
    for (const [wFrom, wTo] of windows(priorFrom, to)) {
      slots.push(
        ...bounded(
          await db`
    select s.id,s.plan_id,s.outlet_id,s.service_date,s.sequence,s.approved_snapshot,p.assignee_profile_id,p.org_unit_id,p.version,pv.id as planned_visit_id
    from coverage_plan_slots s join coverage_plans p on p.id=s.plan_id
    left join planned_visits pv on pv.plan_slot_id=s.id and pv.status='planned' and pv.deleted_at is null
    where p.assignee_profile_id in ${db(ids)} and p.status in ('approved','active','superseded')
    and p.approval_signature is not null and p.deleted_at is null and s.deleted_at is null and s.kind='outlet_visit'
    and s.service_date between ${wFrom}::date and ${wTo}::date
    and s.service_date >= (p.effective_from at time zone 'Asia/Manila')::date
    and s.service_date < (coalesce(p.active_through,p.effective_to) at time zone 'Asia/Manila')::date
    order by s.service_date,s.sequence,s.id limit ${LIMIT + 1}`,
          "Planned stops in one week; narrow the salesman",
          LIMIT,
        ),
      );
      visits.push(
        ...bounded(
          await db`
    select v.id,v.planned_visit_id,v.assignee_profile_id,v.outlet_id,v.org_unit_id,v.service_date,v.state,v.late_review_status,
      v.checked_in_at,v.ended_at,v.reason_code,v.unplanned_reason,a.territory_id as actual_territory_id from visit_executions v
    left join lateral (select territory_id from outlet_assignments where outlet_id=v.outlet_id and deleted_at is null
      and effective_from <= (v.service_date::timestamp at time zone 'Asia/Manila')
      and (effective_to is null or effective_to > (v.service_date::timestamp at time zone 'Asia/Manila')) limit 1) a on true
    where v.assignee_profile_id in ${db(ids)} and v.deleted_at is null
    and v.service_date between ${wFrom}::date and ${wTo}::date
    order by v.service_date,v.id limit ${LIMIT + 1}`,
          "Visits in one week; narrow the salesman",
          LIMIT,
        ),
      );
    }
  const outletIds = [...new Set([...slots, ...visits].map((s) => s.outlet_id))];
  const outlets = outletIds.length
    ? await db`
    select o.id,o.code,o.name,o.customer_group_id,g.name as group_name,
      case when a.id is null then o.custodian_org_unit_id else own.org_unit_id end as current_unit_id
    from outlets o left join customer_groups g on g.id=o.customer_group_id and g.deleted_at is null
    left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
    left join territory_ownerships own on own.territory_id=a.territory_id and own.deleted_at is null and own.effective_from<=${new Date(ctx.now)} and (own.effective_to is null or own.effective_to>${new Date(ctx.now)})
    where o.id in ${db(outletIds)} and o.deleted_at is null`
    : [];
  const outletMap = new Map(outlets.map((/** @type {any} */ o) => [o.id, o]));
  const units =
    await db`select id,name from org_units where deleted_at is null order by name,id`;
  const unitMap = new Map(units.map((/** @type {any} */ u) => [u.id, u.name]));
  const territoryIds = [
    ...new Set(
      [
        ...slots.map((s) => s.approved_snapshot?.territoryId),
        ...visits.map((v) => v.actual_territory_id),
      ].filter(Boolean),
    ),
  ];
  const territories = territoryIds.length
    ? await db`select id,code,name,territory_type from territories where id in ${db(territoryIds)}`
    : [];
  const territoryMap = new Map(
    territories.map((/** @type {any} */ t) => [t.id, t]),
  );
  const personMap = new Map(people.map((/** @type {any} */ p) => [p.id, p]));
  const authorized = (/** @type {any} */ s) =>
    allowedUnit(s.org_unit_id) &&
    allowedUnit(outletMap.get(s.outlet_id)?.current_unit_id);
  const safeVisits = visits.filter(authorized);
  const visitIds = safeVisits.map((v) => v.id);
  /** @type {any[]} */ const activities = [];
  for (let i = 0; i < visitIds.length; i += 2000)
    activities.push(
      ...bounded(
        await db`
    select id,visit_id,activity_kind,activity,server_time,change_seq from visit_activities
    where visit_id in ${db(visitIds.slice(i, i + 2000))} and deleted_at is null limit 100001`,
        "Activities; narrow the dates or salesman",
        100000,
      ),
    );
  // Newest first, as the single ordered read did.
  activities.sort(
    (a, b) =>
      +new Date(b.server_time) - +new Date(a.server_time) ||
      Number(b.change_seq) - Number(a.change_seq) ||
      String(b.id).localeCompare(String(a.id)),
  );
  const activityMap = new Map();
  const activityRank = new Map(activities.map((a, i) => [a.id, i]));
  for (const a of activities) {
    const list = activityMap.get(a.visit_id) ?? [];
    list.push(a);
    activityMap.set(a.visit_id, list);
  }
  const base = (
    /** @type {any} */ s,
    /** @type {any} */ snapshot,
    /** @type {string|null} */ territoryId,
  ) => {
    const o = outletMap.get(s.outlet_id),
      t = territoryMap.get(territoryId),
      p = personMap.get(s.assignee_profile_id);
    return {
      profileId: s.assignee_profile_id,
      person: p.name,
      date: date(s.service_date),
      unitId: s.org_unit_id,
      branch: unitMap.get(s.org_unit_id) ?? "Former branch",
      outletId: s.outlet_id,
      outlet: snapshot?.outletName ?? o.name,
      outletCode: snapshot?.outletCode ?? o.code,
      territoryId,
      territory: snapshot?.territoryCode ?? t?.code ?? "Unassigned",
      territoryType: t?.territory_type ?? null,
      groupId: o.customer_group_id,
      group: o.group_name ?? "No customer group",
      route: snapshot?.dailyRouteCode ?? snapshot?.routeCode ?? "—",
    };
  };
  const visitDto = (/** @type {any} */ v) => ({
    id: v.id,
    state: v.state,
    review: v.late_review_status,
    completed: completed(v),
    checkedInAt: v.checked_in_at ? +new Date(v.checked_in_at) : null,
    checkedOutAt: v.ended_at ? +new Date(v.ended_at) : null,
    reason: v.reason_code ?? v.unplanned_reason ?? null,
    activities: [
      ...new Set(
        (activityMap.get(v.id) ?? [])
          .filter(
            (/** @type {any} */ a) => a.activity_kind !== "planned_activity",
          )
          .map((/** @type {any} */ a) => a.activity_kind),
      ),
    ],
  });
  /** @type {any[]} */ const stops = [];
  const matched = new Set();
  const byPlannedVisit = new Map();
  for (const v of safeVisits) {
    const list = byPlannedVisit.get(v.planned_visit_id) ?? [];
    list.push(v);
    byPlannedVisit.set(v.planned_visit_id, list);
  }
  for (const s of slots.filter(authorized)) {
    const snapshot = s.approved_snapshot;
    if (!snapshot) fail("Approved stop details are missing; review this plan");
    const executions = (byPlannedVisit.get(s.planned_visit_id) ?? []).filter(
      (/** @type {any} */ v) =>
        v.planned_visit_id === s.planned_visit_id &&
        s.planned_visit_id &&
        v.assignee_profile_id === s.assignee_profile_id &&
        v.outlet_id === s.outlet_id &&
        date(v.service_date) === date(s.service_date) &&
        v.org_unit_id === s.org_unit_id,
    );
    executions.forEach((/** @type {any} */ v) => matched.add(v.id));
    const closed = executions.filter(completed),
      visited = closed.length > 0;
    const ticks = closed
      .flatMap((/** @type {any} */ v) => activityMap.get(v.id) ?? [])
      .filter((/** @type {any} */ a) => a.activity_kind === "planned_activity")
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          (activityRank.get(a.id) ?? 0) - (activityRank.get(b.id) ?? 0),
      );
    const work = (snapshot.storeWork?.activities ?? []).map(
      (/** @type {any} */ a) => ({
        activityId: a.activityId,
        name: a.name,
        done:
          ticks.find(
            (/** @type {any} */ t) => t.activity.activityId === a.activityId,
          )?.activity.done === true,
      }),
    );
    stops.push({
      ...base(s, snapshot, snapshot.territoryId),
      key: s.id,
      planned: true,
      planVersion: s.version,
      sequence: s.sequence,
      visited,
      completedVisits: closed.length,
      activities: work,
      visits: executions.map(visitDto),
      status: visited
        ? work.every((/** @type {any} */ a) => a.done)
          ? "Followed"
          : "Activities unfinished"
        : date(s.service_date) < today
          ? "Missed"
          : "Not yet completed",
    });
  }
  for (const v of safeVisits)
    if (!matched.has(v.id))
      stops.push({
        ...base(v, null, v.actual_territory_id),
        key: v.id,
        planned: false,
        planVersion: null,
        sequence: null,
        visited: completed(v),
        completedVisits: completed(v) ? 1 : 0,
        activities: [],
        visits: [visitDto(v)],
        status: "Unplanned",
      });
  const options = {
    people: people.map((/** @type {any} */ p) => ({ id: p.id, name: p.name })),
    branches: units
      .filter((/** @type {any} */ u) => allowedUnit(u.id))
      .map((/** @type {any} */ u) => ({ id: u.id, name: u.name })),
    territories: [
      ...new Map(
        stops
          .filter((s) => s.territoryId)
          .map((s) => [
            s.territoryId,
            { id: s.territoryId, name: s.territory },
          ]),
      ).values(),
    ],
    groups: [
      ...new Map(
        stops
          .filter((s) => s.groupId)
          .map((s) => [s.groupId, { id: s.groupId, name: s.group }]),
      ).values(),
    ],
  };
  const filtered = stops.filter(
    (s) =>
      (!branchScope || branchScope.has(s.unitId)) &&
      (!b.territoryId || s.territoryId === b.territoryId) &&
      (!b.territoryType || s.territoryType === b.territoryType) &&
      (!b.groupId || s.groupId === b.groupId),
  );
  const current = filtered.filter((s) => s.date >= from);
  /** @type {Map<string, any>} */ const days = new Map();
  for (const s of current) {
    const key = `${s.profileId}:${s.date}`;
    const day = days.get(key) ?? {
      key,
      profileId: s.profileId,
      person: s.person,
      date: s.date,
      stops: [],
    };
    day.stops.push(s);
    days.set(key, day);
  }
  const detail = b.detail === "all" ? null : String(b.day ?? "");
  const rows = [...days.values()]
    .map((d) => ({
      ...d,
      totals: planActualTotals(d.stops),
      stops: detail === null || detail === d.key ? d.stops : [],
      stopCount: d.stops.length,
    }))
    .sort(
      (a, b) =>
        b.totals.missed - a.totals.missed ||
        a.date.localeCompare(b.date) ||
        a.person.localeCompare(b.person),
    );
  const salesmen = [...new Set(current.map((s) => s.profileId))].map((id) => ({
    profileId: id,
    person: personMap.get(id).name,
    totals: planActualTotals(current.filter((s) => s.profileId === id)),
  }));
  return {
    from,
    to,
    priorFrom,
    priorTo,
    options,
    summary: planActualTotals(current),
    prior: planActualTotals(filtered.filter((s) => s.date < from)),
    salesmen,
    detail: detail === null ? "all" : detail || null,
    days: rows,
  };
}

/** @param {any} router */
export function installPlanActual(router) {
  router.get("/api/v1/coverage/plan-actual", (/** @type {any} */ c) =>
    tx(c.db, async (db) => {
      await db`set transaction isolation level repeatable read read only`;
      markReadOnlySnapshot(db);
      return readPlanActual(
        { ...c, db },
        Object.fromEntries(c.url.searchParams),
      );
    }),
  );
}
