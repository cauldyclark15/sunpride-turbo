import { ApiError } from "../../core/errors.js";
import { uuid } from "./model.js";
/**
 * ORG seam: call INSIDE the same transaction before any assignment/route write.
 * Every caller and approval take the same transaction advisory lock, so a concurrent
 * approval cannot race an unlocked master-data edit. Intervals are [from,to).
 * @param {any} tx
 * @param {{outletIds?:string[],routeIds?:string[],from:number|Date,to?:number|Date|null}} input
 */
export async function assertNotLocked(
  tx,
  { outletIds = [], routeIds = [], from, to = null },
) {
  await tx`select pg_advisory_xact_lock(hashtextextended('coverage:master-lock',0))`;
  for (const id of [...outletIds, ...routeIds]) uuid(id);
  const start = new Date(from),
    end = to == null ? null : new Date(to);
  if (
    !Number.isFinite(+start) ||
    (end && !Number.isFinite(+end)) ||
    (end && end <= start)
  )
    throw new ApiError("invalid_interval", 400, "Invalid assignment interval");
  const [locked] =
    await tx`select p.id from coverage_plans p where p.deleted_at is null and p.status in ('approved','active','superseded')
    and p.effective_from<coalesce(${end}::timestamptz,'infinity'::timestamptz) and coalesce(p.active_through,p.effective_to)>${start}
    and (exists(select 1 from coverage_plan_outlets o where o.plan_id=p.id and (o.outlet_id=any(${tx.array(outletIds, "UUID")}) or o.route_id=any(${tx.array(routeIds, "UUID")})))
      or exists(select 1 from coverage_plan_slots s where s.plan_id=p.id and s.deleted_at is null and (s.outlet_id=any(${tx.array(outletIds, "UUID")}) or s.route_id=any(${tx.array(routeIds, "UUID")})))) limit 1`;
  if (locked)
    throw new ApiError(
      "coverage_locked",
      409,
      "An approved MCP locks these assignments or routes for the approved interval; revise the plan first",
    );
}
