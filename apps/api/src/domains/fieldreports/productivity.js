import { summarizePeriod } from "./productivity-rules.js";
import { dates, person, roster, standard } from "./common.js";
import { dsr, execution } from "./reads.js";
import { DONE, reportDueAt } from "./rules.js";
/** @param {any} c @param {any} a */
export async function productivity(c, a) {
  const p = await person(c, a.profileId);
  const days = /** @type {any[]} */ ([]);
  for (const d of dates(a.from, a.to)) {
    const r = await dsr(c, { profileId: p.id, serviceDate: d });
    const x = await execution(c, p, d);
    days.push({
      serviceDate: d,
      closed: c.now > reportDueAt(d),
      sellingDay: r.sellingDay,
      planned: x.summary.planned,
      plannedDone: x.summary.plannedDone,
      calls: x.summary.calls,
      productiveCalls: x.summary.productiveCalls,
      convertedCalls: x.visits.filter(
        (v) =>
          DONE.has(v.state) &&
          v.source === "planned" &&
          v.planned?.status === "planned" &&
          v.activities.some(
            (/** @type {any} */ a) => a.activity_kind === "order_intent",
          ),
      ).length,
      visits: x.visits.length,
      unplanned: x.summary.unplanned,
      exceptionVisits: x.visits.filter((v) =>
        v.evidence.some((/** @type {any} */ e) => e.result !== "within_radius"),
      ).length,
      locationExceptions: x.visits.reduce(
        (n, v) =>
          n +
          v.evidence.filter(
            (/** @type {any} */ e) => e.result !== "within_radius",
          ).length,
        0,
      ),
      outOfSequence: x.sequenceIssues.size,
      orders: r.orderCountToday,
      sales: r.totals.todaySales,
      callsTarget: r.sellingDay ? r.calls.dailyCallsTarget : null,
    });
  }
  const st = await standard(c, p, a.to);
  return {
    profileId: p.id,
    name: p.name,
    employeeCode: p.employee_code,
    positionLabel: p.position_label,
    channel: p.channel_scope ?? "Unassigned",
    direct: false,
    from: a.from,
    to: a.to,
    productiveCallTargetPct: st?.productive_call_target_pct ?? null,
    sourceRef: "Source visits and order lines; same sales definition as DSR",
    figures: summarizePeriod(days),
    days,
  };
}
/** @param {any} c @param {any} a */
export async function productivityRoster(c, a) {
  const rows = await roster(c, a);
  return {
    truncated: false,
    directReports: rows.filter((/** @type {any} */ p) => p.direct).length,
    people: rows.map((/** @type {any} */ p) => ({
      profileId: p.id,
      name: p.name,
      employeeCode: p.employee_code,
      positionLabel: p.position_label,
      channel: p.channel,
      direct: p.direct,
    })),
  };
}
