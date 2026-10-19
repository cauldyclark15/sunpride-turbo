import { scopeFilterForActor } from "../org/scope.js";
import { bounded, ms, ZERO_UUID } from "./model.js";

/** The mobile exception dictionary intentionally carries no raw fixes or actor tokens.
 * @param {any} ctx @param {string[]} ids @param {string} date
 */
export async function teamExceptions(ctx, ids, date) {
  if (!ids.length) return [];
  const db = ctx.db;
  const { unitIds } = await scopeFilterForActor(db, ctx.actor);
  const units = unitIds?.length ? unitIds : [ZERO_UUID];
  const locations = bounded(
    await db`
    select e.id,e.event,e.result,e.review_status,e.server_time,e.distance_meters,
      v.assignee_profile_id,p.name as person_name,o.code as outlet_code,o.name as outlet_name
    from visit_location_evidence e join visit_executions v on v.id=e.visit_id
      join profiles p on p.id=v.assignee_profile_id join outlets o on o.id=v.outlet_id
    where v.assignee_profile_id in ${db(ids)} and v.service_date=${date}::date
      and v.deleted_at is null and e.deleted_at is null and e.result!='within_radius'
      and (${unitIds === null} or v.org_unit_id in ${db(units)})
    order by e.server_time,e.id limit 1001`,
    1000,
  );
  /** @type {any[]} */
  const items = locations.map((/** @type {any} */ e) => ({
    id: e.id,
    kind: "location",
    open: e.review_status === "pending_review",
    profileId: e.assignee_profile_id,
    personName: e.person_name,
    outletCode: e.outlet_code,
    outletName: e.outlet_name,
    at: ms(e.server_time),
    result: e.result,
    distanceMeters: e.distance_meters,
    sequence: null,
    after: null,
    reason: null,
    decisionStatus: e.review_status,
  }));
  const visits = bounded(
    await db`
    select v.id,v.assignee_profile_id,v.checked_in_at,v.late_sync_at,v.late_review_status,v.reason_code,s.sequence,
      p.name as person_name,o.code as outlet_code,o.name as outlet_name
    from visit_executions v join profiles p on p.id=v.assignee_profile_id join outlets o on o.id=v.outlet_id
    left join planned_visits pv on pv.id=v.planned_visit_id left join coverage_plan_slots s on s.id=pv.plan_slot_id
    where v.assignee_profile_id in ${db(ids)} and v.service_date=${date}::date and v.deleted_at is null
      and (${unitIds === null} or v.org_unit_id in ${db(units)})
    order by v.assignee_profile_id,v.checked_in_at nulls last,v.id limit 5001`,
    5000,
  );
  /** @type {Map<string,number>} */
  const highest = new Map();
  for (const v of visits) {
    const base = {
      profileId: v.assignee_profile_id,
      personName: v.person_name,
      outletCode: v.outlet_code,
      outletName: v.outlet_name,
      result: null,
      distanceMeters: null,
      sequence: null,
      after: null,
      reason: null,
      decisionStatus: null,
    };
    if (v.checked_in_at !== null && v.sequence !== null) {
      const previous = highest.get(v.assignee_profile_id);
      if (previous !== undefined && v.sequence < previous)
        items.push({
          ...base,
          id: `sequence:${v.id}`,
          kind: "out_of_sequence",
          open: true,
          at: ms(v.checked_in_at),
          sequence: v.sequence,
          after: previous,
        });
      highest.set(
        v.assignee_profile_id,
        Math.max(previous ?? v.sequence, v.sequence),
      );
    }
    if (v.late_sync_at !== null)
      items.push({
        ...base,
        id: `late:${v.id}`,
        kind: "late_sync",
        open:
          v.late_review_status !== "accepted" &&
          v.late_review_status !== "rejected",
        at: ms(v.late_sync_at),
        reason: v.reason_code,
        decisionStatus: v.late_review_status,
      });
  }
  return items.sort(
    (a, b) =>
      (b.open ? 1 : 0) - (a.open ? 1 : 0) ||
      (b.at ?? 0) - (a.at ?? 0) ||
      a.id.localeCompare(b.id),
  );
}
