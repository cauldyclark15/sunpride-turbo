import { visitFrequencyLabel } from "@sunpride/customer-master";
import {
  DAY,
  bounded,
  civil,
  localDate,
  monthDates,
  planRows,
} from "./model.js";
import { eligibleOutlets } from "./roster.js";

/** Create immutable dated route identities inside the approval transaction.
 * The signed slots hold their ordered stops; legacy assignment route IDs stay intact.
 * @param {any} db @param {any} p @param {any[]} snapshots */
export async function dateRoutes(db, p, snapshots) {
  const dates = [
    ...new Set(
      snapshots
        .filter((s) => s.kind === "outlet_visit")
        .map((s) => s.serviceDate),
    ),
  ].sort();
  for (const date of dates) {
    const [number] =
      await db`select nextval('coverage_daily_route_number') as n`;
    const code = String(number.n).padStart(3, "0");
    const [route] =
      await db`insert into coverage_daily_routes(plan_id,assignee_profile_id,service_date,route_number,code) values (${p.id},${p.assignee_profile_id},${date},${number.n},${code}) returning id`;
    for (const s of snapshots.filter(
      (s) => s.serviceDate === date && s.kind === "outlet_visit",
    ))
      Object.assign(s.approvedSnapshot, {
        dailyRouteId: route.id,
        dailyRouteCode: code,
        dailyRouteDate: date,
      });
  }
}

/** Full-month, distinct visit-day counts, including the retained prefix of each predecessor.
 * Customer requirements, not the salesman's editable cadence, define the advisory.
 * @param {any} ctx @param {any} p @param {any[]} [slots] */
export async function frequencyWarnings(ctx, p, slots) {
  const eligible = await eligibleOutlets(ctx, p);
  const days = monthDates(p.local_month);
  const counts = new Map();
  const add = (
    /** @type {any[]} */ rows,
    /** @type {number} */ from,
    /** @type {number} */ to,
  ) => {
    for (const row of rows) {
      const s = row.serviceDate ? row : civil(row);
      if (
        s.kind !== "outlet_visit" ||
        localDate(s.serviceDate) < from ||
        localDate(s.serviceDate) >= to
      )
        continue;
      if (!counts.has(s.outletId)) counts.set(s.outletId, new Set());
      counts.get(s.outletId).add(s.serviceDate);
    }
  };
  add(
    slots ?? (await planRows(ctx.db, p.id)).slots,
    +new Date(p.effective_from),
    +new Date(p.effective_to),
  );
  let parentId = p.based_on_plan_id,
    before = +new Date(p.effective_from);
  const seen = new Set([p.id]);
  while (parentId) {
    if (seen.has(parentId) || seen.size > 100)
      throw new Error("Invalid plan revision chain");
    seen.add(parentId);
    const [parent] =
      await ctx.db`select * from coverage_plans where id=${parentId} and assignee_profile_id=${p.assignee_profile_id} and local_month=${p.local_month} and deleted_at is null`;
    if (!parent?.signed_content) break;
    add(parent.signed_content.slots, +new Date(parent.effective_from), before);
    before = +new Date(parent.effective_from);
    parentId = parent.based_on_plan_id;
  }
  return bounded(
    eligible.flatMap(({ outlet: o }) => {
      const expected =
        o.visit_frequency_per_month ??
        (o.visit_frequency_days === 30
          ? 1
          : o.visit_frequency_days
            ? Math.ceil(days.length / o.visit_frequency_days)
            : null);
      const planned = counts.get(o.id)?.size ?? 0;
      return expected != null
        ? [
            {
              outletId: o.id,
              name: o.name,
              expected,
              planned,
              requirement: visitFrequencyLabel(
                o.visit_frequency_days,
                o.visit_frequency_per_month,
              ),
            },
          ]
        : [];
    }),
    "Visit frequency warnings",
  );
}

/** Following Monday–Sunday, with review due at the end of Saturday in Manila.
 * @param {number} now */
export function weeklyWindow(now) {
  const today = new Date(now + 28800000).toISOString().slice(0, 10);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = localDate(today) + (8 - (weekday || 7)) * DAY;
  const date = (/** @type {number} */ at) =>
    new Date(at + 28800000).toISOString().slice(0, 10);
  return {
    weekStart: date(start),
    weekEnd: date(start + 6 * DAY),
    dueDate: date(start - 2 * DAY),
    dueAt: start - DAY,
    reminder: now >= start - 4 * DAY,
    overdue: now >= start - DAY,
  };
}
