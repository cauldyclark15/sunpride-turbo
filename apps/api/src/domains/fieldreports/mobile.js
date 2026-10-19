import { date, fail, requireCapability, uuid } from "./common.js";
import { dsr } from "./reads.js";
import { exceptions, teamDay } from "./team.js";

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
      return {
        data: {
          serviceDate: r.serviceDate,
          targets: { daily: r.targets.daily, monthly: r.targets.monthly },
          totals: {
            todaySales: r.totals.todaySales,
            todayPct: r.totals.todayPct,
            mtdSales: r.totals.mtdSales,
          },
          calls: { productiveCallRule: r.calls.productiveCallRule },
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
