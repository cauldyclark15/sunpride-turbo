import { tx } from "@sunpride/db/client";
import { ApiError } from "../../core/errors.js";
import { scopeFilterForActor } from "../org/scope.js";
import { requireCapability } from "../../core/capabilities.js";
import { currentActor, tripFor, can } from "./access.js";
import { cashExpectation } from "./facts.js";
import { date, dayString, safeNumber, today, units } from "./model.js";

/** @param {any} v */
const ms = (v) => (v ? new Date(v).getTime() : null);
/** @param {bigint} v @param {any} facts */
const display = (v, facts) => ({
  base: String(v),
  ...units(v, BigInt(facts.caseBase ?? 0), BigInt(facts.pieceBase ?? 0)),
});
/** A full settlement explanation from frozen, append-only facts. @param {any} db @param {any} actor @param {string} tripId */
export async function tripDetail(db, actor, tripId) {
  const trip = await tripFor(db, actor, tripId);
  const [master] =
    await db`select v.vehicle_code,v.plate_number,v.name as truck_name,p.name as seller,u.name as unit_name,r.name as route_name from vehicles v join profiles p on p.id=${trip.salesperson_profile_id} join org_units u on u.id=${trip.org_unit_id} left join routes r on r.id=${trip.route_id} where v.id=${trip.vehicle_id}`;
  /** @type {any[]} */ const events =
    await db`select * from van_stock_events where trip_id=${tripId} order by created_at,id`;
  /** @type {any[]} */ const counts =
    await db`select l.* from van_stock_count_lines l join van_stock_counts c on c.id=l.count_id where c.trip_id=${tripId}`;
  /** @type {Map<string,any>} */ const products = new Map();
  for (const e of events) {
    const row = products.get(e.product_id) ?? {
      productId: e.product_id,
      facts: e.facts,
      loaded: 0n,
      sold: 0n,
      returned: 0n,
      damaged: 0n,
      voided: 0n,
      unloaded: 0n,
      available: 0n,
      damageStock: 0n,
    };
    const qty = BigInt(e.delta_base);
    if (e.kind === "load") row.loaded += qty;
    if (e.kind === "sale") row.sold -= qty;
    if (e.kind === "void") row.voided += qty;
    if (e.kind === "return") row.returned += qty;
    if (e.kind === "damage" && e.stock_status === "damaged") row.damaged += qty;
    if (e.kind === "damage_reversal" && e.stock_status === "damaged")
      row.damaged += qty;
    if (e.kind === "unload") row.unloaded -= qty;
    if (!["count_adjustment", "unload"].includes(e.kind)) {
      if (e.stock_status === "available") row.available += qty;
      else row.damageStock += qty;
    }
    products.set(e.product_id, row);
  }
  const stock = [...products.values()].map((r) => {
    const own = counts.filter((c) => c.product_id === r.productId);
    const counted = own.length
      ? own.reduce((a, c) => a + BigInt(c.counted_base), 0n)
      : null;
    const expected = BigInt(r.available) + BigInt(r.damageStock);
    const variance = counted === null ? null : counted - expected;
    const value =
      own.length && own.every((c) => c.value_centavos !== null)
        ? own.reduce((a, c) => a + BigInt(c.value_centavos), 0n)
        : null;
    return {
      productId: r.productId,
      code: r.facts.code,
      name: r.facts.name,
      uomCode: r.facts.uomCode,
      loaded: display(r.loaded, r.facts),
      sold: display(r.sold, r.facts),
      voided: display(r.voided, r.facts),
      returned: display(r.returned, r.facts),
      damaged: display(r.damaged, r.facts),
      unloaded: display(r.unloaded, r.facts),
      expected: display(expected, r.facts),
      expectedAvailable: display(r.available, r.facts),
      expectedDamaged: display(r.damageStock, r.facts),
      counted: counted === null ? null : display(counted, r.facts),
      variance: variance === null ? null : display(variance, r.facts),
      varianceCentavos: value === null ? null : safeNumber(value),
      countLines: own.map((c) => ({
        status: c.stock_status,
        expectedBase: String(c.expected_base),
        countedBase: String(c.counted_base),
        reason: c.facts.reasonCode ?? null,
      })),
    };
  });
  /** @type {any[]} */ const sales =
    await db`select s.*,v.id as void_id,a.issuer_name as approved_by,v.reason as void_reason from van_sales s left join van_sale_voids v on v.sale_id=s.id left join van_approval_codes a on a.id=v.approval_id where s.trip_id=${tripId} order by s.created_at`;
  /** @type {any[]} */ const payments =
    await db`select * from van_payments where trip_id=${tripId} order by created_at`;
  /** @type {any[]} */ const returns =
    await db`select r.*,coalesce((select jsonb_agg(l.facts order by l.ordinal) from van_return_lines l where l.return_id=r.id),'[]'::jsonb) as lines from van_returns r where trip_id=${tripId} order by created_at`;
  const [cash] =
    await db`select c.*,a.issuer_name as approved_by from van_cash_counts c left join van_approval_codes a on a.id=c.approval_id where c.trip_id=${tripId}`;
  const [count] =
    await db`select c.*,a.issuer_name as approved_by from van_stock_counts c left join van_approval_codes a on a.id=c.approval_id where c.trip_id=${tripId}`;
  /** @type {any[]} */ const loads =
    await db`select l.*,coalesce((select jsonb_agg(jsonb_build_object('lineNumber',ll.line_number,'productCode',ll.product_code,'expectedBase',ll.expected_base::text,'actualBase',ll.actual_base::text,'reason',ll.discrepancy_reason) order by ll.line_number) from van_trip_load_lines ll where ll.load_id=l.id),'[]'::jsonb) as lines from van_trip_loads l where trip_id=${tripId} and deleted_at is null`;
  /** @type {any[]} */ const history =
    await db`select id,actor_name,kind,details,created_at from van_audit_events where trip_id=${tripId} order by created_at,id`;
  const [remittance] =
    await db`select * from van_cash_remittances where trip_id=${tripId}`;
  const expected = await cashExpectation(db, tripId),
    netSales = sales
      .filter((s) => !s.void_id)
      .reduce((a, s) => a + BigInt(s.total_centavos), 0n);
  const settlementStatus =
    trip.status === "closed"
      ? "settled"
      : ["reconciling", "closing", "review_required"].includes(trip.status)
        ? "needs_review"
        : trip.status;
  return {
    tripId,
    tripNumber: trip.trip_number,
    date: dayString(trip.service_date),
    unitId: trip.org_unit_id,
    unit: master?.unit_name ?? "Former unit",
    truck: master?.truck_name ?? master?.vehicle_code ?? "Former truck",
    plateNumber: master?.plate_number ?? "",
    seller: master?.seller ?? "Former seller",
    route: master?.route_name ?? "No route",
    status: trip.status,
    settlementStatus,
    startedAt: ms(trip.started_at),
    closedAt: ms(trip.closed_at),
    unclosed: !["closed", "cancelled"].includes(trip.status),
    salesCentavos: safeNumber(netSales),
    discountsCentavos: safeNumber(
      sales
        .filter((s) => !s.void_id)
        .reduce((a, s) => a + BigInt(s.discount_centavos), 0n),
    ),
    stock,
    cash: {
      expectedCentavos: safeNumber(expected),
      cashSalesCentavos: safeNumber(
        payments
          .filter((p) => p.kind === "sale" && p.method === "cash")
          .reduce((a, p) => a + BigInt(p.amount_centavos), 0n),
      ),
      collectionsCentavos: safeNumber(
        payments
          .filter((p) => p.kind === "collection" && p.method === "cash")
          .reduce((a, p) => a + BigInt(p.amount_centavos), 0n),
      ),
      refundsCentavos: safeNumber(
        payments
          .filter(
            (p) =>
              ["refund", "void_refund"].includes(p.kind) && p.method === "cash",
          )
          .reduce((a, p) => a + BigInt(p.amount_centavos), 0n),
      ),
      declaredCentavos: cash ? safeNumber(cash.declared_centavos) : null,
      remittedCentavos: remittance
        ? safeNumber(remittance.amount_centavos)
        : null,
      receivedBy: remittance?.received_by_name ?? null,
      receivedAt: ms(remittance?.created_at),
      countVarianceCentavos: cash ? safeNumber(cash.variance_centavos) : null,
      varianceCentavos: remittance
        ? safeNumber(BigInt(remittance.amount_centavos) - expected)
        : null,
      reason: cash?.facts.reasonCode ?? null,
      approvedBy: cash?.approved_by ?? null,
      countedAt: ms(cash?.created_at),
    },
    stockCount: count
      ? {
          countCode: count.count_code,
          varianceLines: count.variance_lines,
          shortBase: String(count.short_base),
          overBase: String(count.over_base),
          approvedBy: count.approved_by ?? null,
          countedAt: ms(count.created_at),
        }
      : null,
    loads: loads.map((l) => ({
      loadId: l.id,
      status: l.status,
      lines: l.lines,
    })),
    sales: sales.map((s) => ({
      saleId: s.id,
      receiptNumber: s.receipt_number,
      totalCentavos: safeNumber(s.total_centavos),
      receipt: s.receipt,
      voided: Boolean(s.void_id),
      voidReason: s.void_reason ?? null,
      approvedBy: s.approved_by ?? null,
    })),
    returns: returns.map((r) => ({
      returnId: r.id,
      returnNumber: r.return_number,
      originalSaleId: r.sale_id,
      lines: r.lines,
      recordedAt: ms(r.created_at),
    })),
    payments: payments.map((p) => ({
      kind: p.kind,
      method: p.method,
      amountCentavos: safeNumber(p.amount_centavos),
      recordedAt: ms(p.created_at),
    })),
    history: history.map((h) => ({
      id: h.id,
      actor: h.actor_name,
      kind: h.kind,
      details: h.details,
      at: ms(h.created_at),
    })),
    nextAction:
      trip.status === "closed"
        ? "Settlement complete"
        : !count
          ? "Count truck stock"
          : !cash
            ? "Count and remit cash"
            : !remittance
              ? "Confirm office receipt of the cash"
              : "Review differences and close the trip",
  };
}
/** @param {any} ctx */
export async function tripsForDay(ctx) {
  const serviceDate = date(ctx.url.searchParams.get("date") ?? today());
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor);
    await requireCapability({ db, actor }, "van.read");
    const scope = await scopeFilterForActor(db, actor);
    const all = scope.unitIds === null;
    const ids = scope.unitIds?.length
      ? scope.unitIds
      : ["00000000-0000-0000-0000-000000000000"];
    const base =
      await db`select id from van_trips where service_date=${serviceDate} and deleted_at is null and (${all} or org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or salesperson_profile_id=${actor.profileId}) order by trip_number limit 501`;
    if (base.length > 500)
      throw new ApiError(
        "report_too_large",
        422,
        "Narrow the day or organizational scope; this report exceeds 500 trips",
      );
    const result = [];
    for (const r of base) result.push(await tripDetail(db, actor, r.id));
    const from = new Date(serviceDate);
    from.setUTCDate(from.getUTCDate() - 13);
    /** @type {any[]} */ const trend =
      await db`select t.service_date,coalesce(sum(s.total_centavos) filter(where v.id is null),0)::text as sales from van_trips t left join van_sales s on s.trip_id=t.id left join van_sale_voids v on v.sale_id=s.id where t.service_date between ${from.toISOString().slice(0, 10)} and ${serviceDate} and t.deleted_at is null and (${all} or t.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or t.salesperson_profile_id=${actor.profileId}) group by t.service_date order by t.service_date`;
    const priorDate = new Date(serviceDate);
    priorDate.setUTCDate(priorDate.getUTCDate() - 1);
    return {
      date: serviceDate,
      asOf: Date.now(),
      targetCentavos: null,
      targetStatus: "needs_setup",
      priorDate: priorDate.toISOString().slice(0, 10),
      priorSalesCentavos: safeNumber(
        trend.find(
          (t) =>
            dayString(t.service_date) === priorDate.toISOString().slice(0, 10),
        )?.sales ?? 0,
      ),
      trend: trend.map((t) => ({
        date: dayString(t.service_date),
        salesCentavos: safeNumber(t.sales),
      })),
      rows: result,
    };
  });
}
/** @param {any} ctx */
export async function damageReview(ctx) {
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor);
    await requireCapability({ db, actor }, "van.read");
    const scope = await scopeFilterForActor(db, actor),
      ids = scope.unitIds?.length
        ? scope.unitIds
        : ["00000000-0000-0000-0000-000000000000"];
    const offsetText = ctx.url.searchParams.get("cursor") ?? "0";
    if (!/^\d{1,8}$/.test(offsetText))
      throw new ApiError("invalid_request", 400, "Invalid page cursor");
    const offset = Number(offsetText);
    /** @type {any[]} */ const records =
      await db`select d.*,t.trip_number,t.service_date,p.name as seller_name,pr.name as product_name from van_damage_records d join van_trips t on t.id=d.trip_id join profiles p on p.id=d.recorded_profile_id join products pr on pr.id=d.product_id
      where d.status='pending_approval' and d.deleted_at is null and (${scope.unitIds === null} or d.org_unit_id in ${db(ids)}) and (${actor.role !== "sales"} or d.recorded_profile_id=${actor.profileId}) order by d.recorded_at desc,d.id limit 21 offset ${offset}`;
    return {
      items: records.slice(0, 20).map((d) => ({
        damageId: d.id,
        tripId: d.trip_id,
        tripNumber: d.trip_number,
        serviceDate: dayString(d.service_date),
        sellerName: d.seller_name,
        productCode: d.product_code,
        productName: d.product_name,
        uomCode: d.uom_code,
        quantityBase: String(d.quantity_base),
        quantityScale: String(d.quantity_scale),
        reason: d.reason,
        note: d.note,
        photoUrl: d.photo_id
          ? `/api/v1/van/damage-photo?damageId=${d.id}`
          : null,
        status: d.status,
        recordedAt: ms(d.recorded_at),
        canDecide:
          can(actor, "van.damage.approve") &&
          d.recorded_profile_id !== actor.profileId,
      })),
      nextCursor: records.length > 20 ? String(offset + 20) : null,
    };
  });
}
/** @param {any[]} rows */
export function csv(rows) {
  const cell = (/** @type {any} */ v) =>
    `"${String(v ?? "")
      .replace(/^[=+\-@\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  return (
    "\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
