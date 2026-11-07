import { dayString, refuse } from "./model.js";

/** F-122 governed by frozen receipts and actual stops, not a checkout-outcome shortcut.
 * @param {{sales:any[],stops:any[],payments:any[],returnDocuments:number,varianceCentavos:string|null,plannedCalls:number,refundedCentavos?:string|bigint}} input
 */
export function scorecardMetrics(input) {
  const refunded = BigInt(input.refundedCentavos ?? 0);
  const sales = input.sales.filter((s) => !s.voided),
    stores = new Set(
      sales.filter((s) => BigInt(s.totalCentavos) > 0n).map((s) => s.outletId),
    );
  const called = new Set(
    input.stops.filter((s) => s.phase === "arrival").map((s) => s.outletId),
  );
  const salesCentavos =
    sales.reduce((n, s) => n + BigInt(s.totalCentavos), 0n) - refunded;
  const collected = input.payments
    .filter((p) => p.method !== "credit")
    .reduce(
      (n, p) =>
        n +
        (["refund", "void_refund"].includes(p.kind) ? -1n : 1n) *
          BigInt(p.amountCentavos),
      0n,
    );
  const refunds = input.payments
    .filter((p) => p.kind === "refund")
    .reduce((n, p) => n + BigInt(p.amountCentavos), 0n);
  const callFactsComplete = sales.every((s) => called.has(s.outletId));
  const productiveCalls = [...stores].filter((id) => called.has(id)).length;
  const buying = new Map();
  for (const s of sales.filter((s) => BigInt(s.totalCentavos) > 0n))
    buying.set(s.outletId, (buying.get(s.outletId) ?? 0) + 1);
  return {
    salesCentavos: String(salesCentavos),
    calls: called.size,
    plannedCalls: input.plannedCalls,
    productiveCalls,
    strikeRateBasisPoints:
      called.size && callFactsComplete
        ? Math.round((productiveCalls * 10000) / called.size)
        : null,
    dropSizeCentavos: stores.size
      ? String(salesCentavos / BigInt(stores.size))
      : null,
    returnDocuments: input.returnDocuments,
    refundsCentavos: String(refunds),
    varianceCentavos: input.varianceCentavos,
    collectedCentavos: String(collected),
    callFactsComplete,
    calledOutletIds: [...called],
    productiveOutletCounts: [...buying].map(([outletId, count]) => ({
      outletId,
      count,
    })),
    definitions:
      "Sales exclude voids and are before returns. Calls are distinct stores with an arrival; strike rate needs actual stop facts for every sale. Drop size is sales per buying store. Returns are documents; refunds are actual refunded money. Collections exclude credit promises.",
  };
}

/** F-122 caller already holds the authorized trip. @param {any} db @param {any} trip */
export async function tripScorecard(db, trip) {
  const sales =
    await db`select s.outlet_id as "outletId",s.total_centavos::text as "totalCentavos",exists(select 1 from van_sale_voids v where v.sale_id=s.id) as voided from van_sales s where s.trip_id=${trip.id} limit 5001`;
  const stops =
    await db`select outlet_id as "outletId",facts->>'phase' as phase from van_trip_observations where trip_id=${trip.id} and kind='stop' limit 1201`;
  const payments =
    await db`select kind,method,amount_centavos::text as "amountCentavos" from van_payments where trip_id=${trip.id} limit 5001`;
  if (sales.length > 5000 || stops.length > 1200 || payments.length > 5000)
    refuse("The trip exceeds the supported scorecard bound");
  const [returns] =
    await db`select count(*)::int as n from van_returns where trip_id=${trip.id}`;
  const [refunds] =
    await db`select coalesce(sum(total_centavos),0)::text as total from sale_refunds where trip_id=${trip.id}`;
  const [variance] =
    await db`select facts->>'varianceCentavos' as amount from van_settlements where trip_id=${trip.id} order by version desc limit 1`;
  const day = dayString(trip.service_date),
    at = new Date(`${day}T12:00:00+08:00`),
    month = day.slice(0, 7);
  const [planned] = trip.route_id
    ? await db`select count(distinct outlet_id)::int as n from outlet_assignments where route_id=${trip.route_id} and effective_from<=${at} and (effective_to is null or effective_to>${at}) and deleted_at is null`
    : [{ n: 0 }];
  const trend =
    await db`select t.service_date as date,(coalesce(sum(s.total_centavos) filter(where v.id is null),0)-coalesce((select sum(r.total_centavos) from sale_refunds r join van_trips x on x.id=r.trip_id where x.service_date=t.service_date and x.salesperson_profile_id=${trip.salesperson_profile_id} and x.org_unit_id=${trip.org_unit_id} and x.deleted_at is null and x.status<>'cancelled'),0))::text as "salesCentavos" from van_trips t left join van_sales s on s.trip_id=t.id left join van_sale_voids v on v.sale_id=s.id where t.salesperson_profile_id=${trip.salesperson_profile_id} and t.org_unit_id=${trip.org_unit_id} and t.deleted_at is null and t.status<>'cancelled' and t.service_date between ${day}::date-13 and ${day}::date group by t.service_date order by t.service_date`;
  const [prior] =
    await db`select t.service_date as date,(coalesce(sum(s.total_centavos) filter(where v.id is null),0)-coalesce((select sum(r.total_centavos) from sale_refunds r join van_trips x on x.id=r.trip_id where x.service_date=t.service_date and x.salesperson_profile_id=${trip.salesperson_profile_id} and x.org_unit_id=${trip.org_unit_id} and x.deleted_at is null and x.status<>'cancelled'),0))::text as "salesCentavos" from van_trips t left join van_sales s on s.trip_id=t.id left join van_sale_voids v on v.sale_id=s.id where t.salesperson_profile_id=${trip.salesperson_profile_id} and t.org_unit_id=${trip.org_unit_id} and t.deleted_at is null and t.status<>'cancelled' and t.service_date<${day} group by t.service_date order by t.service_date desc limit 1`;
  const targets =
    await db`select coalesce(amount_centavos,round(value*100)::bigint)::text as amount from sales_targets where profile_id=${trip.salesperson_profile_id} and metric='sales_value' and period='monthly' and deleted_at is null and (month=${month} or (month is null and effective_from<=${at} and (effective_to is null or effective_to>${at}))) limit 2`;
  const [mtd] =
    await db`select (coalesce(sum(s.total_centavos),0)-coalesce((select sum(r.total_centavos) from sale_refunds r join van_trips x on x.id=r.trip_id where x.salesperson_profile_id=${trip.salesperson_profile_id} and x.org_unit_id=${trip.org_unit_id} and x.deleted_at is null and x.status<>'cancelled' and x.service_date between ${month + "-01"} and ${day}),0))::text as amount from van_sales s join van_trips t on t.id=s.trip_id where t.salesperson_profile_id=${trip.salesperson_profile_id} and t.org_unit_id=${trip.org_unit_id} and t.deleted_at is null and t.status<>'cancelled' and t.service_date between ${month + "-01"} and ${day} and not exists(select 1 from van_sale_voids v where v.sale_id=s.id)`;
  return {
    ...scorecardMetrics({
      sales,
      stops,
      payments,
      returnDocuments: returns.n,
      refundedCentavos: refunds.total,
      varianceCentavos: variance?.amount ?? null,
      plannedCalls: planned.n,
    }),
    prior: prior
      ? { date: dayString(prior.date), salesCentavos: prior.salesCentavos }
      : null,
    trend: trend.map((/** @type {any} */ r) => ({
      ...r,
      date: dayString(r.date),
    })),
    monthTargetCentavos: targets.length === 1 ? targets[0].amount : null,
    monthSalesCentavos: mtd.amount,
    targetStatus:
      targets.length === 1
        ? "configured"
        : targets.length
          ? "ambiguous"
          : "needs_setup",
  };
}
