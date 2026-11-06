import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { scopeFilterForActor } from "../org/scope.js";
import { currentActor, tripFor } from "./access.js";
import { cashExpectation, productFor } from "./facts.js";
import { date, dayString, refuse, today, uuid } from "./model.js";
import { personOnDevice, rostersOn, vehicleOfDevice, crewDirectory, weekdayLabel } from "./roster.js";
import { planOf } from "./loadout.js";

/** Plain words for every stage (SPEC 3.10): "trip", "load-out", "settlement"; never "route session" or "load confirm". */
export const LOAD_LABELS = /** @type {Record<string,string>} */ ({
  none: "No load yet",
  suggested: "Suggested",
  approved: "Approved",
  picking: "Picking",
  dispatched: "Dispatched",
  accepted: "Accepted",
  difference: "Difference",
});
export const TRIP_LABELS = /** @type {Record<string,string>} */ ({
  not_planned: "No trip yet",
  planned: "Planned",
  loading: "Loading",
  loaded: "Loaded",
  active: "On route",
  closing: "Back",
  reconciling: "Back",
  review_required: "Needs review",
  closed: "Closed",
  cancelled: "Cancelled",
});
/** The board column of SPEC 5.5. @param {string} tripStatus @param {string} settlement */
const stageOf = (tripStatus, settlement) =>
  ({
    not_planned: "planned",
    planned: "planned",
    loading: "planned",
    loaded: "loaded",
    active: "on_route",
    closing: "back",
    reconciling: "back",
    review_required: "back",
    closed: settlement === "settled" ? "settled" : "closed",
  })[tripStatus] ?? "planned";

/** What the plan row means on the board (recount and disputed are both a "difference"). @param {string|undefined} state */
export const loadStateOf = (state) =>
  !state ? "none" : ["recount", "disputed"].includes(state) ? "difference" : state;

/** The one thing to do next on a truck's row. @param {any} r */
function primaryAction(r) {
  const t = r.tripId;
  if (!r.tripId && r.rostered)
    return { kind: "plan_trip", label: "Plan trip", enabled: true };
  if (r.load.state === "none" && r.trip.status === "planned")
    return { kind: "plan_load", label: "Plan load", enabled: true, tripId: t };
  if (r.load.state === "suggested")
    return r.load.attention.length
      ? { kind: "review_load", label: "Review load", enabled: true, tripId: t }
      : { kind: "approve_load", label: "Approve load", enabled: true, tripId: t };
  if (r.load.state === "approved")
    return { kind: "pick", label: "Start picking", enabled: true, tripId: t };
  if (r.load.state === "picking")
    return { kind: "dispatch", label: "Dispatch to truck", enabled: true, tripId: t };
  if (r.load.state === "dispatched")
    return { kind: "wait_seller", label: "Waiting for the seller", enabled: false, tripId: t };
  if (r.load.detail === "recount")
    return { kind: "recount", label: "Recount the load", enabled: true, tripId: t };
  if (r.load.detail === "disputed")
    return { kind: "decide", label: "Decide the difference", enabled: true, tripId: t };
  if (r.trip.status === "loaded")
    return { kind: "wait_start", label: "Waiting to start the trip", enabled: false, tripId: t };
  if (r.trip.status === "active")
    return { kind: "view_trip", label: "View trip", enabled: true, tripId: t };
  if (["closing", "reconciling", "review_required"].includes(r.trip.status))
    return { kind: "settle", label: "Settle", enabled: true, tripId: t };
  return { kind: "view_trip", label: "View trip", enabled: Boolean(t), tripId: t };
}

/** GET van/day-board?date=&unitId=: every truck of a depot for one day on one screen. @param {any} ctx */
export async function dayBoard(ctx) {
  const day = date(ctx.url.searchParams.get("date") ?? today());
  const unitId = ctx.url.searchParams.get("unitId");
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor);
    await requireCapability({ db, actor }, "van.read");
    const scope = await scopeFilterForActor(db, actor);
    const all = scope.unitIds === null,
      ids = scope.unitIds?.length ? scope.unitIds : ["00000000-0000-0000-0000-000000000000"];
    const inScope = (/** @type {string} */ u) => all || ids.includes(u);
    const trips = await db`select t.*,v.vehicle_code,v.plate_number,v.name as truck_name,r.name as route_name,s.name as seller_name
      from van_trips t join vehicles v on v.id=t.vehicle_id join profiles s on s.id=t.salesperson_profile_id left join routes r on r.id=t.route_id
      where t.service_date=${day}::date and t.deleted_at is null and t.status<>'cancelled' and (${all} or t.org_unit_id in ${db(ids)})
        and (${unitId}::uuid is null or t.org_unit_id=${unitId}::uuid) order by v.vehicle_code,t.created_at limit 301`;
    if (trips.length > 300) refuse("Narrow the depot; more than 300 trucks for one day", "report_too_large");
    const rosters = (await rostersOn(db, day, unitId)).filter((/** @type {any} */ r) => inScope(r.org_unit_id));
    /** @type {any[]} */ const rows = [];
    for (const t of trips) {
      const plan = await planOf(db, t.id);
      const lines = plan
        ? await db`select l.product_id,coalesce(l.approved_base,l.suggested_base)::bigint as q,l.case_base,l.flags from van_planned_load_lines l where l.planned_load_id=${plan.id}`
        : [];
      const [doc] = plan?.stock_transfer_id
        ? await db`select transfer_number,status,variance_status from stock_transfers where id=${plan.stock_transfer_id}`
        : [];
      const [sold] =
        await db`select coalesce(sum(s.total_centavos) filter (where v.id is null),0)::bigint as sales from van_sales s left join van_sale_voids v on v.sale_id=s.id where s.trip_id=${t.id}`;
      const [remit] =
        await db`select amount_centavos from van_cash_remittances where trip_id=${t.id}`;
      const [loadIn] =
        await db`select transfer_number,status,variance_status from stock_transfers where type='van_load_in' and source_location_id=${t.truck_location_id} and created_at>=${dayString(t.service_date)}::date order by created_at desc limit 1`;
      const settlement =
        t.status === "closed"
          ? "settled"
          : ["closing", "reconciling", "review_required"].includes(t.status)
            ? "needs_review"
            : "open";
      const crew = await crewDirectory(db, t.id);
      const sessionDevice = t.started_device_id;
      const on = sessionDevice ? await personOnDevice(db, sessionDevice) : null;
      const caseLines = lines.filter((/** @type {any} */ l) => Number(l.q) > 0);
      const row = {
        vehicleId: t.vehicle_id,
        vehicleCode: t.vehicle_code,
        plateNumber: t.plate_number,
        routeName: t.route_name ?? "No route",
        rostered: true,
        tripId: t.id,
        tripNumber: t.trip_number,
        generatedBy: t.generated_by,
        crew: crew.map((/** @type {any} */ c) => ({ profileId: c.profileId, name: c.name, role: c.role })),
        sellerName: t.seller_name,
        onPhone: on ? { profileId: on.profileId, name: on.name, role: on.role } : null,
        trip: { status: t.status, label: TRIP_LABELS[t.status] ?? t.status, stage: stageOf(t.status, settlement) },
        load: {
          state: loadStateOf(plan?.state),
          detail: plan?.state ?? "none",
          label: LOAD_LABELS[loadStateOf(plan?.state)],
          plannedLoadId: plan?.id ?? null,
          number: doc?.transfer_number ?? null,
          documentStatus: doc?.status ?? null,
          products: caseLines.length,
          totalBase: caseLines.reduce((/** @type {number} */ n, /** @type {any} */ l) => n + Number(l.q), 0),
          // Whole cases and loose pieces across the products, so the board can say "5 cs 2 pc".
          cases: caseLines.reduce((/** @type {number} */ n, /** @type {any} */ l) => n + (Number(l.case_base) > 1 ? Math.floor(Number(l.q) / Number(l.case_base)) : 0), 0),
          pieces: caseLines.reduce((/** @type {number} */ n, /** @type {any} */ l) => n + (Number(l.case_base) > 1 ? Number(l.q) % Number(l.case_base) : Number(l.q)), 0),
          attention: plan?.attention ?? [],
          source: plan?.source ?? null,
          agreement: plan?.agreement ?? null,
          differenceCentavos: Number(plan?.difference_value_centavos ?? 0),
        },
        cash: {
          expectedCentavos: Number(await cashExpectation(db, t.id)),
          salesCentavos: Number(sold.sales),
          remittedCentavos: remit ? Number(remit.amount_centavos) : null,
        },
        loadIn: loadIn
          ? { number: loadIn.transfer_number, status: loadIn.status, variance: loadIn.variance_status }
          : null,
        settlement: { status: settlement, label: settlement === "settled" ? "Settled" : settlement === "needs_review" ? "Needs settling" : "Not yet" },
      };
      rows.push({ ...row, primary: primaryAction(row) });
    }
    // Trucks that are on the roster for the day but have no trip yet.
    for (const r of rosters) {
      if (rows.some((x) => x.vehicleId === r.vehicle_id)) continue;
      const [s] = await db`select name from profiles where id=${r.seller_profile_id}`;
      const [rt] = r.route_id ? await db`select name from routes where id=${r.route_id}` : [];
      const row = {
        vehicleId: r.vehicle_id,
        rosterId: r.id,
        vehicleCode: r.vehicle_code,
        plateNumber: r.plate_number,
        routeName: rt?.name ?? "No route",
        rostered: true,
        tripId: null,
        tripNumber: null,
        generatedBy: null,
        crew: [],
        sellerName: s?.name ?? null,
        onPhone: null,
        trip: { status: "not_planned", label: TRIP_LABELS.not_planned, stage: "planned" },
        load: { state: "none", detail: "none", label: LOAD_LABELS.none, plannedLoadId: null, number: null, documentStatus: null, products: 0, totalBase: 0, cases: 0, pieces: 0, attention: [], source: null, agreement: null, differenceCentavos: 0 },
        cash: { expectedCentavos: 0, salesCentavos: 0, remittedCentavos: null },
        loadIn: null,
        settlement: { status: "open", label: "Not yet" },
      };
      rows.push({ ...row, primary: primaryAction(row) });
    }
    const needs = (/** @type {any} */ r) =>
      r.load.attention.length > 0 || r.load.detail === "disputed" || r.load.detail === "recount" || (r.trip.status === "not_planned");
    const stages = ["planned", "loaded", "on_route", "back", "settled", "closed"];
    const [run] =
      await db`select planned,already_planned,needs_attention,ran_at,trigger from van_nightly_runs where service_date=${day}::date order by ran_at desc limit 1`;
    return {
      date: day,
      asOf: Date.now(),
      summary: {
        trucks: rows.length,
        planned: rows.filter((r) => r.tripId).length,
        needAttention: rows.filter(needs).length,
        text: `${rows.filter((r) => r.tripId).length} trips planned, ${rows.filter(needs).length} need attention`,
        byStage: Object.fromEntries(stages.map((s) => [s, rows.filter((r) => r.trip.stage === s).length])),
        byLoad: Object.fromEntries(
          Object.keys(LOAD_LABELS).map((k) => [k, rows.filter((r) => r.load.state === k).length]),
        ),
        lastRun: run
          ? { at: new Date(run.ran_at).getTime(), trigger: run.trigger, planned: run.planned, alreadyPlanned: run.already_planned, needsAttention: run.needs_attention }
          : null,
      },
      rows: rows.map((r) => ({ ...r, needsAttention: needs(r) })),
    };
  });
}

/** GET van/loads/plan?tripId=: the suggested/approved load with the reason for each line, the document and the counts so far. @param {any} ctx */
export async function planDetail(ctx) {
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor);
    const trip = await tripFor(db, actor, uuid(ctx.url.searchParams.get("tripId")), "van.read");
    const plan = await planOf(db, trip.id);
    if (!plan) return { tripId: trip.id, plan: null };
    const lines = await db`select l.*,p.code,p.name from van_planned_load_lines l join products p on p.id=l.product_id where l.planned_load_id=${plan.id} order by (l.flags @> array['ship_first']) desc,p.code`;
    const [doc] = plan.stock_transfer_id
      ? await db`select id,transfer_number,status,variance_status,driver_name,vehicle_plate,receiver_name,dispatched_at from stock_transfers where id=${plan.stock_transfer_id}`
      : [];
    const counts = await db`select c.round,c.side,c.counted_at,c.lines,p.name as counted_by_name from van_load_counts c left join profiles p on p.id=c.profile_id where c.planned_load_id=${plan.id} order by c.round,c.side`;
    const sent = plan.stock_transfer_id
      ? await db`select a.product_id,a.lot_id,l.lot_number,l.expires_at,a.dispatched_base,a.reserved_base from stock_transfer_allocations a left join inventory_lots l on l.id=a.lot_id where a.transfer_id=${plan.stock_transfer_id} order by l.expires_at nulls last`
      : [];
    return {
      tripId: trip.id,
      tripNumber: trip.trip_number,
      plan: {
        id: plan.id,
        state: plan.state,
        label: LOAD_LABELS[loadStateOf(plan.state)],
        source: plan.source,
        attention: plan.attention,
        agreement: plan.agreement,
        clerkName: plan.clerk_name,
        sellerSignedAt: plan.seller_signed_at ? new Date(plan.seller_signed_at).getTime() : null,
        clerkSignedAt: plan.clerk_signed_at ? new Date(plan.clerk_signed_at).getTime() : null,
        differenceCentavos: Number(plan.difference_value_centavos),
      },
      document: doc
        ? {
            transferId: doc.id,
            number: doc.transfer_number,
            status: doc.status === "shipped" ? "dispatched" : doc.status,
            driverName: doc.driver_name,
            vehiclePlate: doc.vehicle_plate,
            receiverName: doc.receiver_name,
          }
        : null,
      lines: lines.map((/** @type {any} */ l) => ({
        productId: l.product_id,
        code: l.code,
        name: l.name,
        caseBase: Number(l.case_base),
        averageBase: Number(l.average_base),
        mustCarryBase: Number(l.must_carry_base),
        shipFirstBase: Number(l.ship_first_base),
        onTruckBase: Number(l.on_truck_base),
        depotAvailableBase: Number(l.depot_available_base),
        historyTrips: l.history_trips,
        suggestedBase: Number(l.suggested_base),
        approvedBase: l.approved_base === null ? null : Number(l.approved_base),
        loadBase: Number(l.approved_base ?? l.suggested_base),
        edited: l.edited,
        flags: l.flags,
        batches: sent
          .filter((/** @type {any} */ s) => s.product_id === l.product_id)
          .map((/** @type {any} */ s) => ({
            lotId: s.lot_id,
            lotNumber: s.lot_number,
            expiresAt: s.expires_at ? new Date(s.expires_at).getTime() : null,
            reservedBase: Number(s.reserved_base),
            dispatchedBase: Number(s.dispatched_base),
          })),
      })),
      counts: counts.map((/** @type {any} */ c) => ({
        round: c.round,
        side: c.side,
        at: new Date(c.counted_at).getTime(),
        by: c.counted_by_name,
        lines: c.lines.items,
      })),
    };
  });
}

/** GET van/loads/pick-list?tripId=: what the clerk picks, by product with the batches (earliest expiry first). @param {any} ctx */
export async function pickList(ctx) {
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor);
    const trip = await tripFor(db, actor, uuid(ctx.url.searchParams.get("tripId")), "van.read");
    const plan = await planOf(db, trip.id);
    if (!plan?.stock_transfer_id) refuse("This load has no pick list yet. Approve the load first");
    const [doc] =
      await db`select id,transfer_number,status,driver_name,vehicle_plate,receiver_name from stock_transfers where id=${plan.stock_transfer_id}`;
    const lines = await db`select l.id as "lineId",l.product_id,l.approved_base,l.picked_base,p.code,p.name,p.category from stock_transfer_lines l join products p on p.id=l.product_id where l.transfer_id=${doc.id} order by p.category nulls last,p.code`;
    const out = [];
    for (const l of lines) {
      const product = await productFor(db, l.product_id);
      const batches = await db`select a.lot_id,lt.lot_number,lt.expires_at,a.reserved_base,a.dispatched_base from stock_transfer_allocations a left join inventory_lots lt on lt.id=a.lot_id where a.transfer_line_id=${l.lineId} order by lt.expires_at nulls last`;
      out.push({
        lineId: l.lineId,
        productId: l.product_id,
        code: l.code,
        name: l.name,
        group: l.category ?? "Other",
        caseBase: Number(product.caseBase),
        approvedBase: Number(l.approved_base),
        pickedBase: Number(l.picked_base),
        batches: batches.map((/** @type {any} */ b) => ({
          lotId: b.lot_id,
          lotNumber: b.lot_number,
          expiresAt: b.expires_at ? new Date(b.expires_at).getTime() : null,
          baseQty: Number(b.reserved_base) || Number(b.dispatched_base),
        })),
      });
    }
    return {
      tripId: trip.id,
      tripNumber: trip.trip_number,
      number: doc.transfer_number,
      status: doc.status === "shipped" ? "dispatched" : doc.status,
      driverName: doc.driver_name,
      vehiclePlate: doc.vehicle_plate,
      receiverName: doc.receiver_name,
      lines: out,
    };
  });
}

/** What the handheld gets (opt-in `params.vanDay`). Old fields of the bundle are untouched; this is one more top-level object.
 * @param {any} db @param {any} actor @param {any} device @param {any} trip @param {string} serviceDate */
export async function vanDayBundle(db, actor, device, trip, serviceDate) {
  const vehicle = await vehicleOfDevice(db, device.id);
  const on = await personOnDevice(db, device.id);
  /** @type {any} */ let roster = null;
  const dayRosters = (await rostersOn(db, serviceDate, null)).filter(
    (/** @type {any} */ r) => r.seller_profile_id === actor.profileId || (vehicle && r.vehicle_id === vehicle.vehicleId),
  );
  if (dayRosters[0]) {
    const r = dayRosters[0];
    const names = async (/** @type {string|null} */ id) =>
      id ? ((await db`select name from profiles where id=${id}`)[0]?.name ?? null) : null;
    roster = {
      rosterId: r.id,
      vehicleCode: r.vehicle_code,
      plateNumber: r.plate_number,
      weekdays: r.weekdays,
      weekdayLabel: weekdayLabel(r.weekdays),
      seller: { profileId: r.seller_profile_id, name: await names(r.seller_profile_id) },
      helper: r.helper_profile_id ? { profileId: r.helper_profile_id, name: await names(r.helper_profile_id) } : null,
      driver: r.driver_profile_id ? { profileId: r.driver_profile_id, name: await names(r.driver_profile_id) } : null,
    };
  }
  const crew = trip ? await crewDirectory(db, trip.id) : [];
  const plan = trip ? await planOf(db, trip.id) : null;
  /** @type {any} */ let load = null;
  if (plan) {
    const lines = await db`select l.*,p.code,p.name from van_planned_load_lines l join products p on p.id=l.product_id where l.planned_load_id=${plan.id} order by (l.flags @> array['ship_first']) desc,p.code`;
    const [doc] = plan.stock_transfer_id
      ? await db`select transfer_number,status,driver_name,vehicle_plate,receiver_name from stock_transfers where id=${plan.stock_transfer_id}`
      : [];
    const sent = plan.stock_transfer_id
      ? await db`select a.product_id,a.lot_id,lt.lot_number,lt.expires_at,a.dispatched_base from stock_transfer_allocations a left join inventory_lots lt on lt.id=a.lot_id where a.transfer_id=${plan.stock_transfer_id} and a.dispatched_base>0 order by lt.expires_at nulls last`
      : [];
    const counted = plan.load_id
      ? await db`select product_id,lot_id,actual_base from van_trip_load_lines where load_id=${plan.load_id} and deleted_at is null`
      : [];
    load = {
      plannedLoadId: plan.id,
      loadId: plan.load_id,
      state: plan.state,
      label: LOAD_LABELS[loadStateOf(plan.state)],
      source: plan.source,
      document: doc
        ? { number: doc.transfer_number, status: doc.status === "shipped" ? "dispatched" : doc.status, driverName: doc.driver_name, vehiclePlate: doc.vehicle_plate, receiverName: doc.receiver_name }
        : null,
      clerkName: plan.clerk_name,
      canAccept: plan.state === "dispatched",
      waitingForClerk: plan.state === "recount",
      waitingForSupervisor: plan.state === "disputed",
      canStartTrip: plan.state === "accepted" && trip?.status === "loaded",
      agreement: plan.agreement,
      // What the clerk sent, by batch: the seller counts these.
      lines: sent.map((/** @type {any} */ s) => {
        const planLine = lines.find((/** @type {any} */ l) => l.product_id === s.product_id);
        const mine = counted.find((/** @type {any} */ c) => c.product_id === s.product_id && c.lot_id === s.lot_id);
        return {
          productId: s.product_id,
          productCode: planLine?.code ?? null,
          productName: planLine?.name ?? null,
          lotId: s.lot_id,
          lotNumber: s.lot_number,
          expiresAt: s.expires_at ? new Date(s.expires_at).getTime() : null,
          caseBase: Number(planLine?.case_base ?? 0),
          sentBase: String(s.dispatched_base),
          countedBase: mine?.actual_base == null ? null : String(mine.actual_base),
          shipFirst: Boolean(planLine?.flags?.includes("ship_first")),
        };
      }),
      // Before dispatch the phone only shows what is planned.
      planned: lines.map((/** @type {any} */ l) => ({
        productId: l.product_id,
        productCode: l.code,
        productName: l.name,
        caseBase: Number(l.case_base),
        suggestedBase: String(l.suggested_base),
        approvedBase: l.approved_base === null ? null : String(l.approved_base),
        flags: l.flags,
      })),
      differenceReasons: ["short_loaded", "over_loaded", "damaged_at_loading", "wrong_item", "other"],
    };
  }
  return {
    version: 1,
    device: { deviceId: device.id, vehicle },
    crew: {
      onDevice: on,
      members: crew.map((/** @type {any} */ c) => ({
        profileId: c.profileId,
        name: c.name,
        role: c.role,
        pinId: c.pinId ?? null,
        salt: c.salt ?? null,
        hash: c.hash ?? null,
      })),
      proof: "HMAC-SHA256(PBKDF2-SHA256(pin,salt,160000), \"crew|<deviceId>|<tripId>|<toProfileId>|<pinId>|<clientTime>\")",
    },
    roster,
    tripId: trip?.id ?? null,
    load,
  };
}

export { dayString };
