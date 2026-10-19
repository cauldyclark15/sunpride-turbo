import {
  date,
  day,
  dto,
  fail,
  gate,
  ms,
  person,
  roleHas,
  roster,
  standard,
  today,
  outlet as readableOutlet,
} from "./common.js";
import { execution, dsr, perDiem } from "./reads.js";
import { DONE, OPEN, reportDueAt, weekOf } from "./rules.js";
import { cadence, register } from "./coaching.js";

/** @param {any} c @param {any} a */
export async function options(c, a) {
  const people = await roster(c, a, true);
  const units = [];
  for (const id of new Set(
    people.map((/** @type {any} */ p) => p.org_unit_id),
  )) {
    const [u] = await c.db`select id,code,name from org_units where id=${id}`;
    if (u) units.push(u);
  }
  return {
    units,
    channels: [
      ...new Set(people.map((/** @type {any} */ p) => p.channel)),
    ].sort(),
    canDecide: roleHas(c.actor.role, "visit.locationException.approve"),
  };
}
/** @param {any} c @param {any} a */
export async function teamDay(c, a) {
  const d = date(a.serviceDate);
  const people = [];
  for (const p of await roster(c, a)) {
    const x = await execution(c, p, d);
    people.push({
      profileId: p.id,
      name: p.name,
      employeeCode: p.employee_code,
      positionLabel: p.position_label,
      channel: p.channel,
      orgUnitId: p.org_unit_id,
      direct: p.direct,
      planned: x.summary.planned,
      plannedDone: x.summary.plannedDone,
      done: x.visits.filter((v) => DONE.has(v.state)).length,
      productive: x.summary.productiveCalls,
      nonproductive: x.summary.calls - x.summary.productiveCalls,
      unplanned: x.summary.unplanned,
      inProgress: x.visits.some((v) => OPEN.has(v.state)),
      outOfSequence: x.sequenceIssues.size,
      openExceptions: x.visits.reduce(
        (s, v) =>
          s +
          v.evidence.filter(
            (/** @type {any} */ e) =>
              e.review_status === "pending_review" && !e.decision,
          ).length,
        0,
      ),
      lateSync: x.visits.filter(
        (v) => v.late_review_status === "pending_review",
      ).length,
      firstCheckInAt: x.summary.firstCheckInAt,
      lastCheckOutAt: x.summary.lastCheckOutAt,
      lastActivityAt: x.visits.length
        ? Math.max(...x.visits.map((v) => ms(v.last_server_time) ?? 0))
        : null,
    });
  }
  return {
    ...(await options(c, a)),
    serviceDate: d,
    dayCloseAt: reportDueAt(d),
    truncated: false,
    people,
  };
}
/** @param {any} c @param {any} a */
export async function cockpit(c, a) {
  const d = date(a.serviceDate);
  const week = weekOf(d);
  const people = await roster(c, a, true);
  const coaching = await cadence(c, a);
  const talks = await register(c, a);
  const rows = [];
  for (const p of people) {
    const x = await execution(c, p, d);
    const w = [];
    const previous = [];
    for (let i = 0; i < 7; i++) {
      const wd = new Date(Date.parse(week.start) + i * 86400000)
        .toISOString()
        .slice(0, 10);
      if (wd <= d) w.push((await execution(c, p, wd)).summary);
      const pd = new Date(Date.parse(wd) - 7 * 86400000)
        .toISOString()
        .slice(0, 10);
      previous.push((await execution(c, p, pd)).summary);
    }
    const trainer = coaching.trainers.find((t) => t.profileId === p.id);
    const ownActions = talks.openItems.filter((i) => i.ownerName === p.name);
    const [report] =
      await c.db`select id from field_day_reports where profile_id=${p.id} and service_date=${d} limit 1`;
    const validation = await perDiem(
      { ...c, actor: { ...c.actor } },
      { from: d, to: d, profileId: p.role === "sales" ? p.id : undefined },
    );
    const selected = validation.selected;
    const reviewed = selected?.decisions.some(
      (/** @type {any} */ decision) =>
        !decision.stale && decision.decision === "validated",
    );
    const waiting = reviewed
      ? 0
      : (selected?.totals.heldCalls ?? 0) + (selected?.totals.validDays ?? 0);
    rows.push({
      profileId: p.id,
      name: p.name,
      position: p.position_label,
      channel: p.channel,
      today: {
        planned: x.summary.planned,
        visited: x.summary.calls,
        productive: x.summary.productiveCalls,
        standard: x.standard?.daily_calls_target ?? null,
      },
      week: {
        planned: w.reduce((s, r) => s + r.planned, 0),
        visited: w.reduce((s, r) => s + r.calls, 0),
        productive: w.reduce((s, r) => s + r.productiveCalls, 0),
        priorVisited: previous.reduce((s, r) => s + r.calls, 0),
      },
      trend: w.map((r) => r.calls),
      workWith: {
        done: trainer?.weekCount ?? 0,
        required: trainer?.weeklyMin ?? null,
      },
      talkActions: ownActions.length,
      overdue: ownActions.filter((i) => i.status === "overdue").length,
      perDiemWaiting: waiting,
      darMissing:
        !report &&
        ["DS", "CDS", "SR_CDS", "CDM_GT", "CDM_KA", "SCDM"].includes(
          p.position_code,
        ),
      actions: {
        day: `/analytics?view=agent-day&profileId=${p.id}&date=${d}`,
        workWith: `/supervision?tab=workwith&date=${d}`,
        talk: `/supervision?tab=talk&date=${d}`,
        perDiem: `/supervision?tab=perdiem&profileId=${p.id}&date=${d}`,
        report: `/activity-reports?profileId=${p.id}&date=${d}`,
      },
    });
  }
  return {
    serviceDate: d,
    week,
    rows: rows.sort(
      (a, b) =>
        b.overdue +
        b.perDiemWaiting +
        Number(b.darMissing) -
        (a.overdue + a.perDiemWaiting + Number(a.darMissing)),
    ),
    definition:
      "Completed planned calls, governed productive activities, position standards. Missing data is not zero.",
  };
}
/** @param {any} c @param {any} a */
export async function activity(c, a) {
  const people = await roster(c, a);
  const result = [];
  const showsFixes = roleHas(c.actor.role, "visit.locationException.approve");
  for (const p of people) {
    if (a.profileId && a.profileId !== p.id) continue;
    const x = await execution(c, p, date(a.serviceDate));
    const stops = [];
    for (const plan of [
      ...x.active,
      ...x.visits
        .filter((v) => v.source === "unplanned")
        .map((v) => ({
          id: v.id,
          visit: v,
          outlet_id: v.outlet_id,
          sequence: null,
          approved_snapshot: {
            outletName: v.outlet_name,
            outletCode: v.outlet_code,
          },
        })),
    ]) {
      const v =
        plan.visit ?? x.visits.find((v) => v.planned_visit_id === plan.id);
      const ev = v?.evidence.find(
        (/** @type {any} */ e) => e.latitude !== null && e.longitude !== null,
      );
      let point = null;
      try {
        await readableOutlet(c, plan.outlet_id);
        const pins =
          await c.db`select latitude,longitude from outlet_pins where outlet_id=${plan.outlet_id} and status='verified' and deleted_at is null and effective_from<=${new Date(c.now)} and (effective_to is null or effective_to>${new Date(c.now)}) order by effective_from desc limit 2`;
        if (pins.length > 1) fail("Overlapping verified store pins", 409);
        point = pins[0] ?? null;
      } catch (error) {
        if (!(
          error instanceof Error &&
          "status" in error &&
          error.status === 403
        ))
          throw error;
      }
      stops.push({
        id: plan.id,
        visitId: v?.id ?? null,
        source: v ? v.source : "not_visited",
        sequence: plan.sequence,
        outletName: plan.approved_snapshot.outletName ?? "Planned store",
        outletCode: plan.approved_snapshot.outletCode ?? "",
        territoryCode: plan.approved_snapshot.territoryCode ?? null,
        state: v?.state ?? "not_visited",
        productivity: v
          ? v.evaluation.productive
            ? "verified"
            : "nonproductive"
          : null,
        checkedInAt: ms(v?.checked_in_at),
        checkedOutAt: ms(v?.checked_out_at),
        point,
        fix:
          showsFixes && ev
            ? {
                latitude: ev.latitude,
                longitude: ev.longitude,
                accuracyMeters: ev.accuracy_meters,
                result: ev.result,
              }
            : null,
      });
    }
    result.push({ profileId: p.id, name: p.name, channel: p.channel, stops });
  }
  return {
    serviceDate: a.serviceDate,
    truncated: false,
    showsFixes,
    people: result,
  };
}
/** @param {any} c @param {any} a */
export async function exceptions(c, a) {
  const people = await roster(c, a);
  const canDecide = roleHas(c.actor.role, "visit.locationException.approve");
  /** @type {any[]} */ const items = [];
  /** @param {string} entityId */
  const history = async (entityId) => {
    const rows =
      await c.db`select e.*,p.name actor_name from execution_events e left join profiles p on p.auth_subject=e.actor_subject or p.user_id::text=e.actor_subject where e.entity_type='visit' and e.entity_id=${entityId} order by e.server_at,e.id limit 101`;
    if (rows.length > 100)
      fail("Too much visit history; narrow this report", 422, "report_limit");
    return rows.map((/** @type {any} */ e) => ({
      kind: e.kind,
      at: ms(e.server_at),
      actorName: e.actor_name ?? "Former user",
      after: e.summary_after,
      reasonCode: e.summary_reason_code,
    }));
  };
  for (const p of people) {
    const x = await execution(c, p, date(a.serviceDate));
    const base = {
      profileId: p.id,
      personName: p.name,
      channel: p.channel,
      visitId: null,
      evidenceId: null,
      event: null,
      result: null,
      distanceMeters: null,
      accuracyMeters: null,
      radiusMeters: null,
      sequence: null,
      after: null,
      reason: null,
      decision: null,
      open: false,
      canDecide: false,
      history: [],
      at: null,
    };
    for (const v of x.visits) {
      const where = {
        outletName: v.outlet_name,
        outletCode: v.outlet_code,
        visitId: v.id,
      };
      const events = await history(v.id);
      for (const e of v.evidence) {
        if (e.result === "within_radius") continue;
        const decisions = await history(e.id);
        const decision = decisions.find(
          (/** @type {any} */ event) =>
            event.kind === "location.exception.decided",
        );
        const open = e.review_status === "pending_review" && !decision;
        items.push({
          ...base,
          ...where,
          id: "location:" + e.id,
          kind: "location",
          open,
          canDecide: open && canDecide && c.actor.profileId !== p.id,
          evidenceId: e.id,
          event: e.event,
          result: e.result,
          at: ms(e.server_time),
          distanceMeters: canDecide ? e.distance_meters : null,
          accuracyMeters: canDecide ? e.accuracy_meters : null,
          radiusMeters: canDecide ? e.radius_meters : null,
          history: [...events, ...decisions],
          decision: decision
            ? {
                status: decision.after ?? "decided",
                actorName: decision.actorName,
                at: decision.at,
                reasonCode: decision.reasonCode,
              }
            : null,
        });
      }
      const jump = x.sequenceIssues.get(v.id);
      if (jump)
        items.push({
          ...base,
          ...where,
          id: "sequence:" + v.id,
          kind: "out_of_sequence",
          sequence: jump.sequence,
          after: jump.after,
          at: ms(v.checked_in_at),
          history: events,
        });
      if (v.source === "unplanned")
        items.push({
          ...base,
          ...where,
          id: "unplanned:" + v.id,
          kind: "unplanned",
          reason: v.unplanned_reason,
          at: ms(v.checked_in_at),
          history: events,
        });
      if (DONE.has(v.state) && !v.evaluation.productive)
        items.push({
          ...base,
          ...where,
          id: "nonproductive:" + v.id,
          kind: "nonproductive",
          reason: v.reason_code,
          at: ms(v.checked_out_at),
          history: events,
        });
    }
    for (const plan of x.planned) {
      const where = {
        outletName: plan.approved_snapshot.outletName ?? "Planned store",
        outletCode: plan.approved_snapshot.outletCode ?? "",
        sequence: plan.sequence,
      };
      if (plan.status !== "planned")
        items.push({
          ...base,
          ...where,
          id: plan.status + ":" + plan.id,
          kind: plan.status === "cancelled" ? "cancelled" : "rescheduled",
          reason: plan.cancellation_reason,
          at: ms(plan.cancelled_at),
        });
      else if (!x.visits.some((v) => v.planned_visit_id === plan.id))
        items.push({
          ...base,
          ...where,
          id: "not_visited:" + plan.id,
          kind: "not_visited",
        });
    }
  }
  items.sort(
    (a, b) =>
      Number(b.open) - Number(a.open) ||
      (b.at ?? 0) - (a.at ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return {
    serviceDate: a.serviceDate,
    dayCloseAt: reportDueAt(a.serviceDate),
    truncated: items.length > 300,
    total: items.length,
    openTotal: items.filter((i) => i.open).length,
    canDecide,
    items: items.slice(0, 300),
  };
}
