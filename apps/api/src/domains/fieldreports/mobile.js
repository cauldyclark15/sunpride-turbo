import { date, fail, requireCapability, uuid } from "./common.js";
import { dsr } from "./reads.js";
import { exceptions, teamDay } from "./team.js";

/**
 * E2E-018: office decisions on this person's phone orders (field_order_captures → orders), newest reason first.
 * @param {any} c @param {{profileId:string, serviceDate:string}} p
 */
export async function orderDecisions(c, p) {
  const rows = await c.db`
    select f.client_order_id, o.status,
      (select h.reason from order_history h where h.order_id=o.id and h.to_status=o.status
        order by h.created_at desc limit 1) as reason
    from field_order_captures f join orders o on o.id=f.order_id join visit_executions v on v.id=f.visit_id
    where v.assignee_profile_id=${p.profileId} and v.deleted_at is null and o.deleted_at is null
      and v.service_date>${p.serviceDate}::date-3 and v.service_date<=${p.serviceDate}::date
      and o.status in ('approved','rejected','posted','fulfilled','voided')
    order by f.created_at, f.client_order_id limit 200`;
  return rows.map((/** @type {any} */ r) => ({
    clientOrderId: r.client_order_id,
    status: r.status,
    reason:
      ["rejected", "voided"].includes(r.status) && r.reason
        ? String(r.reason).slice(0, 500)
        : null,
  }));
}

/** On-demand projections only: callers start each request with since:null (D4).
 * @param {any} platform */
export function installProjections(platform) {
  platform.registerProjection("field.sales", {
    params: (/** @type {any} */ p) => ({
      profileId: uuid(p?.profileId),
      serviceDate: date(p?.serviceDate),
    }),
    snapshot: async (/** @type {any} */ c) => {
      const r = await dsr(c, c.params);
      // E2E-018: the seller's own phone orders the office decided (approved/rejected...) in the last 3 days,
      // keyed by the phone's draft id, so a rejected order reads "Rejected" with the office's reason after sync.
      const own = c.params.profileId === c.actor?.profileId;
      const decisions = own ? await orderDecisions(c, c.params) : null;
      return {
        data: {
          ...(decisions ? { orderDecisions: decisions } : {}),
          serviceDate: r.serviceDate,
          targets: { daily: r.targets.daily, monthly: r.targets.monthly },
          totals: {
            todaySales: r.totals.todaySales,
            todayPct: r.totals.todayPct,
            mtdSales: r.totals.mtdSales,
          },
          calls: {
            productiveCallRule: r.calls.productiveCallRule,
            calls: r.calls.calls,
            productiveCalls: r.calls.productiveCalls,
          },
        },
        next: null,
      };
    },
  });
  platform.registerProjection("team.summary", {
    params: (/** @type {any} */ p) => {
      if (typeof p?.directOnly !== "boolean")
        fail("Choose direct reports or the whole team", 400);
      return { serviceDate: date(p?.serviceDate), directOnly: p.directOnly };
    },
    snapshot: async (/** @type {any} */ c) => {
      await requireCapability(c, "people.read");
      await requireCapability(c, "visit.read");
      const day = await teamDay(c, c.params);
      const queue = await exceptions(c, c.params);
      const rows = queue.items.slice(0, 50).map((i) => ({
        id: i.id,
        kind: i.kind,
        open: i.open,
        profileId: i.profileId,
        personName: i.personName,
        outletCode: i.outletCode,
        outletName: i.outletName,
        at: i.at,
        event: i.event,
        result: i.result,
        distanceMeters: i.distanceMeters,
        sequence: i.sequence,
        after: i.after,
        reason: i.reason,
        decisionStatus: i.decision?.status ?? null,
      }));
      return {
        data: {
          serviceDate: day.serviceDate,
          generatedAt: c.now,
          dayCloseAt: day.dayCloseAt,
          directOnly: c.params.directOnly,
          truncated: queue.items.length > 50,
          people: day.people,
          openExceptions: queue.openTotal,
          totalExceptions: queue.total,
          exceptions: rows,
        },
        next: null,
      };
    },
  });
}
