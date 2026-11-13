/**
 * SP-0175: ONE source of truth for "how is this agent's day going". Today's "Field right now",
 * the Live map and the agent-day page all read these facts and this status rule, so the same
 * agent can never show three different answers (lane case: Today "Not started" with 2 stops
 * done, Live map "0 productive").
 *
 * - planned      approved plan stops for the day
 * - visited      check-ins (any store)
 * - planned_done plan stops closed ("stops done")
 * - productive   closed ON-PLAN calls the governed checkout rule judged productive ('pending'
 *                until a reviewer marks it 'verified'; the map used to wait for 'verified' and
 *                showed 0); a rejected late review never counts. Same rule and on-plan basis as
 *                the analytics call evaluation Today and the agent day use.
 * - last_seen_at newest of: server-side call activity, a real (non-sample) phone position today
 */

export const IDLE_AFTER_MS = 60 * 60_000;

/** Manila calendar date of an epoch ms. @param {number} at */
const manilaDay = (at) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);

/** @param {any} v */
const ms = (v) =>
  v === null || v === undefined ? null : new Date(v).getTime() || null;

/** Facts are shared by the map, Today and the agent day so planned/done/productive cannot
 * disagree. @param {any} db @param {string[]} ids @param {string} date */
export async function dayFacts(db, ids, date) {
  if (!ids.length) return new Map();
  const rows = await db`
    select p.id,
      (select count(*)::int from planned_visits pv join coverage_plans cp on cp.id=pv.plan_id
       where pv.assignee_profile_id=p.id and pv.service_date=${date}::date and pv.status='planned' and pv.deleted_at is null
         and cp.status in ('approved','active') and cp.approval_signature is not null and cp.deleted_at is null) as planned,
      count(v.id) filter (where v.checked_in_at is not null)::int as visited,
      count(v.id) filter (where v.checked_out_at is not null)::int as done,
      count(distinct v.planned_visit_id) filter (where v.checked_out_at is not null and v.planned_visit_id in (
        select pv.id from planned_visits pv join coverage_plans cp on cp.id=pv.plan_id
        where pv.status='planned' and pv.deleted_at is null and cp.status in ('approved','active') and cp.deleted_at is null
      ))::int as planned_done,
      count(v.id) filter (where v.checked_out_at is not null and v.source='planned' and v.planned_visit_id is not null and v.productivity in ('pending','verified') and v.late_review_status is distinct from 'rejected')::int as productive,
      count(v.id) filter (where v.checked_out_at is not null and v.productivity='nonproductive')::int as nonproductive,
      (select count(*)::int from (
        select s.sequence,max(s.sequence) over(order by x.checked_in_at,x.id rows between unbounded preceding and 1 preceding) as highest
        from visit_executions x join planned_visits pv on pv.id=x.planned_visit_id join coverage_plan_slots s on s.id=pv.plan_slot_id
        where x.assignee_profile_id=p.id and x.service_date=${date}::date and x.checked_in_at is not null and x.deleted_at is null
      ) sequence_rows where sequence<highest) as out_of_sequence,
      count(v.id) filter (where v.source='unplanned' and v.checked_in_at is not null)::int as unplanned,
      count(v.id) filter (where v.checked_in_at is not null and v.checked_out_at is null)::int as in_progress,
      count(v.id) filter (where v.late_sync_at is not null)::int as late_sync,
      min(v.checked_in_at) as first_check_in_at,max(v.checked_out_at) as last_check_out_at,
      max(v.last_server_time) as last_activity_at,
      (select max(l.recorded_at) from live_locations l where l.profile_id=p.id and l.deleted_at is null
         and l.service_date=${date}::date and l.sample is not true) as last_position_at,
      (select w.ended_at from fieldsync_work_days w where w.profile_id=p.id and w.service_date=${date}::date) as day_ended_at
    from profiles p left join visit_executions v on v.assignee_profile_id=p.id
      and v.service_date=${date}::date and v.deleted_at is null
    where p.id in ${db(ids)} group by p.id`;
  return new Map(
    rows.map((/** @type {any} */ r) => {
      const seen = [ms(r.last_activity_at), ms(r.last_position_at)].filter(
        (x) => x !== null,
      );
      return [
        r.id,
        { ...r, last_seen_at: seen.length ? Math.max(...seen) : null },
      ];
    }),
  );
}

/**
 * The one status rule. `date` is the day shown; past days have no "idle"/"working".
 * Pages pass their own planned/done counts (Today and the agent day use the governed analytics
 * call counts) so the status can never contradict the stops shown beside it.
 * @param {any} f a dayFacts row (or undefined: nothing recorded)
 * @param {string} date @param {number} now
 * @param {{planned?:number, done?:number}} [counts]
 * @returns {"no_plan"|"not_started"|"in_call"|"working"|"idle"|"done"}
 */
export function fieldStatus(f, date, now, counts = {}) {
  const planned = Number(counts.planned ?? f?.planned ?? 0),
    done = Number(counts.done ?? f?.planned_done ?? 0),
    checkedIn = Math.max(Number(f?.visited ?? 0), done);
  if (!checkedIn) return planned ? "not_started" : "no_plan";
  if (Number(f?.in_progress ?? 0) > 0 && date === manilaDay(now))
    return "in_call";
  if (f?.day_ended_at || date < manilaDay(now) || (planned > 0 && done >= planned))
    return "done";
  const last = f?.last_seen_at ?? null;
  return last !== null && now - last > IDLE_AFTER_MS ? "idle" : "working";
}

/** The shared per-person numbers the Live map shows. @param {any} f */
export function fieldNumbers(f) {
  return {
    planned: Number(f?.planned ?? 0),
    visited: Number(f?.planned_done ?? 0),
    checkIns: Number(f?.visited ?? 0),
    productive: Number(f?.productive ?? 0),
    lastSeenAt: f?.last_seen_at ?? null,
  };
}
