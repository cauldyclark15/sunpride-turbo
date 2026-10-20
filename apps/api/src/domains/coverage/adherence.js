import { requireCapability } from "../../core/capabilities.js";
import { hooks } from "../../core/hooks.js";
import {
  DAY,
  fail,
  localDate,
  manilaDate,
  outletAt,
  visiblePeople,
} from "./model.js";

/** F-206: the last four COMPLETE Monday–Sunday weeks, not a partial-week success.
 * @param {string} asOf */
export function adherenceWindow(asOf) {
  const at = localDate(asOf),
    weekday = new Date(asOf + "T00:00:00Z").getUTCDay();
  const end = at - ((weekday + 6) % 7) * DAY;
  return {
    from: manilaDate(end - 28 * DAY),
    to: manilaDate(end - DAY),
    priorFrom: manilaDate(end - 56 * DAY),
    priorTo: manilaDate(end - 29 * DAY),
    weeks: Array.from({ length: 4 }, (_, i) =>
      manilaDate(end - (4 - i) * 7 * DAY),
    ),
  };
}
/** Count distinct planned slots, never off-plan calls or duplicate executions.
 * @param {any[]} slots @param {any[]} executions @param {string} asOf */
export function adherenceFacts(slots, executions, asOf) {
  const window = adherenceWindow(asOf);
  const done = new Set(
    executions
      .filter(
        (v) =>
          ["completed", "checked-out"].includes(v.state) &&
          v.late_review_status !== "rejected",
      )
      .map((v) => v.planned_visit_id),
  );
  const pct = (/** @type {number} */ a, /** @type {number} */ b) =>
    b ? Math.round((a / b) * 1000) / 10 : null;
  const fact = (/** @type {any[]} */ rows) => {
    const actual = rows.filter(
      (s) => s.plannedVisitId && done.has(s.plannedVisitId),
    ).length;
    return {
      planned: rows.length,
      actual,
      adherencePct: pct(actual, rows.length),
    };
  };
  const current = slots.filter(
      (s) => s.date >= window.from && s.date <= window.to,
    ),
    prior = slots.filter(
      (s) => s.date >= window.priorFrom && s.date <= window.priorTo,
    );
  const weeks = window.weeks.map((from) => {
    const to = manilaDate(localDate(from) + 6 * DAY);
    const f = fact(current.filter((s) => s.date >= from && s.date <= to));
    return {
      from,
      to,
      ...f,
      above85: f.planned ? f.actual / f.planned > 0.85 : null,
    };
  });
  const grouped = new Map();
  for (const s of current) {
    const key = JSON.stringify([s.profileId, s.beatId, s.territoryId, s.date]);
    const group = grouped.get(key) ?? {
      key,
      person: s.person,
      profileId: s.profileId,
      beat: s.beat,
      territory: s.territory,
      date: s.date,
      slots: [],
    };
    group.slots.push(s);
    grouped.set(key, group);
  }
  const frequency = new Map();
  for (const s of current) {
    const key = JSON.stringify([s.profileId, s.outletId]);
    const row = frequency.get(key) ?? {
      key,
      profileId: s.profileId,
      person: s.person,
      outletId: s.outletId,
      outlet: s.outlet,
      planned: 0,
      actual: 0,
    };
    row.planned++;
    if (s.plannedVisitId && done.has(s.plannedVisitId)) row.actual++;
    frequency.set(key, row);
  }
  return {
    window,
    summary: fact(current),
    prior: fact(prior),
    weeks,
    fourWeekGate: weeks.every((w) => w.above85 === true)
      ? "passed"
      : weeks.some((w) => w.above85 === false)
        ? "not_met"
        : "insufficient_plan",
    rows: [...grouped.values()]
      .map(({ slots, ...g }) => ({ ...g, ...fact(slots) }))
      .sort(
        (a, b) =>
          (a.adherencePct ?? 101) - (b.adherencePct ?? 101) ||
          a.date.localeCompare(b.date),
      ),
    frequency: [...frequency.values()].map((r) => ({
      ...r,
      frequencyAchievedPct: pct(r.actual, r.planned),
    })),
  };
}
/** Signed attribution + current authorization, bounded with explicit overflow refusal.
 * @param {any} ctx @param {any} b */
export async function readAdherence(ctx, b) {
  await requireCapability(ctx, "mcp.read");
  const asOf = b.asOf ?? manilaDate(ctx.now),
    window = adherenceWindow(asOf);
  if (asOf > manilaDate(ctx.now))
    fail("Choose today or a past date for the four-week review");
  const people = await visiblePeople(ctx),
    ids = people.map((/** @type {any} */ p) => p.id);
  if (b.unitId) await requireCapability(ctx, "mcp.read", b.unitId);
  const units = b.unitId
    ? await hooks.scopeUnitIds(ctx.db, { ...ctx.actor, orgUnitId: b.unitId })
    : null;
  const visible = people.filter(
    (/** @type {any} */ p) =>
      (!units || units.includes(p.current_unit_id)) &&
      (!b.channel || p.channel_scope === b.channel),
  );
  const allowed = new Set(visible.map((/** @type {any} */ p) => p.id));
  if (!ids.length) return adherenceFacts([], [], asOf);
  const rows =
    await ctx.db`select s.*,p.assignee_profile_id,p.org_unit_id,p.pjp_source,pv.id as planned_visit_id from coverage_plan_slots s join coverage_plans p on p.id=s.plan_id left join planned_visits pv on pv.plan_slot_id=s.id and pv.status='planned' and pv.deleted_at is null where p.assignee_profile_id in ${ctx.db(ids)} and p.status in ('approved','active','superseded') and p.approval_signature is not null and p.deleted_at is null and s.deleted_at is null and s.kind='outlet_visit' and s.service_date between ${window.priorFrom}::date and ${window.to}::date and s.service_date < (coalesce(p.active_through,p.effective_to) at time zone 'Asia/Manila')::date order by s.service_date,s.id limit 10001`;
  if (rows.length > 10000)
    fail("Review exceeds 10,000 planned calls; narrow the team");
  const slots = [];
  const checked = new Map();
  for (const s of rows) {
    if (!allowed.has(s.assignee_profile_id)) continue;
    await requireCapability(ctx, "mcp.read", s.org_unit_id);
    if (!checked.has(s.outlet_id)) {
      try {
        await outletAt(ctx, s.outlet_id, ctx.now);
        checked.set(s.outlet_id, true);
      } catch (e) {
        if (/** @type {any} */ (e).status !== 403) throw e;
        checked.set(s.outlet_id, false);
      }
    }
    if (!checked.get(s.outlet_id)) continue;
    const snapshot = s.approved_snapshot;
    if (!snapshot) fail("Signed outlet attribution is missing");
    slots.push({
      date:
        s.service_date instanceof Date
          ? s.service_date.toISOString().slice(0, 10)
          : String(s.service_date).slice(0, 10),
      profileId: s.assignee_profile_id,
      person: visible.find(
        (/** @type {any} */ p) => p.id === s.assignee_profile_id,
      )?.name,
      beatId: snapshot.routeId,
      beat: snapshot.routeCode ?? "Territory beat",
      territoryId: snapshot.territoryId,
      territory: snapshot.territoryCode,
      outletId: s.outlet_id,
      outlet: snapshot.outletName,
      plannedVisitId: s.planned_visit_id,
    });
  }
  const planned = slots.map((s) => s.plannedVisitId).filter(Boolean);
  const executions = planned.length
    ? await ctx.db`select planned_visit_id,state,late_review_status from visit_executions where planned_visit_id in ${ctx.db(planned)} and deleted_at is null limit 10001`
    : [];
  if (executions.length > 10000)
    fail("Review exceeds 10,000 executions; narrow the team");
  return adherenceFacts(slots, executions, asOf);
}
